'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const scrypt = require('scryptsy');
const { dsha256 } = require('../src/utils');

test('LC2 tracks the canonical SHA256d block ID separately from scrypt PoW', () => {
  const header = Buffer.from(
    '00000020852da39f4e93d561a154f4d3749f819fd3c52a26cfdd548f2cc1eea5' +
    '31d0a752c427b5c6e3e471f1a555196fc4da668c98114f82379a0109a41b5b69' +
    '60b9bf07cd146e6a4b78021b7f0d16bc',
    'hex'
  );

  const canonicalBlockId = Buffer.from(dsha256(header)).reverse().toString('hex');
  const powHash = Buffer.from(scrypt(header, header, 1024, 1, 1, 32)).reverse().toString('hex');

  assert.equal(canonicalBlockId, '4c8f693a04bb92621b2c77a6c31e31d712348a575907010b51094378bfbc86e2');
  assert.equal(powHash, '00000000000138958db99c85799120472f4d4ea7d2cdd4c6dc6cef63484a0e97');
  assert.notEqual(canonicalBlockId, powHash);
});