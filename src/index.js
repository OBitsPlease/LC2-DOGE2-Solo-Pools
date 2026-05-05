'use strict';

/**
 * LC2/DOGE2 Solo Stratum Proxy
 *
 * Connects to your local node daemon(s) via RPC and serves
 * a Stratum v1 endpoint that solo miners can point their hardware at.
 *
 * Dev fee: 1% (LOCKED — hardcoded in coinbase-builder.js, cannot be changed
 * without modifying and rebuilding the source).
 */

const ORPHAN_RECHECK_MS = 120000;
const MAX_ORPHAN_RESUBMIT_ATTEMPTS = 3;
const RPCClient       = require('./rpc-client');
const JobManager      = require('./job-manager');
const StratumServer   = require('./stratum-server');
const config          = require('./config');
const dashboardServer = require('./dashboard-server');
const ds              = require('./data-store');
const net             = require('net');
const os              = require('os');
const path            = require('path');
const fs              = require('fs');
const { execFile }    = require('child_process');

function resolveAppVersion() {
  const fromEnv = (process.env.APP_VERSION || process.env.npm_package_version || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const fromPkg = (pkg?.version || '').trim();
    if (fromPkg) return fromPkg;
  } catch (_) {
    // In packaged mode package.json may not exist beside bundled sources.
  }

  const fromConfig = (config.appVersion || '').trim();
  return fromConfig || 'unknown';
}

const ORPHAN_LOG_DIR = path.join(path.dirname(ds.getDataDir()), 'logs');
const ORPHAN_EVENT_LOG = path.join(ORPHAN_LOG_DIR, 'orphan-events.log');

