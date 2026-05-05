'use strict';
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const ds            = require('./data-store');
const config        = require('./config');
const updateChecker = require('./update-checker');

function getRuntimeRoot() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'LC2 DOGE2 Solo Miner');
  }
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'LC2 DOGE2 Solo Miner');
  }
  return path.resolve(__dirname, '..');
}

function getStopAllRequestPath() {
  return path.join(getRuntimeRoot(), 'data', 'stop-all-request.json');
}

function resolveAppVersion() {
  const fromEnv = (process.env.APP_VERSION || process.env.npm_package_version || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const summaryPath = path.join(ds.getDataDir(), 'startup-summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const fromSummary = (summary?.appVersion || '').trim();
    if (fromSummary) return fromSummary;
  } catch (_) {
    // Ignore missing/corrupt summary and continue to other sources.
  }

  const fromConfig = (config.appVersion || '').trim();
  if (fromConfig) return fromConfig;

  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const fromPkg = (pkg?.version || '').trim();
    if (fromPkg) return fromPkg;
  } catch (_) {
    // Keep dashboard available even if package metadata is missing.
  }

  return 'unknown';
}

// ─── Pool metadata (what /dashboard/pools-meta returns) ────────────────────
function buildPoolsMeta() {
  return Object.entries(config.coins)
    .filter(([, c]) => c.enabled)
    .map(([id, c]) => ({
      id:          `${id}_solo1`,
      coinId:      id,
      symbol:      c.symbol,
      name:        c.name || c.symbol,
      color:       c.color || '#f7931a',
      logo:        c.logo  || null,
      hashUnit:    'KH/s',
      blockReward: c.blockReward || 0,
      blockRewardNote: c.blockRewardNote || '',
      stratumPort: c.stratumPort,
      algorithm:   'Scrypt',
      devFee:      1
    }));
}

function getCoinForPool(poolId) {
  // poolId looks like "lc2_solo1"
  const coinId = poolId.replace(/_solo\d+$/, '');
  return { coinId, coin: config.coins[coinId] };
}

// ─── JSON response helpers ─────────────────────────────────────────────────
function jsonOk(res, data) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
}

function jsonErr(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: msg }));
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

// ─── Route handlers ────────────────────────────────────────────────────────
const routes = new Map(); // key: "METHOD /path/pattern"

function route(method, pattern, fn) {
  routes.set(`${method} ${pattern}`, fn);
}

function matchRoute(method, url) {
  const [pathname, qs] = url.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [key, fn] of routes) {
    const [m, p] = key.split(' ');
    if (m !== method) continue;
    if (p === pathname) return { fn, routeParams: {}, queryParams: params };
    // Pattern matching for :param
    const reParts = p.split('/').map(s => s.startsWith(':') ? '([^/]+)' : s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'));
    const re = new RegExp('^' + reParts.join('/') + '$');
    const m2 = pathname.match(re);
    if (m2) {
      const names = p.split('/').filter(s => s.startsWith(':')).map(s => s.slice(1));
      const routeParams = Object.fromEntries(names.map((n, i) => [n, m2[i + 1]]));
      return { fn, routeParams, queryParams: params };
    }
  }
  return null;
}

// ─── API: pool stats ────────────────────────────────────────────────────────
// These are injected by index.js when managers start up
const managers = {}; // coinId → { jobManager, stratumServer }
function registerManager(coinId, jobManager, stratumServer) {
  managers[coinId] = { jobManager, stratumServer };
}

