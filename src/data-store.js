'use strict';
const fs   = require('fs');
const path = require('path');

function getProjectRoot() {
  if (process.pkg) {
    // dist/lc2-solo-proxy-windows.exe -> project root is one level up from dist
    return path.resolve(path.dirname(process.execPath), '..');
  }
  return path.join(__dirname, '..');
}

function getRuntimeRoot() {
  if (process.pkg) {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (base) return path.join(base, 'LC2 DOGE2 Solo Miner');
  }
  return getProjectRoot();
}

const DATA_DIR = path.join(getRuntimeRoot(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) { return path.join(DATA_DIR, name + '.json'); }

function read(name, def) {
  try { return JSON.parse(fs.readFileSync(filePath(name), 'utf8')); }
  catch (_) { return typeof def === 'function' ? def() : def; }
}

function write(name, data) {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
}

// ─── Blocks ────────────────────────────────────────────────────────────────
// Each block: { poolId, height, hash, reward, effort, miner, worker, status, confirmationProgress, created }

function getBlocks(poolId, { page = 0, pageSize = 15, state = null } = {}) {
  const all = read('blocks', []).filter(b => b.poolId === poolId);
  const filtered = state ? all.filter(b => (b.status || '').toLowerCase() === state) : all;
  const sorted = filtered.slice().sort((a, b) => new Date(b.created) - new Date(a.created));
  return sorted.slice(page * pageSize, (page + 1) * pageSize);
}

function addBlock(block) {
  const blocks = read('blocks', []);
  blocks.push({
    ...block,
    id: block.id || `${block.poolId || 'pool'}:${block.height || 0}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`,
    created: block.created || new Date().toISOString(),
    resubmitAttempts: block.resubmitAttempts || 0
  });
  write('blocks', blocks);
}

function getPendingBlocks(poolId = null) {
  const all = read('blocks', []);
  return all.filter(b => {
    if (poolId && b.poolId !== poolId) return false;
    const st = (b.status || '').toLowerCase();
    return st === 'pending' || st === 'orphaned';
  });
}

function updateBlockRecord(poolId, height, created, updates) {
  const blocks = read('blocks', []);
  const b = blocks.find(x =>
    x.poolId === poolId &&
    x.height === height &&
    String(x.created || '') === String(created || '')
  );
  if (b) {
    Object.assign(b, updates || {}, { updated: new Date().toISOString() });
    write('blocks', blocks);
    return b;
  }
  return null;
}

function updateBlockStatus(poolId, height, status, confirmationProgress) {
  const blocks = read('blocks', []);
  const b = blocks.find(b => b.poolId === poolId && b.height === height);
  if (b) {
    b.status = status;
    if (confirmationProgress != null) b.confirmationProgress = confirmationProgress;
    write('blocks', blocks);
  }
}

function getBlockWorkers(poolId, heights) {
  const blocks = read('blocks', []);
  const result = {};
  for (const h of heights) {
    const b = blocks.find(b => b.poolId === poolId && (b.height === h || b.blockHeight === h));
    if (b) result[h] = b.worker || b.miner || '–';
  }
  return result;
}

function countBlocks(poolId) {
  return read('blocks', []).filter(b => b.poolId === poolId).length;
}

function pendingRewards(poolId) {
  const blocks = read('blocks', []).filter(
    b => b.poolId === poolId && (b.status || 'pending') === 'pending'
  );
  return {
    count: blocks.length,
    total: blocks.reduce((s, b) => s + (b.reward || 0), 0)
  };
}

// ─── Payments ─────────────────────────────────────────────────────────────
// Each payment: { poolId, address, amount, transactionConfirmationData, created }

function getPayments(poolId, { page = 0, pageSize = 10 } = {}) {
  const all = read('payments', []).filter(p => p.poolId === poolId);
  const sorted = all.slice().sort((a, b) => new Date(b.created) - new Date(a.created));
  return sorted.slice(page * pageSize, (page + 1) * pageSize);
}

function addPayment(payment) {
  const payments = read('payments', []);
  payments.push({ ...payment, created: payment.created || new Date().toISOString() });
  write('payments', payments);
}

function totalPaid(poolId) {
  return read('payments', [])
    .filter(p => p.poolId === poolId)
    .reduce((s, p) => s + (p.amount || 0), 0);
}

// ─── Performance snapshots ─────────────────────────────────────────────────
// Stored as circular array, one snapshot per minute, kept 48h = 2880 samples max
const MAX_PERF_SAMPLES = 2880;

// snapshot: { poolId, hashrate, networkHashrate, difficulty, workers, created }
// workers: { [workerName]: { hashrate } }
function addPerfSnapshot(snap) {
  const key = 'perf_' + snap.poolId;
  const arr = read(key, []);
  arr.push({ ...snap, created: snap.created || new Date().toISOString() });
  if (arr.length > MAX_PERF_SAMPLES) arr.splice(0, arr.length - MAX_PERF_SAMPLES);
  write(key, arr);
}

function getPerfSnapshots(poolId, { range = 'Day', interval = 'Hour' } = {}) {
  const arr = read('perf_' + poolId, []);
  if (!arr.length) return [];

  // Filter to time range
  const now = Date.now();
  const rangeMs = range === 'Day' ? 86400000 : range === 'Hour' ? 3600000 : 86400000 * 7;
  const since = now - rangeMs;
  const filtered = arr.filter(s => new Date(s.created).getTime() >= since);

  // Downsample to interval
  const intervalMs = interval === 'Hour' ? 3600000 : interval === 'Minute' ? 60000 : 3600000;
  const buckets = new Map();
  for (const s of filtered) {
    const bucket = Math.floor(new Date(s.created).getTime() / intervalMs) * intervalMs;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(s);
  }

  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ts, samples]) => {
    const avgHashrate = samples.reduce((s, x) => s + (x.hashrate || 0), 0) / samples.length;
    const workers = {};
    // Merge worker maps
    for (const s of samples) {
      for (const [w, d] of Object.entries(s.workers || {})) {
        if (!workers[w]) workers[w] = { hashrate: 0, count: 0 };
        workers[w].hashrate += d.hashrate || 0;
        workers[w].count++;
      }
    }
    for (const w of Object.keys(workers)) {
      workers[w].hashrate = workers[w].hashrate / workers[w].count;
      delete workers[w].count;
    }
    return { created: new Date(ts).toISOString(), hashrate: avgHashrate, workers };
  });
}

