#!/usr/bin/env node
'use strict';

/**
 * Address generator for LC2 (and DOGE2 once params are known).
 *
 * Generates a new random private key and derives the corresponding
 * P2PKH address and WIF (Wallet Import Format) private key.
 *
 * Output is saved to addresses.txt in the project root.
 *
 * Usage:  npm run genaddress
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---- coin version bytes (from chainparams.cpp) ----
const COINS = [
  {
    symbol: 'LC2',
    // base58Prefixes[PUBKEY_ADDRESS] = 48  => addresses start with "L"
    pubkeyVersion: 48,
    // base58Prefixes[SECRET_KEY] = 176
    wifVersion: 176,
    note: 'LC2 P2PKH address (starts with L)'
  },
  {
    symbol: 'DOGE2',
    // TODO: replace with actual version bytes once dev provides them
    pubkeyVersion: 30,   // placeholder — same as Dogecoin (starts with D)
    wifVersion: 158,     // placeholder — same as Dogecoin
    note: 'DOGE2 P2PKH address — VERSION BYTES ARE PLACEHOLDERS, update when dev provides chainparams'
  }
];

// ---- secp256k1 key generation using ECDH (cleanest built-in API) ----
function generateSecp256k1() {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();

  const privRaw = ecdh.getPrivateKey(); // 32-byte Buffer

  // getPublicKey() returns uncompressed (65 bytes: 04 || x || y)
  const pubUncompressed = ecdh.getPublicKey();
  const x = pubUncompressed.slice(1, 33);
  const y = pubUncompressed.slice(33, 65);
  const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
  const pubRaw = Buffer.concat([Buffer.from([prefix]), x]); // 33-byte compressed

  return { privRaw, pubRaw };
}

// ---- base58check encoding ----
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let result = '';
  while (n > 0n) {
    const rem = n % 58n;
    result = BASE58_CHARS[Number(rem)] + result;
    n = n / 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}

function base58CheckEncode(versionByte, payload) {
  const full = Buffer.concat([Buffer.from([versionByte]), payload]);
  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(full).digest())
    .digest()
    .slice(0, 4);
  return base58Encode(Buffer.concat([full, checksum]));
}

// ---- WIF encoding (compressed) ----
function toWIF(privRaw, wifVersion) {
  const payload = Buffer.concat([privRaw, Buffer.from([0x01])]);
  return base58CheckEncode(wifVersion, payload);
}

// ---- Address derivation ----
function toAddress(pubRaw, pubkeyVersion) {
  const sha = crypto.createHash('sha256').update(pubRaw).digest();
  const hash160 = crypto.createHash('ripemd160').update(sha).digest();
  return base58CheckEncode(pubkeyVersion, hash160);
}

// ---- Main ----
const lines = [
  '================================================================',
  '  LC2/DOGE2 Generated Addresses & Private Keys',
  `  Generated: ${new Date().toISOString()}`,
  '================================================================',
  '',
  '*** KEEP THIS FILE SECURE — PRIVATE KEYS GIVE FULL ACCESS TO FUNDS ***',
  ''
];

for (const coin of COINS) {
  console.log(`Generating ${coin.symbol} keypair...`);
  const { privRaw, pubRaw } = generateSecp256k1();
  const address = toAddress(pubRaw, coin.pubkeyVersion);
  const wif = toWIF(privRaw, coin.wifVersion);

  lines.push(`== ${coin.symbol} ==`);
  lines.push(`Note:    ${coin.note}`);
  lines.push(`Address: ${address}`);
  lines.push(`WIF Key: ${wif}`);
  lines.push('');

  console.log(`  Address: ${address}`);
  console.log(`  WIF:     ${wif}`);
  console.log('');
}

lines.push('================================================================');
lines.push('To use these addresses:');
lines.push('  1. Import the WIF key into your wallet daemon:');
lines.push('       litecoinII-cli importprivkey "<WIF>"');
lines.push('  2. Copy the address into src/config.js > miningAddress');
lines.push('  3. Never share your WIF keys');
lines.push('================================================================');

const outPath = path.join(__dirname, '..', 'addresses.txt');
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`Saved to: ${outPath}`);
