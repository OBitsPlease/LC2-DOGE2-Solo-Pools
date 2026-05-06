'use strict';

const net = require('net');
const EventEmitter = require('events');
const { EXTRA_NONCE_1_LEN } = require('./coinbase-builder');
const { writeDiagnosticLog, getDiagnosticLogPath } = require('./diagnostic-logger');

let _extraNonce1Counter = (Math.floor(Date.now() / 1000) ^ 0xdeadbeef) >>> 0;

function nextExtraNonce1() {
  const val = _extraNonce1Counter++;
  const buf = Buffer.alloc(EXTRA_NONCE_1_LEN);
  buf.writeUInt32BE(val);
  return buf.toString('hex');
}

// ─── VarDiff constants ─────────────────────────────────────────────────────
const VARDIFF_TARGET_SECS  = 15;   // aim for 1 share every 15 seconds
const VARDIFF_RETARGET_MS  = 60000; // re-evaluate every 60 seconds
const VARDIFF_WINDOW_MS    = 120000; // look at shares from last 2 minutes
const VARDIFF_MIN_DIFF     = 1;
const VARDIFF_MAX_DIFF     = 2000000;
const SCRYPT_DIFF1         = 65536;     // 2^16 — matches the scrypt diff-1 reference (0x0000ffff...) used by ASIC firmware and pool standards
const MAX_TOTAL_CLIENTS    = 128;
const MAX_CLIENTS_PER_IP   = 24;
const UNAUTHORIZED_IDLE_MS = 45000;
const AUTHORIZED_IDLE_MS   = 300000;

// Round difficulty to a clean value to avoid noise (nearest power-of-2 up to 64, then multiples of 64)
function roundDiff(d) {
  if (d <= 1)    return 1;
  if (d <= 2)    return 2;
  if (d <= 4)    return 4;
  if (d <= 8)    return 8;
  if (d <= 16)   return 16;
  if (d <= 32)   return 32;
  if (d <= 64)   return 64;
  if (d <= 128)  return 128;
  if (d <= 256)  return 256;
  if (d <= 512)  return 512;
  if (d <= 1024) return 1024;
  // Above 1024: round to nearest 512
  return Math.round(d / 512) * 512 || 512;
}

class StratumClient extends EventEmitter {
  constructor(socket, id) {
    super();
    this.socket = socket;
    this.id = id;
    this.extraNonce1 = nextExtraNonce1();
    this.authorized = false;
    this.subscribed = false;
    this.workerName = null;
    this.currentDiff = 1;    // stratum difficulty currently sent to this client
    this._shareTimes = [];   // timestamps of accepted shares (60s window)
    this._vardiffTimer = null;
    this._buffer = '';
    this.lastActivity = Date.now();
    this.acceptedShares = 0;
    this.rejectedShares = 0;
    this.staleShares = 0;
    this.submitAttempts = 0;
    this._consecutiveStaleShares = 0;
    this.connectedAt = Date.now();

    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', data => this._onData(data));
    socket.on('close', () => this.emit('disconnect'));
    socket.on('error', err => this.emit('disconnect', err));
  }

