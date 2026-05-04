'use strict';

const fs = require('fs');
const path = require('path');

function getRuntimeRoot() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'LC2 DOGE2 Solo Miner');
  }
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'LC2 DOGE2 Solo Miner');
  }
  return path.resolve(__dirname, '..');
}

function getDiagnosticLogPath() {
  return path.join(getRuntimeRoot(), 'logs', 'multi-asic-diagnostic.log');
}

function writeDiagnosticLog(message, context = null) {
  try {
    const logPath = getDiagnosticLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    let line = `[${new Date().toISOString()}] ${message}`;
    if (context && typeof context === 'object') {
      line += ` | ${JSON.stringify(context)}`;
    }

    fs.appendFileSync(logPath, line + '\n');
  } catch (_) {
    // Never let diagnostics break mining runtime.
  }
}

module.exports = {
  getDiagnosticLogPath,
  writeDiagnosticLog
};
