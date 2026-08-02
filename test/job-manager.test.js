'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const JobManager = require('../src/job-manager');
const lc2Config = require('../src/config').coins.lc2;
const doge2Config = require('../src/config').coins.doge2;

function template(overrides = {}) {
  return {
    height: 70000,
    version: 0x20000000,
    previousblockhash: '11'.repeat(32),
    coinbasevalue: 5000000000,
    transactions: [],
    bits: '1f00ffff',
    curtime: 1700000000,
    ...overrides
  };
}

function rpcForVersion(version) {
  return {
    getBlockTemplate: async () => template(),
    getBlockchainInfo: async () => ({
      blocks: 69999,
      headers: 69999,
      verificationprogress: 1,
      initialblockdownload: false
    }),
    call: async (method) => {
      if (method === 'getblockcount') return 69999;
      if (method === 'getnetworkinfo') {
        return { version, subversion: `/LitecoinII:${version}/`, connections: 8 };
      }
      if (method === 'getmininginfo') return {};
      if (method === 'getnetworkhashps') return 1;
      if (method === 'getdifficulty') return 1;
      throw new Error(`Unexpected RPC method: ${method}`);
    }
  };
}

test('LC2 pauses mining when daemon predates mandatory LWMA release', async () => {
  const manager = new JobManager(rpcForVersion(210505), lc2Config);

  await manager._poll();

  assert.equal(manager._syncPaused, true);
  assert.equal(manager.currentJob, null);
});

test('LC2 creates work with the mandatory LWMA daemon release', async () => {
  const manager = new JobManager(rpcForVersion(210600), lc2Config);

  await manager._poll();

  assert.equal(manager._syncPaused, false);
  assert.equal(manager.currentJob.height, 70000);
});

test('LC2 accepts only the documented top-level MWEB hex field', () => {
  const manager = new JobManager(rpcForVersion(210600), lc2Config);
  const valid = manager._createJob(template({ mweb: 'aabbccdd' }));
  const nested = manager._createJob(template({ mweb: { data: 'aabbccdd' } }));

  assert.equal(valid.mwebHex, 'aabbccdd');
  assert.equal(nested.mwebHex, '');
});

test('DOGE2 reward metadata matches the post-100000 halving schedule', () => {
  assert.equal(doge2Config.blockReward, 250000);
  assert.equal(doge2Config.rewardSchedule.nextReward, 125000);
  assert.equal(doge2Config.rewardSchedule.halvingHeight, 200000);
});