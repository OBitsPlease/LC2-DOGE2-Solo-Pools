'use strict';

const net = require('net');
const EventEmitter = require('events');
const { EXTRA_NONCE_1_LEN } = require('./coinbase-builder');

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
const SCRYPT_DIFF1         = 134217728; // 2^27

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

    socket.setEncoding('utf8');
    socket.on('data', data => this._onData(data));
    socket.on('close', () => this.emit('disconnect'));
    socket.on('error', err => this.emit('disconnect', err));
  }

  _onData(data) {
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

      // new_diff = current_diff * (actual_interval / target_interval)
      // If shares are coming too fast (actualInterval < target), raise diff
      // If shares are too slow (actualInterval > target), lower diff
      let newDiff = Math.round(this.currentDiff * (actualInterval / VARDIFF_TARGET_SECS));
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

    jobManager.on('newJob', (job, cleanJobs) => {
      this._broadcastJob(job, cleanJobs);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer(socket => this._onConnect(socket));
      this._server.on('error', reject);
      this._server.listen(this.config.stratumPort, '0.0.0.0', () => {
        console.log(`[${this.config.symbol}] Stratum server listening on port ${this.config.stratumPort}`);
        resolve();
      });
    });
  }

  stop() {
    if (this._server) this._server.close();
  }

  _onConnect(socket) {
    const id = ++this._clientId;
    const client = new StratumClient(socket, id);
    this.clients.set(id, client);
    console.log(`[${this.config.symbol}] Miner connected: ${socket.remoteAddress}:${socket.remotePort} (id=${id})`);

    client.on('message', msg => {
      if (process.env.STRATUM_DEBUG) console.log(`[${this.config.symbol}] >> ${JSON.stringify(msg)}`);
      this._handleMessage(client, msg);
    });
    client.on('disconnect', () => {
      this.clients.delete(id);
      console.log(`[${this.config.symbol}] Miner disconnected (id=${id}, worker=${client.workerName || 'unknown'})`);
    });
  }

  _handleMessage(client, msg) {
    const { id, method, params } = msg;

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
        // BIP310 — just acknowledge, we don't support extensions
        client.sendResult(id, {});
        break;
      case 'mining.suggest_difficulty':
      case 'mining.suggest_target':
        // Miner suggests a difficulty; we handle this via vardiff, just ack
        client.sendResult(id, true);
        break;
      default:
        console.log(`[${this.config.symbol}] Unknown method from ${client.workerName || 'miner'}: ${method}`);
        client.sendError(id, 20, `Unknown method: ${method}`);
    }
  }

  _handleSubscribe(client, id, params) {
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
    }
  }

  _handleAuthorize(client, id, params) {
    const workerName = params && params[0] ? params[0] : 'anonymous';
    client.workerName = workerName;
    client.authorized = true;
    client.sendResult(id, true);
    console.log(`[${this.config.symbol}] Worker authorized: ${workerName}`);

    // Resend difficulty + a fresh job after auth so the miner starts work
    client.sendDifficulty(client.currentDiff);
    const job = this.jobManager.currentJob;
    if (job) {
      client.sendNotify(this.jobManager.getNotifyParams(job, true));
    }
  }

  async _handleSubmit(client, id, params) {
    if (!client.authorized) {
      return client.sendError(id, 24, 'Unauthorized');
    }

    const [workerName, jobId, extraNonce2, ntime, nonce] = params;
    const result = this.jobManager.processShare(
      jobId, client.extraNonce1, extraNonce2, ntime, nonce, workerName, client.currentDiff
    );

    if (!result.valid) {
      if (result.error === 'Job not found') {
        // Stale share from a previous proxy run or job — silently accept to prevent miner error loops
        console.log(`[${this.config.symbol}] Stale share (old job) from ${workerName} — ignored`);
        return client.sendResult(id, true);
      }
      console.log(`[${this.config.symbol}] Invalid share from ${workerName}: ${result.error}`);
      return client.sendError(id, 20, result.error || 'Invalid share');
    }

    // Track share timestamp for per-miner hashrate
    const now = Date.now();
    client._shareTimes.push(now);
    client._shareTimes = client._shareTimes.filter(t => now - t < 60000);

    console.log(`[${this.config.symbol}] Share from ${workerName} — hash: ${result.hashHex ? result.hashHex.slice(0,12) : '?'}...`);

    if (result.meetsDifficulty) {
      console.log(`[${this.config.symbol}] *** BLOCK FOUND by ${workerName}! Submitting...`);
      try {
        const submitResult = await this.jobManager.rpc.submitBlock(result.blockHex);
        if (submitResult === null || submitResult === undefined) {
          console.log(`[${this.config.symbol}] *** BLOCK ACCEPTED! ***`);
          this.emit('blockFound', {
            workerName,
            coin: this.config.symbol,
            blockHex: result.blockHex,
            hashHex: result.hashHex || null,
            height: this.jobManager.currentJob?.height || null
          });
        } else {
          console.log(`[${this.config.symbol}] Block rejected: ${submitResult}`);
        }
      } catch (err) {
        console.error(`[${this.config.symbol}] submitblock error: ${err.message}`);
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
