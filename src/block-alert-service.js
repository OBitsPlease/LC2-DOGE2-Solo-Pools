'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_NOTIFY_ON = ['accepted', 'confirmed', 'orphaned', 'rejected', 'rpc-error', 'resubmitted'];
const MAX_STATE_KEYS = 1000;
const LOG_TAIL_BYTES = 64 * 1024;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 100);
}

function readTail(filePath, maxBytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (_) {
      reject(new Error('Discord webhook URL is invalid'));
      return;
    }

    const isLocalHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !isLocalHttp) {
      reject(new Error('Discord webhook must use HTTPS'));
      return;
    }

    const body = Buffer.from(JSON.stringify(payload));
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'User-Agent': 'LC2-DOGE2-Solo-Miner-Block-Alerts'
      },
      timeout: 10000
    }, response => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.statusCode);
        } else {
          reject(new Error(`Discord returned HTTP ${response.statusCode}`));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Discord request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

class BlockAlertService {
  constructor({ dataDir }) {
    if (!dataDir) throw new Error('dataDir is required');

    this.dataDir = dataDir;
    this.runtimeRoot = path.dirname(dataDir);
    this.logsDir = path.join(this.runtimeRoot, 'logs');
    this.incidentsDir = path.join(this.runtimeRoot, 'alerts', 'incidents');
    this.configPath = path.join(dataDir, 'discord-alerts.json');
    this.statePath = path.join(dataDir, 'block-alert-state.json');
    this.serviceLogPath = path.join(this.logsDir, 'block-alert-service.log');
  }

  _log(message) {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      fs.appendFileSync(this.serviceLogPath, `[${new Date().toISOString()}] ${message}\n`);
    } catch (_) {}
  }

  _readConfig() {
    const config = readJson(this.configPath, {});
    return {
      enabled: config.enabled === true,
      webhookUrl: typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : '',
      mention: typeof config.mention === 'string' ? config.mention.trim() : '',
      notifyOn: Array.isArray(config.notifyOn) ? config.notifyOn.map(String) : DEFAULT_NOTIFY_ON
    };
  }

  _eventKey(eventType, details) {
    const blockKey = details.id || `${details.poolId || 'lc2_solo1'}:${details.height || 0}:${details.hash || details.created || 'unknown'}`;
    const attempt = details.resubmitAttempts || details.attempt || 0;
    return `${eventType}:${blockKey}:${attempt}`;
  }

  _claimEvent(eventKey) {
    const state = readJson(this.statePath, { sent: [] });
    const sent = Array.isArray(state.sent) ? state.sent : [];
    if (sent.includes(eventKey)) return false;

    sent.push(eventKey);
    if (sent.length > MAX_STATE_KEYS) sent.splice(0, sent.length - MAX_STATE_KEYS);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify({ sent, updatedAt: new Date().toISOString() }, null, 2));
    return true;
  }

  _writeIncident(eventType, details) {
    const observedAt = new Date().toISOString();
    const blocks = readJson(path.join(this.dataDir, 'blocks.json'), []);
    const recentLc2Blocks = Array.isArray(blocks)
      ? blocks.filter(block => block.poolId === 'lc2_solo1').slice(-10).map(block => {
          const copy = { ...block };
          delete copy.blockHex;
          return copy;
        })
      : [];

    const incident = {
      eventType,
      observedAt,
      details,
      runtime: {
        startupSummary: readJson(path.join(this.dataDir, 'startup-summary.json'), null),
        recentLc2Blocks,
        diagnosticLogTail: readTail(path.join(this.logsDir, 'multi-asic-diagnostic.log')),
        proxyOutputTail: readTail(path.join(this.logsDir, 'proxy-out.log')),
        proxyErrorTail: readTail(path.join(this.logsDir, 'proxy-err.log')),
        orphanEventTail: readTail(path.join(this.logsDir, 'orphan-events.log'))
      }
    };

    fs.mkdirSync(this.incidentsDir, { recursive: true });
    const fileName = [
      observedAt.replace(/[:.]/g, '-'),
      'lc2',
      `height-${safeFilePart(details.height || 0)}`,
      safeFilePart(eventType)
    ].join('-') + '.json';
    const incidentPath = path.join(this.incidentsDir, fileName);
    fs.writeFileSync(incidentPath, JSON.stringify(incident, null, 2));
    return incidentPath;
  }

  _discordPayload(eventType, details, incidentPath, mention) {
    const styles = {
      accepted: { title: 'LC2 BLOCK FOUND - NODE ACCEPTED', color: 0xf1c40f },
      confirmed: { title: 'LC2 BLOCK CONFIRMED ON CHAIN', color: 0x2ecc71 },
      orphaned: { title: 'LC2 BLOCK ORPHANED', color: 0xe74c3c },
      rejected: { title: 'LC2 BLOCK REJECTED', color: 0xe74c3c },
      'rpc-error': { title: 'LC2 BLOCK SUBMISSION RPC ERROR', color: 0x9b59b6 },
      resubmitted: { title: 'LC2 BLOCK RESUBMITTED', color: 0x3498db }
    };
    const style = styles[eventType] || { title: `LC2 BLOCK EVENT: ${eventType}`, color: 0x95a5a6 };
    const fields = [
      { name: 'Height', value: String(details.height || 'unknown'), inline: true },
      { name: 'Worker', value: truncate(details.worker || details.workerName || 'unknown', 1024), inline: true },
      { name: 'Status', value: String(details.status || eventType), inline: true },
      { name: 'Hash', value: truncate(details.hash || details.hashHex || 'not recorded', 1024), inline: false }
    ];

    if (details.confirmations !== undefined && details.confirmations !== null) {
      fields.push({ name: 'Confirmations', value: String(details.confirmations), inline: true });
    }
    if (details.reason || details.result || details.error) {
      fields.push({
        name: 'Result',
        value: truncate(details.reason || details.result || details.error, 1024),
        inline: false
      });
    }

    return {
      content: mention || undefined,
      allowed_mentions: { parse: mention ? ['users', 'roles'] : [] },
      embeds: [{
        title: style.title,
        color: style.color,
        fields,
        footer: { text: truncate(`Evidence saved: ${incidentPath}`, 2048) },
        timestamp: new Date().toISOString()
      }]
    };
  }

  async report(eventType, details = {}) {
    const eventKey = this._eventKey(eventType, details);
    if (!this._claimEvent(eventKey)) {
      return { duplicate: true, sent: false, incidentPath: null };
    }

    const incidentPath = this._writeIncident(eventType, details);
    this._log(`Captured event=${eventType} height=${details.height || 0} incident=${incidentPath}`);

    const config = this._readConfig();
    if (!config.enabled || !config.webhookUrl || !config.notifyOn.includes(eventType)) {
      return { duplicate: false, sent: false, incidentPath };
    }

    try {
      const payload = this._discordPayload(eventType, details, incidentPath, config.mention);
      const statusCode = await postJson(config.webhookUrl, payload);
      this._log(`Discord sent event=${eventType} height=${details.height || 0} status=${statusCode}`);
      return { duplicate: false, sent: true, statusCode, incidentPath };
    } catch (error) {
      this._log(`Discord failed event=${eventType} height=${details.height || 0} error=${error.message}`);
      return { duplicate: false, sent: false, error: error.message, incidentPath };
    }
  }
}

module.exports = { BlockAlertService, postJson };
