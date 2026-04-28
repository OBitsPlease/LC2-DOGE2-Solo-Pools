'use strict';

/**
 * config.js — All per-coin and proxy settings.
 *
 * LC2 is fully configured.
 * DOGE2 values marked TODO — fill in once dev provides chain params.
 * DO NOT change DEV_FEE — it is locked at 1% in coinbase-builder.js.
 */

const coins = {

  // ===========================================================
  // LC2 (LitecoinII)
  // ===========================================================
  lc2: {
    enabled: true,
    symbol: 'LC2',
    name: 'LitecoinII',
    color: '#5c9dca',
    logo: 'lc2-logo.png',
    blockReward: 50,
    coinPrice: 0.012006,

    // Stratum port miners connect to (3333 is free)
    stratumPort: 3333,

    // Starting share difficulty sent to miners
    difficulty: 1,

    // Your LC2 mining reward address (auto-fetched from wallet if blank)
    miningAddress: 'lc21qn7zrvlfm43ktkpxnpsxm5lfg3lwdy9k4zpjsxw',

    // LC2 daemon RPC connection (from chainparamsbase.cpp: RPC=9222, P2P=9223)
    // LC2 is based on Litecoin 0.21 — requires mweb rule in getblocktemplate
    rpc: {
      host: '127.0.0.1',
      port: 9222,
      user: 'lc2rpc',
      password: '7ezB1EwlQf4iKJGba85ymAgo',
      gbtRules: ['segwit', 'mweb']
    }
  },

  // ===========================================================
  // DOGE2 (Dogecoin2) — v1.14.9.0 Dogecoin Core fork
  // Chain ID (AuxPoW): 0x1d37 | Scrypt | 60s block time
  // ===========================================================
  doge2: {
    enabled: true,

    symbol: 'DOGE2',
    name: 'Dogecoin2',
    color: '#c2a633',
    logo: 'doge2-logo.png',
    blockReward: 500000,  // 500,000 DOGE2/block (early randomized phase)

    // DOGE2 is merge-mined from LC2 via AuxPoW — miners connect to LC2 stratum only
    mergedParent: 'lc2',

    // Stratum port (kept running but miners don't connect here directly)
    stratumPort: 3334,

    difficulty: 1,

    // Mining reward address (auto-generated from wallet)
    miningAddress: 'D8ENbJtef4iMNfCsQ1Xavpm6ZCcTirJgp3',

    // DOGE2 daemon RPC: port 22655, P2P 22656 (from binary help)
    // Dogecoin 1.14-based — standard segwit rules only (no mweb)
    rpc: {
      host: '127.0.0.1',
      port: 22655,
      user: 'doge2rpc',
      password: 'Doge2RpcPass2026!',
      gbtRules: ['segwit']
    }
  }
};

module.exports = {
  coins,
  dashboard: {
    port: 8081   // web dashboard port (8080 is used by existing dashboard)
  },
  // Legacy flat exports so existing code (index.js) still works
  lc2:   coins.lc2,
  doge2: coins.doge2
};
