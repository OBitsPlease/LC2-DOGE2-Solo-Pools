'use strict';

const fs = require('fs');
const net = require('net');

const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 3336);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'americas.mining-dutch.nl';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 8888);
const LOG_FILE = process.env.LOG_FILE || 'stratum-relay-capture.log';

let connId = 0;

function ts() {
  return new Date().toISOString();
}

function append(line) {
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

function parseLines(bufferRef, chunk, onLine) {
  bufferRef.buf += chunk.toString('utf8');
  let idx;
  while ((idx = bufferRef.buf.indexOf('\n')) >= 0) {
    const line = bufferRef.buf.slice(0, idx).replace(/\r$/, '');
    bufferRef.buf = bufferRef.buf.slice(idx + 1);
    if (line.length > 0) onLine(line);
  }
}

const server = net.createServer((downstream) => {
  const id = ++connId;
  const remote = (downstream.remoteAddress || 'unknown') + ':' + (downstream.remotePort || '?');
  append('[' + ts() + '] conn-open id=' + id + ' miner=' + remote);

  const upstream = net.createConnection({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT
  });

  const dBuf = { buf: '' };
  const uBuf = { buf: '' };

  downstream.on('data', (chunk) => {
    upstream.write(chunk);
    parseLines(dBuf, chunk, (line) => {
      append('[' + ts() + '] C->S id=' + id + ' ' + line);
    });
  });

  upstream.on('data', (chunk) => {
    downstream.write(chunk);
    parseLines(uBuf, chunk, (line) => {
      append('[' + ts() + '] S->C id=' + id + ' ' + line);
    });
  });

  const closeBoth = (why) => {
    append('[' + ts() + '] conn-close id=' + id + ' reason=' + why);
    if (!downstream.destroyed) downstream.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };

  downstream.on('error', (e) => closeBoth('downstream-error:' + e.message));
  upstream.on('error', (e) => closeBoth('upstream-error:' + e.message));
  downstream.on('close', () => closeBoth('downstream-close'));
  upstream.on('close', () => closeBoth('upstream-close'));
});

server.on('error', (e) => {
  append('[' + ts() + '] relay-error ' + e.message);
  console.error('relay error:', e.message);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  append('[' + ts() + '] relay-listening ' + LISTEN_HOST + ':' + LISTEN_PORT + ' -> ' + UPSTREAM_HOST + ':' + UPSTREAM_PORT);
  console.log('relay listening on', LISTEN_HOST + ':' + LISTEN_PORT, '->', UPSTREAM_HOST + ':' + UPSTREAM_PORT);
  console.log('logging to', LOG_FILE);
});