function getLivePoolStats(poolId) {
  const { coinId, coin } = getCoinForPool(poolId);
  if (!coin || !coin.enabled) return null;
  const mgr = managers[coinId];
  const parentMgr = coin?.mergedParent ? managers[coin.mergedParent] : null;
  const poolHashrate = mgr?.jobManager?.getPoolHashrate?.() || 0;
  const connectedMiners = (mgr?.stratumServer?.getConnectedCount?.() || 0)
    || (parentMgr?.stratumServer?.getConnectedCount?.() || 0);
  const validSharesPerSecond = ds.getSharesRate(poolId);
  const jobInfo = mgr?.jobManager?.currentJob || {};
  const netInfo = mgr?.jobManager?._networkInfo || {};
  const networkDifficulty = jobInfo.difficulty || netInfo.networkDifficulty || 0;
  const poolEffort = ds.getRoundEffort(poolId, networkDifficulty);
  return {
    pool: {
      id: poolId,
      coin: { type: coin.symbol, algorithm: 'Scrypt' },
      address: coin.miningAddress,
      poolStats: {
        poolHashrate,
        connectedMiners,
        validSharesPerSecond
      },
      networkStats: {
        networkHashrate:    jobInfo.networkHashrate   || netInfo.networkHashrate || 0,
        blockHeight:        jobInfo.height            || netInfo.blockHeight || 0,
        networkDifficulty,
        connectedPeers:     jobInfo.connectedPeers    || netInfo.connectedPeers || 0,
        headers:            netInfo.headers || 0,
        verificationProgress: typeof netInfo.verificationProgress === 'number' ? netInfo.verificationProgress : 0,
        initialBlockDownload: !!netInfo.initialBlockDownload,
        blocksBehind:        Number.isFinite(netInfo.blocksBehind) ? netInfo.blocksBehind : 0
      },
      totalBlocks:      ds.countBlocks(poolId),
      totalPaid:        ds.totalPaid(poolId),
      blockReward:      coin.blockReward || 0,
      blockRewardNote:  coin.blockRewardNote || '',
      lastPoolBlockTime: null,
      poolEffort,
      poolFeePercent:   1,
      paymentProcessing: {
        minimumPayment: ds.getPoolConfig(poolId).minimumPayment
      }
    }
  };
}

// ─── Register all routes ───────────────────────────────────────────────────
route('GET', '/dashboard/pools-meta', (req, res, rp, qp) => {
  jsonOk(res, buildPoolsMeta());
});

route('GET', '/api/pools/:poolId', (req, res, rp, qp) => {
  const data = getLivePoolStats(rp.poolId);
  if (!data) return jsonErr(res, 404, 'Pool not found');
  jsonOk(res, data);
});

route('GET', '/api/pools/:poolId/performance', (req, res, rp, qp) => {
  const samples = ds.getPerfSnapshots(rp.poolId, { range: qp.r, interval: qp.i });
  jsonOk(res, samples);
});

route('GET', '/api/pools/:poolId/miners', (req, res, rp, qp) => {
  const { coinId, coin } = getCoinForPool(rp.poolId);
  let mgr = managers[coinId];
  let clients = mgr?.stratumServer?.getMiners?.() || [];

  // For merge-mined aux chains, show parent chain's miners
  if (clients.length === 0 && coin?.mergedParent) {
    const parentMgr = managers[coin.mergedParent];
    clients = parentMgr?.stratumServer?.getMiners?.() || [];
  }

  const miners = clients.map(c => ({
    miner: c.address,
    workerName: c.workerName,
    hashrate: c.hashrate || 0,
    sharesPerSecond: ds.getSharesRate(rp.poolId),
    lastSeen: c.lastSeen || new Date().toISOString()
  }));
  jsonOk(res, miners);
});

route('GET', '/api/pools/:poolId/miners/:address/performance', (req, res, rp, qp) => {
  const samples = ds.getMinerPerfSnapshots(rp.poolId, rp.address, { mode: qp.mode });
  jsonOk(res, samples);
});

route('GET', '/api/pools/:poolId/miners/:address/settings', (req, res, rp, qp) => {
  jsonOk(res, ds.getMinerSettings(rp.poolId, rp.address));
});

route('GET', '/api/pools/:poolId/blocks', (req, res, rp, qp) => {
  const blocks = ds.getBlocks(rp.poolId, {
    page:     parseInt(qp.page     || '0'),
    pageSize: parseInt(qp.pageSize || '15'),
    state:    qp.state || null
  });
  jsonOk(res, blocks);
});

route('GET', '/api/pools/:poolId/payments', (req, res, rp, qp) => {
  const payments = ds.getPayments(rp.poolId, {
    page:     parseInt(qp.page     || '0'),
    pageSize: parseInt(qp.pageSize || '10')
  });
  jsonOk(res, payments);
});

route('GET', '/dashboard/active-workers', (req, res, rp, qp) => {
  const poolId = qp.poolId;
  const { coinId, coin } = getCoinForPool(poolId);
  let mgr = managers[coinId];
  let clients = mgr?.stratumServer?.getMiners?.() || [];

  // For merge-mined aux chains (DOGE2), show the parent chain's workers
  if (clients.length === 0 && coin?.mergedParent) {
    const parentMgr = managers[coin.mergedParent];
    clients = parentMgr?.stratumServer?.getMiners?.() || [];
  }

  jsonOk(res, clients.map(c => ({
    miner:           c.address,
    workerName:      c.workerName,
    hashrate:        c.hashrate || 0,
    diff:            c.currentDiff || 1,
    sharesPerSecond: ds.getSharesRate(poolId),
    lastSeen:        c.lastSeen || new Date().toISOString()
  })));
});