  _onData(data) {
    this.lastActivity = Date.now();
    this._buffer += data;
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop(); // incomplete line stays in buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.emit('message', JSON.parse(trimmed));
      } catch {
        // ignore bad JSON
      }
    }
  }

  send(obj) {
    try {
      if (process.env.STRATUM_DEBUG) console.log(`[DBG <<] ${JSON.stringify(obj)}`);
      this.socket.write(JSON.stringify(obj) + '\n');
    } catch { /* socket closed */ }
  }

  sendResult(id, result, error = null) {
    this.send({ id, result, error });
  }

  sendError(id, code, message) {
    this.send({ id, result: null, error: [code, message, null] });
  }

  sendNotify(params) {
    this.send({ id: null, method: 'mining.notify', params });
  }

  sendDifficulty(diff) {
    this.send({ id: null, method: 'mining.set_difficulty', params: [diff] });
  }

  destroy() {
    if (this._vardiffTimer) { clearInterval(this._vardiffTimer); this._vardiffTimer = null; }
    try { this.socket.destroy(); } catch { /* ignore */ }
  }

  startVarDiff(onNewDiff) {
    this._vardiffTimer = setInterval(() => {
      const now = Date.now();
      // Trim window
      this._shareTimes = this._shareTimes.filter(t => now - t < VARDIFF_WINDOW_MS);
      if (this._shareTimes.length < 2) return; // not enough data yet

      const windowSecs = (now - this._shareTimes[0]) / 1000;
      const actualInterval = windowSecs / this._shareTimes.length; // secs per share

      // Only retarget if we're more than 20% off target
      if (actualInterval > VARDIFF_TARGET_SECS * 0.8 && actualInterval < VARDIFF_TARGET_SECS * 1.2) return;

      // new_diff = current_diff * (target_interval / actual_interval)
      // If shares are coming too fast (actualInterval < target), raise diff
      // If shares are too slow (actualInterval > target), lower diff
      let newDiff = Math.round(this.currentDiff * (VARDIFF_TARGET_SECS / actualInterval));
      newDiff = Math.max(VARDIFF_MIN_DIFF, Math.min(VARDIFF_MAX_DIFF, newDiff));

      // Round to a clean power-of-2-friendly number to avoid constant tiny adjustments
      newDiff = roundDiff(newDiff);

      if (newDiff !== this.currentDiff) {
        this.currentDiff = newDiff;
        onNewDiff(newDiff);
      }
    }, VARDIFF_RETARGET_MS);
  }
}

class StratumServer extends EventEmitter {
  constructor(jobManager, config) {
    super();
    this.jobManager = jobManager;
    this.config = config;
    this.clients = new Map();
    this._clientId = 0;
    this._server = null;
    this._maintenanceTimer = null;
    this._summaryTimer = null;
    this._peakClients = 0;
    this._acceptedShares = 0;
    this._rejectedShares = 0;
    this._staleShares = 0;
    this._submitAttempts = 0;
    this._notifySent = 0;
    this._methodCounts = {};
    this._altEndianPasses = 0;
    this._blocksFound = 0;
    this._rejectedByReason = {};
    this._lastRejectReason = null;

    jobManager.on('newJob', (job, cleanJobs) => {
      this._broadcastJob(job, cleanJobs);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer(socket => this._onConnect(socket));
      this._server.on('error', reject);
      this._server.listen(this.config.stratumPort, '0.0.0.0', () => {
        this._maintenanceTimer = setInterval(() => this._pruneIdleClients(), 15000);
        this._summaryTimer = setInterval(() => this._writeSummary(), 15000);
        console.log(`[${this.config.symbol}] Stratum server listening on port ${this.config.stratumPort}`);
        writeDiagnosticLog('stratum-start', {
          symbol: this.config.symbol,
          port: this.config.stratumPort,
          maxTotalClients: MAX_TOTAL_CLIENTS,
          maxClientsPerIp: MAX_CLIENTS_PER_IP,
          unauthorizedIdleMs: UNAUTHORIZED_IDLE_MS,
          authorizedIdleMs: AUTHORIZED_IDLE_MS,
          logPath: getDiagnosticLogPath()
        });
        resolve();
      });
    });
  }

  stop() {
    writeDiagnosticLog('stratum-stop', {
      symbol: this.config.symbol,
      connectedClients: this.clients.size,
      peakClients: this._peakClients,
      acceptedShares: this._acceptedShares,
      rejectedShares: this._rejectedShares,
      staleShares: this._staleShares,
      blocksFound: this._blocksFound
    });

    if (this._maintenanceTimer) {
      clearInterval(this._maintenanceTimer);
      this._maintenanceTimer = null;
    }
    if (this._summaryTimer) {
      clearInterval(this._summaryTimer);
      this._summaryTimer = null;
    }
    for (const [, c] of this.clients) c.destroy();
    this.clients.clear();
    if (this._server) this._server.close();
  }

