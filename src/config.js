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
    blockRewardNote: 'Current reward: 50 LC2 per block.',
    coinPrice: 0.012006,

    // Stratum port miners connect to (3333 is free)
    stratumPort: 3333,

    // Starting share difficulty sent to miners.
    // Set high enough that each share represents meaningful work.
    // For a 2.2 GH/s scrypt ASIC, 32768 → ~1 share/sec; vardiff will raise to ~500k for 1/15sec target.
    difficulty: 32768,

    // Compatibility fallback for ASIC firmware variants that submit valid scrypt
    // work with alternate header byte-order conventions.
    scryptCompatFallback: true,

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
    },

    // Daemon auto-update (GitHub releases)
    // Set githubRepo to the coin's GitHub repo slug (owner/repo)
    // assetPattern: regex to match the Windows 64-bit zip in the release assets
    daemonUpdate: {
      githubRepo:       'TODO/litecoinii',      // ← fill in when repo is known
      assetPattern:     'windows.{0,10}64.{0,30}\\.zip',
      installedVersion: '1.0.0'                 // ← set to your installed version
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
    blockRewardNote: 'Current reward: 500,000 DOGE2 per block. Halving in roughly 53 days to 250,000 DOGE2.',

    // DOGE2 is merge-mined from LC2 via AuxPoW — miners connect to LC2 stratum only
    mergedParent: 'lc2',

    // Stratum port (kept running but miners don't connect here directly)
    stratumPort: 3334,

    difficulty: 32768,
    miningAddress: 'D8ENbJtef4iMNfCsQ1Xavpm6ZCcTirJgp3',

    // DOGE2 daemon RPC: port 22655, P2P 22656 (from binary help)
    // Dogecoin 1.14-based — standard segwit rules only (no mweb)
    rpc: {
      host: '127.0.0.1',
      port: 22655,
      user: 'doge2rpc',
      password: 'Doge2RpcPass2026!',
      gbtRules: ['segwit']
    },

    // Daemon auto-update (GitHub releases)
    daemonUpdate: {
      githubRepo:       'TODO/dogecoin2',         // ← fill in when repo is known
      assetPattern:     'windows.{0,10}64.{0,30}\\.zip',
      installedVersion: '0.0.7'                   // ← set to your installed version
    }
  }
};

module.exports = {
  appVersion: '1.0.39',
  coins,
  dashboard: {
    port: 8081   // web dashboard port (8080 is used by existing dashboard)
  },
  // Legacy flat exports so existing code (index.js) still works
  lc2:   coins.lc2,
  doge2: coins.doge2
};