route('GET', '/dashboard/total-earned', (req, res, rp, qp) => {
  jsonOk(res, { total: ds.totalPaid(qp.poolId) });
});

route('GET', '/dashboard/config', (req, res, rp, qp) => {
  const poolCfg = ds.getPoolConfig(qp.poolId);
  const { coin } = getCoinForPool(qp.poolId);
  jsonOk(res, {
    minimumPayment: poolCfg.minimumPayment,
    poolFee:        1,
    symbol:         coin?.symbol || '',
    stratumPort:    coin?.stratumPort || 0,
    algorithm:      'Scrypt'
  });
});

route('POST', '/dashboard/config/minimumPayment', async (req, res, rp, qp) => {
  const body = JSON.parse(await readBody(req));
  const val  = parseFloat(body.value);
  if (isNaN(val) || val < 0) return jsonErr(res, 400, 'Invalid value');
  const updated = ds.setPoolConfig(body.poolId, { minimumPayment: val });
  jsonOk(res, { success: true, minimumPayment: updated.minimumPayment });
});

route('POST', '/dashboard/miner-threshold', async (req, res, rp, qp) => {
  const body = JSON.parse(await readBody(req));
  if (!body.address || !body.paymentThreshold) return jsonErr(res, 400, 'address and paymentThreshold required');
  const updated = ds.setMinerThreshold(body.poolId, body.address, parseFloat(body.paymentThreshold));
  jsonOk(res, { paymentThreshold: updated.paymentThreshold });
});

route('GET', '/dashboard/mining-address', (req, res, rp, qp) => {
  const poolId = qp.poolId;
  const { coinId, coin } = getCoinForPool(poolId);
  if (!coin) return jsonErr(res, 404, 'Pool not found');

  const poolCfg = ds.getPoolConfig(poolId);
  jsonOk(res, {
    poolId,
    coinId,
    symbol: coin.symbol,
    miningAddress: poolCfg.miningAddress || coin.miningAddress || null,
    source: poolCfg.miningAddress ? 'saved' : 'config'
  });
});

route('POST', '/dashboard/mining-address/set', async (req, res) => {
  try {
    const body = JSON.parse(await readBody(req));
    const poolId = body.poolId;
    const address = (body.address || '').trim();
    if (!poolId || !address) return jsonErr(res, 400, 'poolId and address are required');

    const { coinId, coin } = getCoinForPool(poolId);
    if (!coin) return jsonErr(res, 404, 'Pool not found');

    const mgr = managers[coinId];
    if (mgr?.jobManager?.rpc) {
      try {
        const vr = await mgr.jobManager.rpc.call('validateaddress', [address]);
        if (vr && vr.isvalid === false) {
          return jsonErr(res, 400, `Invalid ${coin.symbol} address`);
        }
      } catch (_) {
        // Some wallet builds may not expose validateaddress; keep this non-blocking.
      }
    }

    coin.miningAddress = address;
    const updated = ds.setPoolConfig(poolId, { miningAddress: address });
    jsonOk(res, {
      success: true,
      poolId,
      symbol: coin.symbol,
      miningAddress: updated.miningAddress,
      note: 'Saved. New jobs will use this address.'
    });
  } catch (e) {
    jsonErr(res, 500, e.message || 'Failed to save mining address');
  }
});

route('POST', '/dashboard/mining-address/generate', async (req, res) => {
  try {
    const body = JSON.parse(await readBody(req));
    const poolId = body.poolId;
    if (!poolId) return jsonErr(res, 400, 'poolId is required');

    const { coinId, coin } = getCoinForPool(poolId);
    if (!coin) return jsonErr(res, 404, 'Pool not found');

    const mgr = managers[coinId];
    if (!mgr?.jobManager?.rpc) {
      return jsonErr(res, 503, 'RPC not available for this coin');
    }

    const address = await mgr.jobManager.rpc.getOrCreateWorkerAddress('mining');
    coin.miningAddress = address;
    const updated = ds.setPoolConfig(poolId, { miningAddress: address });
    jsonOk(res, {
      success: true,
      poolId,
      symbol: coin.symbol,
      miningAddress: updated.miningAddress,
      source: 'wallet',
      note: 'Generated from local wallet and saved. New jobs will use this address.'
    });
  } catch (e) {
    jsonErr(res, 500, e.message || 'Address generation failed');
  }
});