  _writeSummary() {
    const authorized = [...this.clients.values()].filter(c => c.authorized).length;
    const rssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
    writeDiagnosticLog('stratum-summary', {
      symbol: this.config.symbol,
      connectedClients: this.clients.size,
      authorizedClients: authorized,
      peakClients: this._peakClients,
      acceptedShares: this._acceptedShares,
      rejectedShares: this._rejectedShares,
      rejectedByReason: this._rejectedByReason,
      lastRejectReason: this._lastRejectReason,
      staleShares: this._staleShares,
      submitAttempts: this._submitAttempts,
      notifySent: this._notifySent,
      methodCounts: this._methodCounts,
      altEndianPasses: this._altEndianPasses,
      blocksFound: this._blocksFound,
      rssMb
    });
  }

  _pruneIdleClients() {
    const now = Date.now();
    for (const [id, c] of this.clients) {
      const idleMs = now - (c.lastActivity || now);
      const limit = c.authorized ? AUTHORIZED_IDLE_MS : UNAUTHORIZED_IDLE_MS;
      if (idleMs > limit) {
        writeDiagnosticLog('client-pruned-idle', {
          symbol: this.config.symbol,
          clientId: id,
          remoteAddress: c.socket?.remoteAddress || 'unknown',
          workerName: c.workerName || null,
          idleMs,
          authorized: !!c.authorized
        });
        c.destroy();
        this.clients.delete(id);
      }
    }
  }

  _onConnect(socket) {
    if (this.clients.size >= MAX_TOTAL_CLIENTS) {
      try { socket.destroy(); } catch (_) {}
      console.warn(`[${this.config.symbol}] Connection refused: max total clients reached (${MAX_TOTAL_CLIENTS})`);
      writeDiagnosticLog('connection-refused-total-limit', {
        symbol: this.config.symbol,
        maxTotalClients: MAX_TOTAL_CLIENTS,
        connectedClients: this.clients.size,
        remoteAddress: socket.remoteAddress || 'unknown'
      });
      return;
    }

    const remoteIp = socket.remoteAddress || 'unknown';
    const sameIpCount = [...this.clients.values()].filter(c => c.socket?.remoteAddress === remoteIp).length;
    if (sameIpCount >= MAX_CLIENTS_PER_IP) {
      try { socket.destroy(); } catch (_) {}
      console.warn(`[${this.config.symbol}] Connection refused: too many clients from ${remoteIp} (${sameIpCount})`);
      writeDiagnosticLog('connection-refused-ip-limit', {
        symbol: this.config.symbol,
        remoteAddress: remoteIp,
        sameIpCount,
        maxClientsPerIp: MAX_CLIENTS_PER_IP
      });
      return;
    }

    const id = ++this._clientId;
    const client = new StratumClient(socket, id);
    this.clients.set(id, client);
    this._peakClients = Math.max(this._peakClients, this.clients.size);
    console.log(`[${this.config.symbol}] Miner connected: ${socket.remoteAddress}:${socket.remotePort} (id=${id})`);
    writeDiagnosticLog('client-connected', {
      symbol: this.config.symbol,
      clientId: id,
      remoteAddress: socket.remoteAddress || 'unknown',
      remotePort: socket.remotePort || null,
      connectedClients: this.clients.size,
      peakClients: this._peakClients
    });

    client.on('message', msg => {
      if (process.env.STRATUM_DEBUG) console.log(`[${this.config.symbol}] >> ${JSON.stringify(msg)}`);
      Promise.resolve(this._handleMessage(client, msg)).catch(err => {
        console.error(`[${this.config.symbol}] Stratum handler error: ${err.message}`);
      });
    });
    client.on('disconnect', () => {
      this.clients.delete(id);
      console.log(`[${this.config.symbol}] Miner disconnected (id=${id}, worker=${client.workerName || 'unknown'})`);
      writeDiagnosticLog('client-disconnected', {
        symbol: this.config.symbol,
        clientId: id,
        workerName: client.workerName || null,
        remoteAddress: socket.remoteAddress || 'unknown',
        connectedForSec: Math.max(0, Math.round((Date.now() - client.connectedAt) / 1000)),
        connectedClients: this.clients.size,
        acceptedShares: client.acceptedShares,
        rejectedShares: client.rejectedShares,
        staleShares: client.staleShares
      });
    });
  }

