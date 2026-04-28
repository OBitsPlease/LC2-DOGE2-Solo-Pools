'use strict';

const http = require('http');
const fs = require('fs');

class RPCClient {
  constructor({ host, port, user, password, gbtRules, cookieFile }) {
    this.host = host;
    this.port = port;
    this.auth = Buffer.from(`${user}:${password}`).toString('base64');
    this.cookieFile = cookieFile || null;
    this._id = 1;
    // Per-coin getblocktemplate rules. LC2 (LTC 0.21) needs mweb; DOGE2 does not.
    this._gbtRules = gbtRules || ['segwit'];
  }

  _readCookieAuth() {
    if (!this.cookieFile) return null;
    if (!fs.existsSync(this.cookieFile)) return null;

    const cookie = fs.readFileSync(this.cookieFile, 'utf8').trim();
    if (!cookie || !cookie.includes(':')) return null;
    return Buffer.from(cookie).toString('base64');
  }

  _doRpcCall(body, authHeaderValue, allowCookieRetry) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.host,
        port: this.port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Basic ${authHeaderValue}`
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401 && allowCookieRetry) {
            const cookieAuth = this._readCookieAuth();
            if (cookieAuth && cookieAuth !== authHeaderValue) {
              return resolve(this._doRpcCall(body, cookieAuth, false));
            }
          }

          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`RPC HTTP ${res.statusCode} — response: ${data.slice(0, 200)}`));
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(`RPC error ${parsed.error.code}: ${parsed.error.message}`));
            } else {
              resolve(parsed.result);
            }
          } catch (e) {
            reject(new Error(`RPC parse error: ${e.message} — response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('RPC timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  call(method, params = []) {
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: this._id++,
      method,
      params
    });

    return this._doRpcCall(body, this.auth, true).catch(err => {
      if (err.message === 'RPC timeout') {
        throw new Error(`RPC timeout calling ${method}`);
      }
      throw err;
    });
  }

  async getBlockTemplate(capabilities = ['coinbasetxn', 'workid', 'coinbase/append']) {
    return this.call('getblocktemplate', [{ capabilities, rules: this._gbtRules }]);
  }

  async submitBlock(hexData) {
    return this.call('submitblock', [hexData]);
  }

  async getBlockCount() {
    return this.call('getblockcount', []);
  }

  async getMiningInfo() {
    return this.call('getmininginfo', []);
  }

  /**
   * Get or create a wallet address labelled with workerName.
   * Tries the modern API first (getaddressesbylabel), falls back to
   * legacy account API (getaccountaddress) for older Dogecoin-based daemons.
   * On the very first call for a new label, getnewaddress is used to create one.
   */
  async getOrCreateWorkerAddress(workerName) {
    // 1. Try modern label API (Bitcoin Core ≥ 0.17, Litecoin ≥ 0.18)
    try {
      const result = await this.call('getaddressesbylabel', [workerName]);
      const addrs = Object.keys(result || {});
      if (addrs.length > 0) return addrs[0];
    } catch (e) {
      // code -11 = label not found; other codes = API not supported
      if (e.message && !e.message.includes('-11')) {
        // Try legacy Dogecoin account API
        try {
          return await this.call('getaccountaddress', [workerName]);
        } catch (_) {}
      }
    }
    // 2. Create a new labelled address
    return this.call('getnewaddress', [workerName]);
  }

  async getWalletBalance() {
    return this.call('getbalance', []);
  }

  async getNetworkInfo() {
    return this.call('getnetworkinfo', []);
  }
}

module.exports = RPCClient;