route('GET', '/dashboard/wallet-stats', async (req, res, rp, qp) => {
  const poolId = qp.poolId;
  const { coinId, coin } = getCoinForPool(poolId);
  if (!coin) return jsonErr(res, 404, 'Pool not found');
  const mgr = managers[coinId];
  let balance = 0, price = coin.coinPrice || null;
  try {
    if (mgr?.jobManager?.rpc) {
      balance = await mgr.jobManager.rpc.call('getbalance');
    }
  } catch (_) {}
  jsonOk(res, {
    symbol:    coin.symbol,
    balance,
    usdValue:  price !== null ? price * balance : null,
    price,
    hiddenAddressCount: 0
  });
});

route('GET', '/dashboard/wallet-info', async (req, res, rp, qp) => {
  const poolId = qp.poolId;
  const { coinId, coin } = getCoinForPool(poolId);
  if (!coin) return jsonErr(res, 404, 'Pool not found');
  const mgr = managers[coinId];
  let balance = 0, unconfirmed = 0, immature = 0, transactions = [];
  try {
    if (mgr?.jobManager?.rpc) {
      const rpc = mgr.jobManager.rpc;
      [balance, unconfirmed] = await Promise.all([
        rpc.call('getbalance').catch(() => 0),
        rpc.call('getunconfirmedbalance').catch(() => 0)
      ]);
      // Immature: sum of coinbase txs not yet matured
      const ltx = await rpc.call('listtransactions', ['*', 30, 0]).catch(() => []);
      immature = ltx.filter(t => t.category === 'immature').reduce((s, t) => s + t.amount, 0);
      transactions = ltx.slice(0, 20).map(t => ({
        category: t.category,
        amount: t.amount,
        address: t.address,
        confirmations: t.confirmations,
        time: t.time
      }));
    }
  } catch (_) {}
  jsonOk(res, { isLocal: true, balance, unconfirmed, immature, transactions });
});

route('POST', '/dashboard/wallet-send', async (req, res, rp, qp) => {
  const body = JSON.parse(await readBody(req));
  const { poolId, toAddress, amount, comment } = body;
  const { coinId, coin } = getCoinForPool(poolId);
  if (!coin) return jsonErr(res, 404, 'Pool not found');
  const mgr = managers[coinId];
  if (!mgr?.jobManager?.rpc) return jsonErr(res, 503, 'RPC not available');
  try {
    const txid = await mgr.jobManager.rpc.call('sendtoaddress', [
      toAddress, parseFloat(amount), comment || '', '', true
    ]);
    jsonOk(res, { success: true, txid });
  } catch (e) {
    jsonErr(res, 500, e.message || 'Send failed');
  }
});

route('GET', '/dashboard/shares-rate', (req, res, rp, qp) => {
  jsonOk(res, { sharesPerSecond: ds.getSharesRate(qp.poolId, 60) });
});

route('GET', '/dashboard/pending-rewards', (req, res, rp, qp) => {
  jsonOk(res, ds.pendingRewards(qp.poolId));
});

route('GET', '/dashboard/pool-balance', async (req, res, rp, qp) => {
  const poolId = qp.poolId;
  const { coinId, coin } = getCoinForPool(poolId);
  if (!coin) return jsonErr(res, 404, 'Pool not found');
  const mgr = managers[coinId];
  let balance = 0;
  try {
    if (mgr?.jobManager?.rpc) {
      balance = await mgr.jobManager.rpc.call('getbalance');
    }
  } catch (_) {}
  jsonOk(res, { balance, breakdown: [] });
});

route('POST', '/dashboard/block-workers', async (req, res, rp, qp) => {
  const body = JSON.parse(await readBody(req));
  const { poolId, heights } = body;
  jsonOk(res, ds.getBlockWorkers(poolId, heights || []));
});

// ─── Worker labels (name → friendly description for display) ──────────────
route('GET', '/dashboard/workers', (req, res) => {
  jsonOk(res, ds.getWorkers());
});

route('POST', '/dashboard/workers', async (req, res) => {
  try {
    const body = JSON.parse(await readBody(req));
    if (!body.name || !body.name.trim()) return jsonErr(res, 400, 'name is required');
    const worker = ds.upsertWorker({
      name:  body.name.trim(),
      label: (body.label || '').trim(),
      note:  (body.note  || '').trim()
    });
    jsonOk(res, worker);
  } catch (e) { jsonErr(res, 500, e.message); }
});

