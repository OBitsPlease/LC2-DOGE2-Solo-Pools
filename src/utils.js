'use strict';

const crypto = require('crypto');

// Base58 alphabet
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function dsha256(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

function base58Decode(str) {
  let n = BigInt(0);
  for (const ch of str) {
    const idx = BASE58.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base58 char: ${ch}`);
    n = n * 58n + BigInt(idx);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1's become 0x00 bytes
  for (const ch of str) {
    if (ch === '1') bytes.unshift(0);
    else break;
  }
  return Buffer.from(bytes);
}

function base58CheckDecode(str) {
  const decoded = base58Decode(str);
  const payload = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);
  const hash = dsha256(payload);
  if (!hash.slice(0, 4).equals(checksum)) {
    throw new Error(`Invalid checksum for address: ${str}`);
  }
  return payload;
}

/**
 * Convert a P2PKH or P2SH address to a scriptPubKey Buffer.
 * Supports bech32 (native segwit lc2... / doge2...) via OP_0 + push.
 */
function addressToScript(address) {
  // Bech32 native segwit (P2WPKH or P2WSH)
  if (/^lc2(1|q)/i.test(address) || /^doge2(1|q)/i.test(address)) {
    // Minimal bech32 decode — extract the witness program bytes
    const sepIdx = address.lastIndexOf('1');
    if (sepIdx < 0) throw new Error(`Bad bech32 address: ${address}`);
    const dataStr = address.slice(sepIdx + 1).toLowerCase();
    const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const data5 = [];
    for (const c of dataStr) {
      const v = BECH32_CHARSET.indexOf(c);
      if (v < 0) throw new Error(`Invalid bech32 char: ${c}`);
      data5.push(v);
    }
    // Convert 5-bit groups back to 8-bit, strip version+checksum
    const witnessVersion = data5[0];
    const converted = [];
    let acc = 0, bits = 0;
    for (const v of data5.slice(1, -6)) {
      acc = (acc << 5) | v;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        converted.push((acc >> bits) & 0xff);
      }
    }
    const prog = Buffer.from(converted);
    // OP_0 <push_len> <witness_program>
    const script = Buffer.alloc(2 + prog.length);
    script[0] = witnessVersion === 0 ? 0x00 : (0x50 + witnessVersion);
    script[1] = prog.length;
    prog.copy(script, 2);
    return script;
  }

  // Legacy base58check
  const payload = base58CheckDecode(address);
  // payload[0] = version byte, payload[1..20] = hash160
  const hash = payload.slice(1, 21);
  const version = payload[0];

  // P2SH (version 5 for BTC/LTC, or 50 for LC2 SCRIPT_ADDRESS2)
  if (version === 5 || version === 50) {
    // OP_HASH160 <hash160> OP_EQUAL
    const script = Buffer.alloc(23);
    script[0] = 0xa9;
    script[1] = 0x14;
    hash.copy(script, 2);
    script[22] = 0x87;
    return script;
  }

  // P2PKH (default for any other version)
  // OP_DUP OP_HASH160 <hash160> OP_EQUALVERIFY OP_CHECKSIG
  const script = Buffer.alloc(25);
  script[0] = 0x76;
  script[1] = 0xa9;
  script[2] = 0x14;
  hash.copy(script, 3);
  script[23] = 0x88;
  script[24] = 0xac;
  return script;
}

// Variable-length integer encoding
function varInt(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

function writeInt32LE(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

function writeUInt32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function writeInt64LE(n) {
  // n is a BigInt
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

// Encode block height per BIP34
function encodeHeight(height) {
  if (height === 0) return Buffer.from([0x01, 0x00]);
  let h = height;
  const bytes = [];
  while (h > 0) {
    bytes.push(h & 0xff);
    h >>= 8;
  }
  // Add sign byte if high bit set
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

// Reverse bytes (for endian conversion of hashes)
function reverseHex(hex) {
  return Buffer.from(hex, 'hex').reverse().toString('hex');
}

// Merkle tree computation from coinbase txid + branches
function merkleRoot(coinbaseTxid, merkleBranches) {
  let root = Buffer.from(coinbaseTxid, 'hex');
  for (const branch of merkleBranches) {
    const branchBuf = Buffer.from(branch, 'hex');
    root = dsha256(Buffer.concat([root, branchBuf]));
  }
  return root.toString('hex');
}

// Target from nBits
function bitsToTarget(bits) {
  const exponent = parseInt(bits, 16) >> 24;
  const coefficient = parseInt(bits, 16) & 0x007fffff;
  const target = BigInt(coefficient) * (2n ** (8n * (BigInt(exponent) - 3n)));
  return target;
}

// Check if hash meets target (hash as little-endian hex)
function hashMeetsTarget(hashHex, targetBigInt) {
  // hash is returned as little-endian from scrypt; reverse to big-endian for comparison
  const hashBE = Buffer.from(hashHex, 'hex').reverse();
  const hashInt = BigInt('0x' + hashBE.toString('hex'));
  return hashInt <= targetBigInt;
}

module.exports = {
  dsha256, sha256, hash160,
  addressToScript, varInt,
  writeInt32LE, writeUInt32LE, writeInt64LE,
  encodeHeight, reverseHex, merkleRoot,
  bitsToTarget, hashMeetsTarget
};
