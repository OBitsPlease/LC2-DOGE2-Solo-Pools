'use strict';

const net = require('net');
const path = require('path');
const config = require('./config');
const RPCClient = require('./rpc-client');

const coins = [
  { key: 'lc2', cfg: config.lc2 },
  { key: 'doge2', cfg: config.doge2 }
];

function canBindPort(port, host = '0.0.0.0') {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, host);
  });
}

async function findOpenPort(preferredPort, reserved = new Set(), maxOffset = 200) {
  if (!reserved.has(preferredPort) && await canBindPort(preferredPort)) return preferredPort;
  for (let offset = 1; offset <= maxOffset; offset++) {
    const candidate = preferredPort + offset;
    if (!reserved.has(candidate) && await canBindPort(candidate)) return candidate;
  }
  throw new Error(`No free port found from ${preferredPort} to ${preferredPort + maxOffset}`);
}

function defaultCookieFileForCoin(key) {
  if (key === 'doge2' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Dogecoin2', '.cookie');
  }
  return null;
}

async function checkCoin(key, cfg, reservedPorts) {
  if (!cfg.enabled) {
    return {
      key,
      symbol: cfg.symbol,
      enabled: false,
      rpcOk: false,
      rpcError: 'disabled',
      requestedStratumPort: cfg.stratumPort,
      selectedStratumPort: null
    };
  }

  const selectedStratumPort = await findOpenPort(cfg.stratumPort, reservedPorts);
  reservedPorts.add(selectedStratumPort);

  const rpc = new RPCClient({
    host: cfg.rpc.host,
    port: cfg.rpc.port,
    user: cfg.rpc.user,
    password: cfg.rpc.password,
    gbtRules: cfg.rpc.gbtRules,
    cookieFile: cfg.rpc.cookieFile || defaultCookieFileForCoin(key),
    preferCookieAuth: key !== 'doge2' || !process.pkg
  });

  try {
    const height = await rpc.getBlockCount();
    return {
      key,
      symbol: cfg.symbol,
      enabled: true,
      rpcOk: true,
      rpcHeight: height,
      rpcPort: cfg.rpc.port,
      requestedStratumPort: cfg.stratumPort,
      selectedStratumPort
    };
  } catch (err) {
    return {
      key,
      symbol: cfg.symbol,
      enabled: true,
      rpcOk: false,
      rpcError: err.message,
      rpcPort: cfg.rpc.port,
      requestedStratumPort: cfg.stratumPort,
      selectedStratumPort
    };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Preflight Check: LC2/DOGE2 Solo Stratum Proxy');
  console.log('='.repeat(60));

  const results = [];
  const reservedPorts = new Set();
  for (const { key, cfg } of coins) {
    const result = await checkCoin(key, cfg, reservedPorts);
    results.push(result);

    const rpcState = result.enabled
      ? (result.rpcOk ? `OK (height ${result.rpcHeight})` : `FAIL (${result.rpcError})`)
      : 'SKIPPED (disabled)';

    console.log(`\n[${result.symbol}]`);
    console.log(`  RPC (${result.rpcPort || 'n/a'}): ${rpcState}`);
    console.log(`  Stratum requested: ${result.requestedStratumPort}`);
    console.log(`  Stratum selected : ${result.selectedStratumPort || 'n/a'}`);
  }

  const requestedDash = config.dashboard.port;
  const selectedDash = await findOpenPort(requestedDash, reservedPorts);
  console.log('\n[Dashboard]');
  console.log(`  Requested: ${requestedDash}`);
  console.log(`  Selected : ${selectedDash}`);
  console.log(`  URL      : http://127.0.0.1:${selectedDash}/`);

  const enabledCoins = results.filter(r => r.enabled);
  const badRpc = enabledCoins.filter(r => !r.rpcOk);

  if (badRpc.length > 0) {
    console.error('\nPreflight finished with RPC issues.');
    process.exit(1);
  }

  console.log('\nPreflight passed. Safe to run npm start.');
}

main().catch(err => {
  console.error('Preflight failed:', err.message);
  process.exit(1);
});