function getMinerPerfSnapshots(poolId, miner, { mode = 'Day' } = {}) {
  const arr = read('perf_' + poolId, []);
  const rangeMs = mode === 'Day' ? 86400000 : 3600000 * 24 * 7;
  const since = Date.now() - rangeMs;
  const filtered = arr.filter(s => new Date(s.created).getTime() >= since);
  // Return per-worker breakdown for this miner's address
  return filtered.map(s => ({
    created: s.created,
    hashrate: s.hashrate,
    workers: s.workers || {}
  }));
}

// ─── Shares (live stream ring buffer) ─────────────────────────────────────
const MAX_SHARES = 2000;

function addShare(share) {
  const arr = read('shares', []);
  arr.push({ ...share, created: share.created || new Date().toISOString() });
  if (arr.length > MAX_SHARES) arr.splice(0, arr.length - MAX_SHARES);
  write('shares', arr);
}

function getSharesSince(poolId, sinceMs) {
  const arr = read('shares', []);
  return arr.filter(s => s.poolId === poolId && new Date(s.created).getTime() > sinceMs);
}

function getSharesRate(poolId, windowSecs = 60) {
  const arr = read('shares', []);
  const since = Date.now() - windowSecs * 1000;
  const recent = arr.filter(s => s.poolId === poolId && new Date(s.created).getTime() > since);
  return recent.length / windowSecs;
}

// ─── Pool config (min payment, etc.) ──────────────────────────────────────
function getPoolConfig(poolId) {
  const cfg = read('pool_config', {});
  return cfg[poolId] || { minimumPayment: 0.01 };
}

function setPoolConfig(poolId, updates) {
  const cfg = read('pool_config', {});
  cfg[poolId] = { ...(cfg[poolId] || {}), ...updates };
  write('pool_config', cfg);
  return cfg[poolId];
}

// ─── Miner settings ────────────────────────────────────────────────────────
function getMinerSettings(poolId, address) {
  const all = read('miner_settings', {});
  return (all[poolId] || {})[address] || { paymentThreshold: 0.01 };
}

function setMinerThreshold(poolId, address, threshold) {
  const all = read('miner_settings', {});
  if (!all[poolId]) all[poolId] = {};
  all[poolId][address] = { ...(all[poolId][address] || {}), paymentThreshold: threshold };
  write('miner_settings', all);
  return all[poolId][address];
}

// ─── Worker labels ─────────────────────────────────────────────────────────
// Each entry: { name, label, note, created, updated }
// Worker names are display labels only — payout addresses are configured
// globally per-coin (auto-fetched from local wallet at startup).

function getWorkers() {
  return read('workers', []);
}

function getWorker(name) {
  return read('workers', []).find(w => w.name === name) || null;
}

function upsertWorker(worker) {
  const workers = read('workers', []);
  const idx = workers.findIndex(w => w.name === worker.name);
  if (idx >= 0) {
    workers[idx] = { ...workers[idx], ...worker, updated: new Date().toISOString() };
  } else {
    workers.push({ ...worker, created: new Date().toISOString() });
  }
  write('workers', workers);
  return getWorker(worker.name);
}

function deleteWorker(name) {
  const workers = read('workers', []).filter(w => w.name !== name);
  write('workers', workers);
}

module.exports = {
  getDataDir: () => DATA_DIR,
  getBlocks, addBlock, updateBlockStatus, getBlockWorkers, countBlocks, pendingRewards,
  getPendingBlocks, updateBlockRecord,
  getPayments, addPayment, totalPaid,
  addPerfSnapshot, getPerfSnapshots, getMinerPerfSnapshots,
  addShare, getSharesSince, getSharesRate,
  getPoolConfig, setPoolConfig,
  getMinerSettings, setMinerThreshold,
  getWorkers, getWorker, upsertWorker, deleteWorker
};
