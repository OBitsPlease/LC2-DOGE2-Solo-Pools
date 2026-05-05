'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

function getRuntimeRoot() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'LC2 DOGE2 Solo Miner');
  }
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'LC2 DOGE2 Solo Miner');
  }
  return path.resolve(__dirname, '..');
}

function readStartupSummary() {
  const candidates = [
    path.join(getRuntimeRoot(), 'data', 'startup-summary.json'),
    path.join(__dirname, '..', 'data', 'startup-summary.json')
  ];

  for (const filePath of candidates) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {}
  }

  return null;
}

function getSummaryPorts(summary) {
  const lc2 = summary?.coins?.find(coin => coin.key === 'lc2' && coin.started);
  return {
    stratumPort: Number(lc2?.stratumPort || 3333),
    dashboardPort: Number(summary?.dashboard?.port || 8081)
  };
}

function httpJson(host, port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathname, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`${pathname} returned HTTP ${res.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${pathname} returned invalid JSON: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error(`${pathname} timed out`)));
    req.on('error', reject);
  });
}

class StratumProbe {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.buffer = '';
    this.pending = new Map();
    this.notifyQueue = [];
    this.currentJob = null;
    this.extraNonce1 = null;
    this.extraNonce2Len = 0;
    this.requestId = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port }, () => resolve());
      this.socket.setEncoding('utf8');
      this.socket.on('data', chunk => this._onData(chunk));
      this.socket.on('error', reject);
      this.socket.on('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error('Stratum connection closed'));
        }
        this.pending.clear();
      });
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }

      if (msg.method === 'mining.notify' && Array.isArray(msg.params)) {
        this.currentJob = msg.params;
        this.notifyQueue.push(msg.params);
      }

      if (msg.id !== undefined && msg.id !== null) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
      }
    }
  }

  send(method, params) {
    const id = ++this.requestId;
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(payload, err => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async subscribe() {
    const msg = await this.send('mining.subscribe', ['dev-self-test']);
    if (!Array.isArray(msg.result) || msg.result.length < 3) {
      throw new Error('Unexpected subscribe result');
    }

    this.extraNonce1 = String(msg.result[1] || '');
    this.extraNonce2Len = Number(msg.result[2] || 0);
    if (!this.extraNonce1 || !this.extraNonce2Len) {
      throw new Error('Missing extranonce details from subscribe response');
    }
  }

  async authorize(workerName) {
    const msg = await this.send('mining.authorize', [workerName, 'x']);
    if (msg.result !== true) {
      throw new Error('Authorize was rejected');
    }
  }

  async waitForJob(timeoutMs = 5000) {
    if (this.currentJob) return this.currentJob;

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.notifyQueue.length > 0) {
        return this.notifyQueue.shift();
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    throw new Error('Did not receive mining.notify job in time');
  }

  async submit(workerName, extraNonce2, ntime, nonce) {
    const job = this.currentJob;
    if (!job) throw new Error('No current job available');
    const jobId = job[0];
    return this.send('mining.submit', [workerName, jobId, extraNonce2, ntime, nonce]);
  }
}

async function main() {
  const summary = readStartupSummary();
  const { stratumPort, dashboardPort } = getSummaryPorts(summary);
  const host = '127.0.0.1';
  const workerName = 'dev-self-test.worker';

  console.log(`Self-test target: stratum ${host}:${stratumPort}, dashboard ${host}:${dashboardPort}`);

  const poolsMeta = await httpJson(host, dashboardPort, '/dashboard/pools-meta');
  if (!Array.isArray(poolsMeta) || poolsMeta.length === 0) {
    throw new Error('Dashboard pools metadata is empty');
  }
  console.log('PASS dashboard/pools-meta');

  await httpJson(host, dashboardPort, '/api/pools/lc2_solo1');
  await httpJson(host, dashboardPort, '/api/pools/doge2_solo1');
  console.log('PASS dashboard live pool APIs');

  const probe = new StratumProbe(host, stratumPort);
  try {
    await probe.connect();
    console.log('PASS stratum TCP connect');

    await probe.subscribe();
    console.log(`PASS mining.subscribe extranonce1=${probe.extraNonce1} extranonce2Len=${probe.extraNonce2Len}`);

    await probe.authorize(workerName);
    console.log('PASS mining.authorize');

    const job = await probe.waitForJob();
    const ntime = String(job[7]);
    if (!ntime || !/^[0-9a-fA-F]{8}$/.test(ntime)) {
      throw new Error('Received invalid ntime in mining.notify');
    }
    console.log(`PASS mining.notify job=${job[0]}`);

    const extraNonce2 = '0'.repeat(probe.extraNonce2Len * 2);
    const invalidReply = await probe.submit(workerName, extraNonce2, ntime, '00000000');
    const invalidRejected = Array.isArray(invalidReply.error)
      && invalidReply.error[1] === 'Low difficulty share';

    if (!invalidRejected) {
      throw new Error(`Expected low-difficulty share rejection, got ${JSON.stringify(invalidReply)}`);
    }
    console.log('PASS low-difficulty share rejected');
  } finally {
    probe.close();
  }

  console.log('Self-test passed.');
}

main().catch(err => {
  console.error(`Self-test failed: ${err.message}`);
  process.exit(1);
});