  _handleMessage(client, msg) {
    if (!msg || typeof msg !== 'object') {
      return;
    }

    const { id, method, params } = msg;

    if (!method || typeof method !== 'string') {
      client.sendError(id ?? null, 20, 'Invalid request: missing method');
      return;
    }

    switch (method) {
      case 'mining.subscribe':
        return this._handleSubscribe(client, id, params);
      case 'mining.authorize':
        return this._handleAuthorize(client, id, params);
      case 'mining.submit':
        return this._handleSubmit(client, id, params);
      case 'mining.extranonce.subscribe':
        client.sendResult(id, true);
        break;
      case 'mining.configure':
        this._methodCounts['mining.configure'] = (this._methodCounts['mining.configure'] || 0) + 1;
        writeDiagnosticLog('client-configure', {
          symbol: this.config.symbol,
          clientId: client.id,
          workerName: client.workerName,
          remoteAddress: client.socket?.remoteAddress || 'unknown',
          params: Array.isArray(params) ? params : null
        });
        // BIP310 — just acknowledge, we don't support extensions
        client.sendResult(id, {});
        break;
      case 'mining.suggest_difficulty':
      case 'mining.suggest_target':
        // Miner suggests a difficulty; we handle this via vardiff, just ack
        client.sendResult(id, true);
        break;
      default:
        this._methodCounts[method] = (this._methodCounts[method] || 0) + 1;
        console.log(`[${this.config.symbol}] Unknown method from ${client.workerName || 'miner'}: ${method}`);
        client.sendError(id, 20, `Unknown method: ${method}`);
    }
  }

  _handleSubscribe(client, id, params) {
    this._methodCounts['mining.subscribe'] = (this._methodCounts['mining.subscribe'] || 0) + 1;
    client.subscribed = true;
    const { EXTRA_NONCE_2_LEN } = require('./coinbase-builder');

    // If the miner requested session resumption, ignore it — always issue a fresh extraNonce1
    // (matching the old extraNonce1 would make cgminer think it resumed and skip clean restart)
    client.sendResult(id, [
      [
        ['mining.set_difficulty', client.extraNonce1],
        ['mining.notify', client.extraNonce1]
      ],
      client.extraNonce1,
      EXTRA_NONCE_2_LEN
    ]);

    // Set initial difficulty from config (default 1 if not set)
    const startDiff = this.config.difficulty || 1;
    client.currentDiff = startDiff;
    client.sendDifficulty(startDiff);

    // Start vardiff — whenever a new difficulty is calculated, send it + a new job
    client.startVarDiff((newDiff) => {
      client.sendDifficulty(newDiff);
      // Send a new job (cleanJobs=false so miner doesn't throw away current work)
      const job = this.jobManager.currentJob;
      if (job) client.sendNotify(this.jobManager.getNotifyParams(job, false));
      console.log(`[${this.config.symbol}] VarDiff ${client.workerName || 'miner'}: diff adjusted to ${newDiff}`);
    });

    // Send current job — cleanJobs=true so a fresh-connected miner starts immediately
    const job = this.jobManager.currentJob;
    if (job) {
      client.sendNotify(this.jobManager.getNotifyParams(job, true));
      this._notifySent++;
    }
  }

  _handleAuthorize(client, id, params) {
    this._methodCounts['mining.authorize'] = (this._methodCounts['mining.authorize'] || 0) + 1;
    if (!Array.isArray(params) || params.length < 1) {
      client.sendError(id, 20, 'Invalid authorize params');
      return;
    }

    const workerName = params && params[0] ? params[0] : 'anonymous';
    client.workerName = workerName;
    client.authorized = true;
    client.sendResult(id, true);

    console.log(`[${this.config.symbol}] Worker authorized: ${workerName}`);
    writeDiagnosticLog('client-authorized', {
      symbol: this.config.symbol,
      clientId: client.id,
      workerName,
      remoteAddress: client.socket?.remoteAddress || 'unknown',
      connectedClients: this.clients.size
    });

    // Resend difficulty + a fresh job after auth so the miner starts work
    client.sendDifficulty(client.currentDiff);
    const job = this.jobManager.currentJob;
    if (job) {
      client.sendNotify(this.jobManager.getNotifyParams(job, true));
      this._notifySent++;
    }
  }

