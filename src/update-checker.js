'use strict';

/**
 * update-checker.js
 * Polls GitHub Releases for daemon updates, tracks installed versions,
 * and writes update requests that the watchdog fulfils.
 */

const https = require('https');
const path  = require('path');
const fs    = require('fs');
const ds    = require('./data-store');

// Cache GitHub API responses for 1 hour
const CACHE_TTL_MS = 60 * 60 * 1000;
const _cache = new Map(); // coinId -> { ts, data }

// ─── Installed-version tracking ──────────────────────────────────────────────

function versionsFile() {
  return path.join(ds.getDataDir(), 'installed-versions.json');
}

function loadInstalledVersions() {
  try {
    const f = versionsFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {}
  return {};
}

function saveInstalledVersion(coinId, version) {
  const f = versionsFile();
  const existing = loadInstalledVersions();
  existing[coinId] = version;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(existing, null, 2));
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

function fetchGitHubLatest(githubRepo) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${githubRepo}/releases/latest`,
      method:   'GET',
      headers:  { 'User-Agent': 'lc2-doge2-solo-miner/1.0', 'Accept': 'application/vnd.github+json' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 404) return reject(new Error('GitHub repo not found or no releases'));
        if (res.statusCode !== 200) return reject(new Error(`GitHub API returned ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('GitHub API request timed out')); });
    req.end();
  });
}

// ─── Per-coin check ──────────────────────────────────────────────────────────

async function checkCoin(coinId, coinCfg) {
  const updateCfg = coinCfg.daemonUpdate;
  if (!updateCfg || !updateCfg.githubRepo) {
    return { coinId, updateAvailable: false, reason: 'no update config', checking: false };
  }

  // Return cached result if still fresh
  const cached = _cache.get(coinId);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

  const installed     = loadInstalledVersions();
  const currentVersion = installed[coinId] || updateCfg.installedVersion || 'unknown';

  let result;
  try {
    const release = await fetchGitHubLatest(updateCfg.githubRepo);
    const latestVersion = (release.tag_name || release.name || '').replace(/^v/, '').trim();

    // Match the Windows 64-bit zip asset using the configured pattern
    const pat   = updateCfg.assetPattern ? new RegExp(updateCfg.assetPattern, 'i') : /windows.{0,10}64.{0,30}\.zip$/i;
    const asset = (release.assets || []).find(a => pat.test(a.name));

    // Simple version comparison — treat unknown as "old"
    const updateAvailable = latestVersion && latestVersion !== currentVersion;

    result = {
      coinId,
      currentVersion,
      latestVersion,
      updateAvailable: updateAvailable && !!asset,
      assetUrl:  asset ? asset.browser_download_url : null,
      assetName: asset ? asset.name                 : null,
      releaseNotes: (release.body || '').slice(0, 600),
      publishedAt:  release.published_at || null,
      checking: false,
      reason: asset ? null : 'no windows asset found in release'
    };
  } catch (err) {
    result = {
      coinId,
      currentVersion,
      latestVersion:   null,
      updateAvailable: false,
      assetUrl:        null,
      assetName:       null,
      checking: false,
      reason: err.message
    };
  }

  _cache.set(coinId, { ts: Date.now(), data: result });
  return result;
}

// ─── Check all enabled coins ──────────────────────────────────────────────────

async function getUpdateStatus(coinsConfig) {
  const results = {};
  for (const [coinId, cfg] of Object.entries(coinsConfig)) {
    if (!cfg.enabled) continue;
    if (!cfg.daemonUpdate) {
      results[coinId] = { coinId, updateAvailable: false, reason: 'no update config', checking: false };
      continue;
    }
    results[coinId] = await checkCoin(coinId, cfg);
  }
  return results;
}

// ─── Trigger an update (writes request file for watchdog to handle) ───────────

function triggerUpdate(coinId, assetUrl, assetName, targetVersion) {
  const requestPath = path.join(ds.getDataDir(), 'update-request.json');
  const request = {
    coinId,
    assetUrl,
    assetName,
    targetVersion,
    requestedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  return request;
}

// ─── Read watchdog's progress on a pending update ────────────────────────────

function getUpdateProgress() {
  const requestPath = path.join(ds.getDataDir(), 'update-request.json');
  const statusPath  = path.join(ds.getDataDir(), 'update-status.json');
  let pendingRequest = null;
  let updateStatus   = null;
  try { if (fs.existsSync(requestPath)) pendingRequest = JSON.parse(fs.readFileSync(requestPath, 'utf8')); } catch (_) {}
  try { if (fs.existsSync(statusPath))  updateStatus   = JSON.parse(fs.readFileSync(statusPath,  'utf8')); } catch (_) {}
  return { pendingRequest, updateStatus };
}

// ─── Invalidate cache after an update completes ───────────────────────────────

function invalidateCache(coinId) {
  _cache.delete(coinId);
}

module.exports = { getUpdateStatus, triggerUpdate, getUpdateProgress, saveInstalledVersion, invalidateCache };
