'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BlockAlertService } = require('../src/block-alert-service');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('captures evidence, posts Discord payload, and suppresses duplicate events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc2-alert-test-'));
  const dataDir = path.join(root, 'data');
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'proxy-out.log'), 'recent proxy evidence\n');
  fs.writeFileSync(path.join(dataDir, 'blocks.json'), '[]');

  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      response.writeHead(204);
      response.end();
    });
  });

  const port = await listen(server);
  try {
    fs.writeFileSync(path.join(dataDir, 'discord-alerts.json'), JSON.stringify({
      enabled: true,
      webhookUrl: `http://127.0.0.1:${port}/webhook`,
      mention: '<@1234>',
      notifyOn: ['accepted', 'orphaned']
    }));

    const details = {
      id: 'lc2_solo1:70001:test',
      poolId: 'lc2_solo1',
      height: 70001,
      hash: 'ab'.repeat(32),
      worker: 'Bitsplease.worker',
      status: 'pending',
      blockHex: '00'.repeat(80)
    };
    const service = new BlockAlertService({ dataDir });

    const first = await service.report('accepted', details);
    assert.equal(first.sent, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].content, '<@1234>');
    assert.match(requests[0].embeds[0].title, /NODE ACCEPTED/);
    assert.equal(fs.existsSync(first.incidentPath), true);
    const incident = JSON.parse(fs.readFileSync(first.incidentPath, 'utf8'));
    assert.equal(incident.details.blockHex, details.blockHex);
    assert.match(incident.runtime.proxyOutputTail, /recent proxy evidence/);

    const afterRestart = new BlockAlertService({ dataDir });
    const duplicate = await afterRestart.report('accepted', details);
    assert.equal(duplicate.duplicate, true);
    assert.equal(requests.length, 1);

    const orphaned = await afterRestart.report('orphaned', { ...details, status: 'orphaned' });
    assert.equal(orphaned.sent, true);
    assert.equal(requests.length, 2);
    assert.match(requests[1].embeds[0].title, /ORPHANED/);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