  async _handleSubmit(client, id, params) {
    this._methodCounts['mining.submit'] = (this._methodCounts['mining.submit'] || 0) + 1;
    client.lastActivity = Date.now();
    client.submitAttempts = (client.submitAttempts || 0) + 1;
    this._submitAttempts++;
    if (!client.authorized) {
      return client.sendError(id, 24, 'Unauthorized');
    }

    if (!Array.isArray(params) || params.length < 5) {
      client.rejectedShares++;
      this._rejectedShares++;
      return client.sendError(id, 20, 'Invalid submit params');
    }

    const [workerName, jobId, extraNonce2, ntime, nonce, submittedVersion] = params;
    if (params.length > 5) {
      writeDiagnosticLog('submit-extra-params', {
        symbol: this.config.symbol,
        clientId: client.id,
        workerName,
        remoteAddress: client.socket?.remoteAddress || 'unknown',
        paramsLength: params.length,
        extraParams: params.slice(5)
      });
    }
    const result = this.jobManager.processShare(
      jobId, client.extraNonce1, extraNonce2, ntime, nonce, workerName, client.currentDiff, submittedVersion
    );

    if (!result.valid) {
      if (result.error === 'Job not found') {
        // Stale share from an old job: force miner resync with a clean job.
        console.log(`[${this.config.symbol}] Stale share (old job) from ${workerName} — forcing resync`);
        client._consecutiveStaleShares = (client._consecutiveStaleShares || 0) + 1;
        client.staleShares++;
        this._staleShares++;
        this._lastRejectReason = 'Stale share';
        const currentJob = this.jobManager.currentJob;
        if ((this._staleShares % 5) === 1) {
          const knownJobIds = [...this.jobManager.jobs.keys()].slice(-8);
          writeDiagnosticLog('stale-share-sample', {
            symbol: this.config.symbol,
            workerName,
            clientId: client.id,
            submittedJobId: jobId,
            currentJobId: currentJob?.id || null,
            knownJobIds,
            staleShares: this._staleShares,
            submitAttempts: this._submitAttempts
          });
        }
        if (currentJob && client.subscribed) {
          client.sendNotify(this.jobManager.getNotifyParams(currentJob, true));
        }
        client.sendError(id, 21, 'Stale share');

        // Some ASIC firmwares can get stuck replaying an old job forever.
        // Force a reconnect after repeated stale submissions to reset job state.
        if (client._consecutiveStaleShares >= 12) {
          console.log(`[${this.config.symbol}] Too many consecutive stale shares from ${workerName}; forcing reconnect`);
          client.destroy();
        }
        return;
      }
      client._consecutiveStaleShares = 0;
      client.rejectedShares++;
      this._rejectedShares++;
      if (result?.diag?.meetsShareDifficultyNoReverse) {
        this._altEndianPasses++;
      }
      const rejectReason = result.error || 'Invalid share';
      this._rejectedByReason[rejectReason] = (this._rejectedByReason[rejectReason] || 0) + 1;
      this._lastRejectReason = rejectReason;
      if (rejectReason === 'Low difficulty share' && (this._rejectedShares % 10 === 1)) {
        writeDiagnosticLog('low-diff-sample', {
          symbol: this.config.symbol,
          workerName,
          currentDiff: client.currentDiff || 1,
          jobId,
          extraNonce1: client.extraNonce1,
          extraNonce2,
          ntime,
          nonce,
          submittedVersion: submittedVersion || null,
          headerHex: result?.diag?.headerHex || null,
          runDeepDiagnostics: !!result?.diag?.runDeepDiagnostics,
          meetsShareDifficultyNoReverse: !!result?.diag?.meetsShareDifficultyNoReverse,
          variantPass: result?.diag?.variantPass || null,
          variantHashPrefix: result?.diag?.variantHashHex ? String(result.diag.variantHashHex).slice(0, 16) : null,
          closestVariant: result?.diag?.closestVariant || null,
          closestVariantHashPrefix: result?.diag?.closestVariantHashHex
            ? String(result.diag.closestVariantHashHex).slice(0, 16)
            : null
        });
      }
      console.log(`[${this.config.symbol}] Invalid share from ${workerName}: ${result.error}`);
      return client.sendError(id, 20, result.error || 'Invalid share');
    }

    client._consecutiveStaleShares = 0;

    client.acceptedShares++;
    this._acceptedShares++;

    // Track share timestamp for per-miner hashrate
    const now = Date.now();
    client._shareTimes.push(now);
    client._shareTimes = client._shareTimes.filter(t => now - t < 60000);

    console.log(`[${this.config.symbol}] Share from ${workerName} — hash: ${result.hashHex ? result.hashHex.slice(0,12) : '?'}...`);
    if (result?.diag?.compatAccepted) {
      writeDiagnosticLog('compat-share-accepted-runtime', {
        symbol: this.config.symbol,
        workerName,
        variant: result.diag.compatVariant || null,
        currentDiff: client.currentDiff || 1,
        jobId
      });
    }

    if (result.meetsDifficulty) {
      console.log(`[${this.config.symbol}] *** BLOCK FOUND by ${workerName}! Submitting...`);
      try {
        const submitResult = await this.jobManager.rpc.submitBlock(result.blockHex);
        if (submitResult === null || submitResult === undefined) {
          console.log(`[${this.config.symbol}] *** BLOCK ACCEPTED! ***`);
          this._blocksFound++;
          writeDiagnosticLog('block-found', {
            symbol: this.config.symbol,
            workerName,
            height: this.jobManager.currentJob?.height || null,
            connectedClients: this.clients.size
          });
          this.emit('blockFound', {
            workerName,
            coin: this.config.symbol,
            blockHex: result.blockHex,
            hashHex: result.hashHex || null,
            height: this.jobManager.currentJob?.height || null
          });
        } else {
          console.log(`[${this.config.symbol}] Block rejected: ${submitResult}`);
          writeDiagnosticLog('block-rejected', {
            symbol: this.config.symbol,
            workerName,
            height: this.jobManager.currentJob?.height || null,
            result: String(submitResult),
            connectedClients: this.clients.size,
            hashHex: result.hashHex || null
          });
        }
      } catch (err) {
        console.error(`[${this.config.symbol}] submitblock error: ${err.message}`);
        writeDiagnosticLog('block-submit-rpc-error', {
          symbol: this.config.symbol,
          workerName,
          height: this.jobManager.currentJob?.height || null,
          error: err.message,
          connectedClients: this.clients.size,
          hashHex: result.hashHex || null
        });
      }
    }

    client.sendResult(id, true);
  }