route('DELETE', '/dashboard/workers/:name', (req, res, rp) => {
  ds.deleteWorker(decodeURIComponent(rp.name));
  jsonOk(res, { success: true });
});

route('POST', '/dashboard/stop-all', async (req, res) => {
  try {
    const bodyText = await readBody(req);
    const body = bodyText ? JSON.parse(bodyText) : {};
    const reason = (body.reason || 'dashboard-stop-all').toString().slice(0, 120);
    const outPath = getStopAllRequestPath();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({
      requestedAt: new Date().toISOString(),
      requestedBy: 'dashboard',
      reason,
      requesterPid: process.pid
    }, null, 2));
    jsonOk(res, {
      success: true,
      message: 'Stop request queued. Watchdog will stop proxy and daemons.',
      requestPath: outPath
    });
  } catch (e) {
    jsonErr(res, 500, e.message || 'Failed to queue stop request');
  }
});

route('GET', '/dashboard/shares-stream', (req, res, rp, qp) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  const poolId = qp.poolId;
  let since = parseInt(qp.since || '0') || (Date.now() - 5000);
  const send = () => {
    const shares = ds.getSharesSince(poolId, since);
    if (shares.length) {
      since = Math.max(...shares.map(s => new Date(s.created).getTime()));
      res.write(`data: ${JSON.stringify(shares)}\n\n`);
    }
  };
  send();
  const iv = setInterval(send, 2000);
  req.on('close', () => clearInterval(iv));
});

// ─── Daemon update routes ──────────────────────────────────────────────────

route('GET', '/api/updates', async (req, res) => {
  try {
    const coins    = await updateChecker.getUpdateStatus(config.coins);
    const progress = updateChecker.getUpdateProgress();
    jsonOk(res, { coins, ...progress });
  } catch (e) {
    jsonErr(res, 500, e.message);
  }
});

route('POST', '/api/updates/:coinId/apply', async (req, res, rp) => {
  try {
    const coinId = rp.coinId;
    if (!config.coins[coinId]) return jsonErr(res, 404, `Unknown coin: ${coinId}`);

    const status = await updateChecker.getUpdateStatus(config.coins);
    const cs = status[coinId];

    if (!cs || !cs.updateAvailable) return jsonErr(res, 400, 'No update available for this coin');
    if (!cs.assetUrl)               return jsonErr(res, 400, 'No download asset found for this coin');

    // Don't queue a second request while one is already pending
    const { pendingRequest } = updateChecker.getUpdateProgress();
    if (pendingRequest) return jsonErr(res, 409, `Update for ${pendingRequest.coinId} already in progress`);

    const request = updateChecker.triggerUpdate(coinId, cs.assetUrl, cs.assetName, cs.latestVersion);
    jsonOk(res, { queued: true, request });
  } catch (e) {
    jsonErr(res, 500, e.message);
  }
});

route('GET', '/api/updates/progress', (req, res) => {
  jsonOk(res, updateChecker.getUpdateProgress());
});

route('GET', '/api/app-version', (req, res) => {
  jsonOk(res, { version: resolveAppVersion() });
});

// ─── Static files ──────────────────────────────────────────────────────────
const STATIC_DIR = process.pkg
  ? path.join(path.resolve(path.dirname(process.execPath), '..'), 'src', 'public')
  : path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.png': 'image/png',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2'
};

function serveStatic(req, res, urlPath) {
  const safePath = path.join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  // Prevent path traversal
  if (!safePath.startsWith(STATIC_DIR)) return jsonErr(res, 403, 'Forbidden');
  fs.readFile(safePath, (err, data) => {
    if (err) {
      // Fallback: serve index.html for SPA-style routes
      const idx = path.join(STATIC_DIR, 'index.html');
      fs.readFile(idx, (e2, d2) => {
        if (e2) return jsonErr(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    const ext  = path.extname(safePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ─── HTTP server ───────────────────────────────────────────────────────────
function start(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    const urlPath = req.url.split('?')[0];
    const match   = matchRoute(req.method, req.url);
    if (match) {
      try { match.fn(req, res, match.routeParams, match.queryParams); }
      catch (e) { jsonErr(res, 500, e.message); }
    } else {
      serveStatic(req, res, urlPath);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Dashboard] Listening on http://0.0.0.0:${port}`);
  });
  return server;
}

module.exports = { start, registerManager };
