'use strict';

const { dsha256, addressToScript, varInt, writeInt32LE, writeUInt32LE, writeInt64LE, encodeHeight } = require('./utils');

// ============================================================
// DEV FEE - LOCKED AT 1% — DO NOT CHANGE
// This is a condition of using this software.
// ============================================================
const DEV_FEE = 0.01;
Object.freeze({ DEV_FEE }); // signal intent; don't allow accidental override

// ============================================================
// DEV WALLET ADDRESSES — LOCKED — DO NOT CHANGE
// These are the developer's addresses. Every install of this
// software sends 1% of every block reward here. Changing these
// addresses violates the terms of this software.
// ============================================================
const DEV_ADDRESSES = Object.freeze({
  LC2:   'lc21q07ewakynrj7xfpdcwvqd9chwhd6cz9wcz7dytf',
  DOGE2: 'DJXWPatWa4o3th49zwervzxBo6sAGzEivX'
});

const EXTRA_NONCE_1_LEN = 4; // bytes assigned per miner
const EXTRA_NONCE_2_LEN = 4; // bytes miner varies
const POOL_MARKER = Buffer.from('/LC2SoloProxy/');

/**
 * Build stratum coinbase split (coinb1 / coinb2) for a block template.
 *
 * Full coinbase = coinb1 + extraNonce1(4B) + extraNonce2(4B) + coinb2
 *
 * @param {object} opts
 * @param {number}  opts.blockHeight
 * @param {number}  opts.coinbaseValue  - satoshis (or smallest unit)
 * @param {string}  opts.minerAddress   - full block reward minus dev fee goes here
 * @param {string}  opts.symbol         - coin symbol (LC2 or DOGE2) — used to look up locked dev address
 * @param {Buffer} [opts.auxCommitment] - optional 44-byte merged mining commitment (for LC2 as parent)
 * @returns {{ coinb1: string, coinb2: string, devValue: number, minerValue: number }}
 */
function buildCoinbaseSplit({ blockHeight, coinbaseValue, minerAddress, symbol, auxCommitment = null }) {
  const devAddress = DEV_ADDRESSES[symbol];
  if (!devAddress) throw new Error(`No locked dev address for coin symbol: ${symbol}`);
  const devValue  = Math.floor(coinbaseValue * DEV_FEE);
  const minerValue = coinbaseValue - devValue;

  const minerScript = addressToScript(minerAddress);
  const devScript   = addressToScript(devAddress);

  // --- scriptSig content BEFORE the extranonces ---
  const heightPush = encodeHeight(blockHeight);
  // Include merged mining commitment if provided (for LC2 as parent chain)
  const prePart = auxCommitment
    ? Buffer.concat([heightPush, POOL_MARKER, auxCommitment])
    : Buffer.concat([heightPush, POOL_MARKER]);

  // Total scriptSig length = prePart + extranonce1 + extranonce2
  const scriptSigLen = prePart.length + EXTRA_NONCE_1_LEN + EXTRA_NONCE_2_LEN;

  // --- coinb1: version + 1 vin (minus extranonces) ---
  const coinb1 = Buffer.concat([
    writeInt32LE(2),              // tx version
    varInt(1),                    // vin count
    Buffer.alloc(32, 0x00),       // prevout hash (coinbase: all zeros)
    writeUInt32LE(0xffffffff),    // prevout index (coinbase)
    varInt(scriptSigLen),         // scriptSig length (includes extranonces)
    prePart                       // scriptSig content before extranonces
  ]);

  // --- coinb2: (after extranonces) sequence + 2 vouts + locktime ---
  const minerOutput = Buffer.concat([
    writeInt64LE(minerValue),
    varInt(minerScript.length),
    minerScript
  ]);
  const devOutput = Buffer.concat([
    writeInt64LE(devValue),
    varInt(devScript.length),
    devScript
  ]);

  const coinb2 = Buffer.concat([
    writeUInt32LE(0xffffffff),    // sequence
    varInt(2),                    // vout count (2: miner + dev)
    minerOutput,
    devOutput,
    writeUInt32LE(0)              // locktime
  ]);

  return {
    coinb1: coinb1.toString('hex'),
    coinb2: coinb2.toString('hex'),
    devValue,
    minerValue
  };
}

/**
 * Compute the coinbase transaction ID from the four parts.
 */
function coinbaseTxid(coinb1Hex, extraNonce1Hex, extraNonce2Hex, coinb2Hex) {
  const raw = Buffer.concat([
    Buffer.from(coinb1Hex, 'hex'),
    Buffer.from(extraNonce1Hex, 'hex'),
    Buffer.from(extraNonce2Hex, 'hex'),
    Buffer.from(coinb2Hex, 'hex')
  ]);
  return dsha256(raw).toString('hex');
}

/**
 * Build the complete serialised coinbase transaction (for block submission).
 */
function buildFullCoinbaseTx(coinb1Hex, extraNonce1Hex, extraNonce2Hex, coinb2Hex) {
  return Buffer.concat([
    Buffer.from(coinb1Hex, 'hex'),
    Buffer.from(extraNonce1Hex, 'hex'),
    Buffer.from(extraNonce2Hex, 'hex'),
    Buffer.from(coinb2Hex, 'hex')
  ]).toString('hex');
}

module.exports = {
  DEV_FEE,
  DEV_ADDRESSES,
  EXTRA_NONCE_1_LEN,
  EXTRA_NONCE_2_LEN,
  buildCoinbaseSplit,
  coinbaseTxid,
  buildFullCoinbaseTx
};