  _broadcastJob(job, cleanJobs) {
    const params = this.jobManager.getNotifyParams(job, cleanJobs);
    let count = 0;
    for (const [, client] of this.clients) {
      if (client.subscribed) {
        client.sendNotify(params);
        this._notifySent++;
        count++;
      }
    }
    if (count > 0) {
      console.log(`[${this.config.symbol}] Broadcast job ${job.id} to ${count} miner(s)`);
    }
  }

  getStats() {
    return {
      symbol: this.config.symbol,
      port: this.config.stratumPort,
      connectedMiners: this.clients.size,
      currentJobId: this.jobManager.currentJob?.id || null,
      currentHeight: this.jobManager.currentJob?.height || null
    };
  }

  getConnectedCount() {
    return this.clients.size;
  }

  getMiners() {
    const now = Date.now();
    const result = [];
    for (const [, c] of this.clients) {
      if (!c.authorized) continue;
      const recent = (c._shareTimes || []).filter(t => now - t < 60000);
      const hashrate = (recent.length * (c.currentDiff || 1) * SCRYPT_DIFF1) / 60;
      result.push({
        address:    c.workerName ? c.workerName.split('.')[0] : 'unknown',
        workerName: c.workerName || 'unknown',
        hashrate,
        currentDiff: c.currentDiff || 1,
        lastSeen:   recent.length > 0
          ? new Date(recent[recent.length - 1]).toISOString()
          : new Date().toISOString()
      });
    }
    return result;
  }
}

module.exports = StratumServer;