function writeOrphanEvent(msg) {
  try {
    fs.mkdirSync(ORPHAN_LOG_DIR, { recursive: true });
    fs.appendFileSync(ORPHAN_EVENT_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

const coins = [
  { key: 'lc2',   cfg: config.lc2   },
  { key: 'doge2', cfg: config.doge2 }
];

function isCoinEnabledBySelection(coinKey) {
  const envKey = `DAEMON_ENABLE_${coinKey.toUpperCase()}`;
  const raw = (process.env[envKey] || '').trim().toLowerCase();
  if (!raw) return true;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function canBindPort(port, host = '0.0.0.0') {
  return new Promise(resolve => {
    const tester = net.createServer();

    tester.once('error', () => {
      resolve(false);
    });

    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function findOpenPort(preferredPort, maxOffset = 200) {
  if (await canBindPort(preferredPort)) return preferredPort;

  for (let offset = 1; offset <= maxOffset; offset++) {
    const candidate = preferredPort + offset;
    if (await canBindPort(candidate)) return candidate;
  }

  throw new Error(`No free port found from ${preferredPort} to ${preferredPort + maxOffset}`);
}

function defaultCookieFileForCoin(key) {
  if (key === 'doge2' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Dogecoin2', '.cookie');
  }
  return null;
}

function writeStartupSummary(payload) {
  const outPath = path.join(ds.getDataDir(), 'startup-summary.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`[Startup] Summary written: ${outPath}`);
}

function getLanIpv4Address() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses || []) {
      if (entry && entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

function buildMinerConnectionInfo({ dashboardPort, startupCoins }) {
  const lanIp = getLanIpv4Address();
  const startedCoins = startupCoins.filter(coin => coin.started);
  const lc2Coin = startedCoins.find(coin => coin.key === 'lc2');
  const primaryCoin = lc2Coin || startedCoins[0] || null;
  const hasAuxDoge2 = startedCoins.some(coin => coin.key === 'doge2' && config.doge2.mergedParent === 'lc2');
  const lines = [];

  lines.push('============================================================');
  lines.push('  LC2/DOGE2 SOLO MINER - LIVE CONNECTION INFO');
  lines.push('============================================================');
  lines.push('');
  lines.push('Type this exact address into miners on the same network:');
  lines.push('');

  if (primaryCoin) {
    lines.push(`${primaryCoin.symbol}: ${lanIp}:${primaryCoin.stratumPort}`);
    lines.push('');
  }

  if (hasAuxDoge2 && lc2Coin) {
    lines.push('Merged mining note:');
    lines.push('- DOGE2 is AuxPoW merge-mined automatically from LC2 shares.');
    lines.push('- ASICs should use one pool endpoint only (LC2).');
    lines.push('- Do not configure a second DOGE2 port in ASIC settings.');
    lines.push('');
  }

  lines.push('Current block rewards:');
  for (const coin of startedCoins) {
    if (!Number.isFinite(coin.blockReward)) continue;
    const reward = Number.isInteger(coin.blockReward)
      ? coin.blockReward.toLocaleString()
      : coin.blockReward.toFixed(4);
    lines.push(`- ${coin.symbol}: ${reward} ${coin.symbol}`);
    if (coin.blockRewardNote) {
      lines.push(`  ${coin.blockRewardNote}`);
    }
  }
  lines.push('');

  lines.push(`If your miner requires the stratum+tcp:// prefix, use: stratum+tcp://${lanIp}:${primaryCoin ? primaryCoin.stratumPort : 3333}`);
  lines.push('');

  lines.push(`Dashboard: http://${lanIp}:${dashboardPort}/`);
  lines.push(`Local dashboard: http://127.0.0.1:${dashboardPort}/`);
  lines.push('');
  lines.push('If a miner is running on this same PC, you can also use 127.0.0.1 instead of the LAN IP.');
  lines.push('');
  lines.push('Generated: ' + new Date().toLocaleString());

  return lines.join('\n');
}

function writeMinerConnectionInfo(payload) {
  const outPath = path.join(ds.getDataDir(), 'MINER-CONNECTION-INFO.txt');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildMinerConnectionInfo(payload));
  console.log(`[Startup] Connection info written: ${outPath}`);
  return outPath;
}

function openTextDocument(filePath) {
  if (process.platform !== 'win32') return;
  execFile('notepad.exe', [filePath], err => {
    if (err) {
      console.error(`[Startup] Failed to open connection info: ${err.message}`);
      return;
    }
    console.log(`[Startup] Opened connection info: ${filePath}`);
  });
}

function reverseHex(hex) {
  if (!hex || typeof hex !== 'string' || hex.length % 2 !== 0) return hex;
  return hex.match(/../g).reverse().join('');
}

async function tryGetBlockConfirmations(rpc, hashHex) {
  if (!hashHex || !/^[0-9a-fA-F]{64}$/.test(hashHex)) return null;
  try {
    const b = await rpc.call('getblock', [hashHex]);
    if (b && typeof b.confirmations === 'number') return b.confirmations;
  } catch (_) {}
  return null;
}

async function monitorOrphansAndResubmit(running) {
  const byKey = Object.fromEntries(running.map(r => [r.key, r]));
  const pending = ds.getPendingBlocks();
  if (!pending.length) return;

  for (const block of pending) {
    const coinKey = String(block.poolId || '').replace(/_solo\d+$/, '');
    const instance = byKey[coinKey];
    if (!instance || !instance.rpc) continue;

    let confirmations = null;
    if (block.hash) {
      confirmations = await tryGetBlockConfirmations(instance.rpc, block.hash);
      if (confirmations === null) {
        confirmations = await tryGetBlockConfirmations(instance.rpc, reverseHex(block.hash));
      }
    }

    if (typeof confirmations === 'number') {
      if (confirmations < 0) {
        writeOrphanEvent(`orphan-detected pool=${block.poolId} height=${block.height} confirmations=${confirmations}`);
        ds.updateBlockRecord(block.poolId, block.height, block.created, {
          status: 'orphaned',
          confirmationProgress: 0,
          orphanDetectedAt: new Date().toISOString()
        });
      } else if (confirmations === 0) {
        ds.updateBlockRecord(block.poolId, block.height, block.created, {
          status: 'pending',
          confirmationProgress: 0
        });
      } else {
        ds.updateBlockRecord(block.poolId, block.height, block.created, {
          status: 'confirmed',
          confirmationProgress: Math.min(100, confirmations),
          confirmations
        });
      }
      continue;
    }

    const chainHeight = instance?.jobMgr?._networkInfo?.blockHeight || 0;
    const ageMs = Date.now() - new Date(block.created || Date.now()).getTime();
    if (chainHeight > 0 && block.height > 0 && chainHeight - block.height >= 8 && ageMs > 10 * 60 * 1000) {
      writeOrphanEvent(`orphan-heuristic pool=${block.poolId} height=${block.height} chainHeight=${chainHeight} ageMs=${ageMs}`);
      ds.updateBlockRecord(block.poolId, block.height, block.created, {
        status: 'orphaned',
        confirmationProgress: 0,
        orphanDetectedAt: new Date().toISOString()
      });
    }

    const latest = ds.getPendingBlocks(block.poolId).find(b => b.created === block.created && b.height === block.height);
    const shouldRetry = latest && latest.status === 'orphaned' && latest.blockHex && (latest.resubmitAttempts || 0) < MAX_ORPHAN_RESUBMIT_ATTEMPTS;
    if (!shouldRetry) continue;

    const attempts = (latest.resubmitAttempts || 0) + 1;
    let submitResult = null;
    let submitErr = null;
    try {
      submitResult = await instance.rpc.submitBlock(latest.blockHex);
    } catch (e) {
      submitErr = e.message;
    }

    const accepted = submitErr === null && (submitResult === null || submitResult === undefined || submitResult === '' || String(submitResult).toLowerCase().includes('duplicate'));

    ds.updateBlockRecord(latest.poolId, latest.height, latest.created, {
      status: accepted ? 'pending' : 'orphaned',
      resubmitAttempts: attempts,
      lastResubmitAt: new Date().toISOString(),
      lastResubmitResult: submitErr ? `error:${submitErr}` : String(submitResult)
    });

    const sym = instance.cfg?.symbol || coinKey.toUpperCase();
    writeOrphanEvent(`resubmit pool=${latest.poolId} symbol=${sym} height=${latest.height} attempt=${attempts} accepted=${accepted} result=${submitErr || submitResult}`);
    console.log(`[${sym}] Orphan monitor: resubmit attempt ${attempts} ${accepted ? 'accepted/queued' : 'failed'} for block height ${latest.height}`);
  }
}

async function startCoin(key, cfg) {
  console.log(`\n[${cfg.symbol}] Starting solo stratum proxy...`);

  if (cfg.rpc.port === 0) {
    throw new Error(`[${cfg.symbol}] RPC port is 0 — not yet configured in src/config.js`);
  }

  const defaultCookieFile = defaultCookieFileForCoin(key);

  const rpc = new RPCClient({
    host:     cfg.rpc.host,
    port:     cfg.rpc.port,
    user:     cfg.rpc.user,
    password: cfg.rpc.password,
    gbtRules: cfg.rpc.gbtRules,
    cookieFile: cfg.rpc.cookieFile || defaultCookieFile,
    preferCookieAuth: key !== 'doge2' || !process.pkg
  });

  // Quick connectivity check
  try {
    const count = await rpc.getBlockCount();
    console.log(`[${cfg.symbol}] RPC OK — current block height: ${count}`);
  } catch (err) {
    throw new Error(`[${cfg.symbol}] Cannot connect to daemon RPC on port ${cfg.rpc.port}: ${err.message}`);
  }

  const poolId = `${key}_solo1`;
  const savedCfg = ds.getPoolConfig(poolId);

  // Persisted dashboard-selected address always wins over file config.
  if (savedCfg.miningAddress) {
    cfg.miningAddress = savedCfg.miningAddress;
    console.log(`[${cfg.symbol}] Mining address (saved): ${cfg.miningAddress}`);
  } else if (!cfg.miningAddress || cfg.miningAddress.startsWith('REPLACE') || cfg.miningAddress.startsWith('TODO')) {
    try {
      cfg.miningAddress = await rpc.getOrCreateWorkerAddress('mining');
      ds.setPoolConfig(poolId, { miningAddress: cfg.miningAddress });
      console.log(`[${cfg.symbol}] Mining address (auto-fetched from wallet): ${cfg.miningAddress}`);
    } catch (e) {
      throw new Error(
        `[${cfg.symbol}] miningAddress not set and wallet auto-fetch failed: ${e.message}\n` +
        `  Either set miningAddress in src/config.js or ensure the ${cfg.symbol} wallet is unlocked.`
      );
    }
  } else {
    console.log(`[${cfg.symbol}] Mining address (config): ${cfg.miningAddress}`);
    ds.setPoolConfig(poolId, { miningAddress: cfg.miningAddress });
  }

  // Validate dev address
  if (cfg.devAddress && (cfg.devAddress.startsWith('REPLACE') || cfg.devAddress.startsWith('TODO'))) {
    throw new Error(`[${cfg.symbol}] devAddress is not configured in src/config.js`);
  }
  // Note: dev addresses are now locked in coinbase-builder.js — no config field needed

  const jobMgr = new JobManager(rpc, cfg);
  const stratum = new StratumServer(jobMgr, cfg);

  // Register with dashboard server
  dashboardServer.registerManager(key, jobMgr, stratum);

  stratum.on('blockFound', ({ workerName, blockHex = null, hashHex = null, height: eventHeight = null }) => {
    const height = eventHeight || jobMgr.currentJob?.height || 0;
    const reward = jobMgr.currentJob?.template?.coinbasevalue
      ? jobMgr.currentJob.template.coinbasevalue / 1e8 : 0;
    console.log(`\n🎉 *** BLOCK FOUND *** ${cfg.symbol} by ${workerName} at height ${height}\n`);
    ds.addBlock({
      poolId,
      height,
      hash: hashHex || jobMgr._lastBlockHash || '',
      reward: reward * 0.99,  // miner share (after 1% dev fee)
      effort: 0,
      miner:  workerName.split('.')[0],
      worker: workerName,
      status: 'pending',
      confirmationProgress: 0,
      blockHex,
      resubmitAttempts: 0
    });
    // Take a performance snapshot at block time
    ds.addPerfSnapshot({
      poolId,
      hashrate:          jobMgr.getPoolHashrate(),
      networkHashrate:   jobMgr._networkInfo?.networkHashrate   || 0,
      difficulty:        jobMgr._networkInfo?.networkDifficulty || 0,
      workers:           Object.fromEntries(
        stratum.getMiners().map(m => [m.workerName, { hashrate: m.hashrate || 0 }])
      )
    });
  });

  // Record every valid share for the live stream and performance tracking
  const origProcess = jobMgr.processShare.bind(jobMgr);
  jobMgr.processShare = function(...args) {
    const result = origProcess(...args);
    if (result.valid) {
      const workerName = args[5] || 'unknown';
      const shareDiff = Number(args[6] || 1);
      ds.addShare({
        poolId,
        worker: workerName,
        valid: true,
        diff: Number.isFinite(shareDiff) && shareDiff > 0 ? shareDiff : 1
      });
    }
    return result;
  };

  await stratum.start();
  jobMgr.start();

  // Snapshot performance every 60 seconds.
  // workersGetter may be replaced in main() for merge-mined aux chains
  // so their snapshots reflect the parent chain's connected miners.
  const instance = { rpc, jobMgr, stratum };
  instance.perfInterval = setInterval(() => {
    const minersSource = instance.workersGetter ? instance.workersGetter() : stratum.getMiners();
    ds.addPerfSnapshot({
      poolId,
      hashrate:        jobMgr.getPoolHashrate(),
      networkHashrate: jobMgr._networkInfo?.networkHashrate   || 0,
      difficulty:      jobMgr._networkInfo?.networkDifficulty || 0,
      workers:         Object.fromEntries(
        minersSource.map(m => [m.workerName, { hashrate: m.hashrate || 0 }])
      )
    });
  }, 60000);

  return instance;
}

async function main() {
  console.log('='.repeat(60));
  console.log('  LC2/DOGE2 Solo Stratum Proxy  |  Dev fee: 1% (locked)');
  console.log('='.repeat(60));

  const running = [];
  const startupCoins = [];

  for (const { key, cfg } of coins) {
    if (!isCoinEnabledBySelection(key)) {
      console.log(`[${cfg.symbol}] Disabled by launcher selection — skipping.`);
      startupCoins.push({
        key,
        symbol: cfg.symbol,
        started: false,
        rpcPort: cfg.rpc.port,
        stratumPort: cfg.stratumPort,
        requestedStratumPort: cfg.stratumPort,
        blockReward: cfg.blockReward,
        blockRewardNote: cfg.blockRewardNote,
        disabledBySelection: true
      });
      continue;
    }

    if (!cfg.enabled) {
      console.log(`[${cfg.symbol}] Disabled — skipping (${key === 'doge2' ? 'waiting for chain params' : 'set enabled:true in config'})`);
      continue;
    }

    const requestedPort = cfg.stratumPort;
    const selectedPort = await findOpenPort(requestedPort);
    cfg.stratumPort = selectedPort;
    if (selectedPort !== requestedPort) {
      console.log(`[${cfg.symbol}] Port ${requestedPort} is busy. Using ${selectedPort} instead.`);
    }

    try {
      const instance = await startCoin(key, cfg);
      running.push({ key, cfg, ...instance });
      startupCoins.push({
        key,
        symbol: cfg.symbol,
        started: true,
        rpcPort: cfg.rpc.port,
        stratumPort: cfg.stratumPort,
        requestedStratumPort: requestedPort,
        blockReward: cfg.blockReward,
        blockRewardNote: cfg.blockRewardNote
      });
    } catch (err) {
      console.error(`[${cfg.symbol}] Failed to start: ${err.message}`);
      startupCoins.push({
        key,
        symbol: cfg.symbol,
        started: false,
        rpcPort: cfg.rpc.port,
        stratumPort: cfg.stratumPort,
        requestedStratumPort: requestedPort,
        blockReward: cfg.blockReward,
        blockRewardNote: cfg.blockRewardNote,
        error: err.message
      });
      // Don't exit — other coins may still work
    }
  }

  let dashPort = null;
  let requestedDashPort = config.dashboard.port;

  if (running.length > 0) {
    requestedDashPort = config.dashboard.port;
    dashPort = await findOpenPort(requestedDashPort);
    config.dashboard.port = dashPort;
    if (dashPort !== requestedDashPort) {
      console.log(`[Dashboard] Port ${requestedDashPort} is busy. Using ${dashPort} instead.`);
    }
  }

  writeStartupSummary({
    generatedAt: new Date().toISOString(),
    appVersion: resolveAppVersion(),
    dashboard: {
      requestedPort: requestedDashPort,
      port: dashPort,
      url: dashPort ? `http://127.0.0.1:${dashPort}/` : null
    },
    coins: startupCoins
  });

  const connectionInfoPath = writeMinerConnectionInfo({
    dashboardPort: dashPort,
    startupCoins
  });
  openTextDocument(connectionInfoPath);

  if (running.length === 0) {
    console.error('\nNo coins started. Please edit src/config.js and try again.');
    process.exit(1);
  }

  // Wire up AuxPoW merge mining: LC2 (parent) → DOGE2 (aux)
  const lc2Instance  = running.find(r => r.key === 'lc2');
  const doge2Instance = running.find(r => r.key === 'doge2');
  if (lc2Instance && doge2Instance) {
    lc2Instance.jobMgr.setAuxJobManager(doge2Instance.jobMgr);

    // DOGE2 perf snapshots must show LC2's miners (no one connects to port 3334 directly)
    doge2Instance.workersGetter = () => lc2Instance.stratum.getMiners();

    // Every valid LC2 share is simultaneously a DOGE2 share (merge mining).
    // Mirror each LC2 share into doge2_solo1 so the DOGE2 dashboard shows live data.
    const origLc2Process = lc2Instance.jobMgr.processShare.bind(lc2Instance.jobMgr);
    lc2Instance.jobMgr.processShare = function(...args) {
      const result = origLc2Process(...args);
      if (result.valid) {
        const workerName = args[5] || 'unknown';
        const shareDiff = Number(args[6] || 1);
        ds.addShare({
          poolId: 'doge2_solo1',
          worker: workerName,
          valid: true,
          diff: Number.isFinite(shareDiff) && shareDiff > 0 ? shareDiff : 1
        });
      }
      return result;
    };

    // Log and record DOGE2 AuxPoW blocks found via LC2 shares
    lc2Instance.jobMgr.on('auxBlockFound', ({ coin, height, blockHex = null, hashHex = null }) => {
      console.log(`\n🎉 *** DOGE2 AuxPoW BLOCK FOUND *** at height ${height}\n`);
      const poolId = 'doge2_solo1';
      const reward = doge2Instance.jobMgr.currentJob?.template?.coinbasevalue
        ? doge2Instance.jobMgr.currentJob.template.coinbasevalue / 1e8 : 0;
      ds.addBlock({
        poolId,
        height,
        hash: hashHex || doge2Instance.jobMgr._lastBlockHash || '',
        reward: reward * 0.99,
        effort: 0,
        miner:  'merge-mined',
        worker: 'merge-mined',
        status: 'pending',
        confirmationProgress: 0,
        blockHex,
        resubmitAttempts: 0
      });
    });
  }

  // Start dashboard
  dashboardServer.start(dashPort);
  console.log(`\nDashboard: http://127.0.0.1:${dashPort}/`);

  // Status summary every 60 seconds
  setInterval(() => {
    console.log('\n--- Status ---');
    for (const { stratum } of running) {
      const s = stratum.getStats();
      console.log(`[${s.symbol}] port=${s.port} miners=${s.connectedMiners} height=${s.currentHeight || 'N/A'} job=${s.currentJobId || 'none'}`);
    }
  }, 60000);

  // Orphan monitor: track pending/orphaned blocks and auto-resubmit best-effort.
  setInterval(() => {
    monitorOrphansAndResubmit(running).catch(err => {
      console.error(`[OrphanMonitor] ${err.message}`);
    });
  }, ORPHAN_RECHECK_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    for (const { jobMgr, stratum } of running) {
      jobMgr.stop();
      stratum.stop();
    }
    process.exit(0);
  });

  console.log('\nProxy running. Point your miner at:');
  for (const { cfg } of running) {
    console.log(`  ${cfg.symbol}: stratum+tcp://127.0.0.1:${cfg.stratumPort}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

