'use strict';

const EventEmitter = require('events');
const { buildCoinbaseSplit, coinbaseTxid, EXTRA_NONCE_1_LEN } = require('./coinbase-builder');
const { dsha256, reverseHex, merkleRoot, buildCoinbaseMerkleBranches, bitsToTarget } = require('./utils');
const { buildAuxHeader, computeAuxHash, buildMergedMiningCommitment, buildAuxPowBlock } = require('./auxpow-builder');
const { writeDiagnosticLog } = require('./diagnostic-logger');

// cgminer applies flip32 (per-4-byte-word byte-reversal) to the prevhash received in
// mining.notify before writing it into the block header. We must send the prevhash
// pre-flipped so that flip32(flip32(prevHashReversed)) = prevHashReversed lands in the header.
function flip32Hex(hexStr) {
  let out = '';
  for (let i = 0; i < 64; i += 8)
    out += hexStr.slice(i, i + 8).match(/.{2}/g).reverse().join('');
  return out;
}

// Scrypt diff-1 reference target used by Litecoin ASICs and all major scrypt pool software.
// This is 65,536x easier than Bitcoin's diff-1 ('1d00ffff') — using the wrong one causes
// 100% share rejection because virtually no scrypt shares meet the Bitcoin difficulty reference.
// Value: 0x0000ffff0000...0000 (64 hex chars, 32 bytes)
const SHARE_DIFF1_TARGET = bitsToTarget('1f00ffff');

function extractMwebHex(template) {
  const isHexBytes = (value) => (
    typeof value === 'string' &&
    value.length > 0 &&
    (value.length % 2) === 0 &&
    /^[0-9a-fA-F]+$/.test(value)
  );

  const pickBestHex = (candidates) => {
    const unique = [...new Set(candidates.filter(isHexBytes))];
    if (!unique.length) return '';
    // Prefer the longest payload. Hash-like fields are typically 64 hex chars,
    // while serialized MWEB extension data is much longer.
    unique.sort((a, b) => b.length - a.length);
    return unique[0];
  };

  const collectHexStringsDeep = (obj, out = [], depth = 0) => {
    if (!obj || depth > 5) return out;
    if (typeof obj === 'string') {
      if (isHexBytes(obj)) out.push(obj);
      return out;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) collectHexStringsDeep(item, out, depth + 1);
      return out;
    }
    if (typeof obj === 'object') {
      for (const value of Object.values(obj)) collectHexStringsDeep(value, out, depth + 1);
    }
    return out;
  };

  // Known daemon field shapes first.
  const directCandidates = [
    template?.mweb,
    template?.mwebhex,
    template?.mweb_extension,
    template?.mweb?.data,
    template?.mweb?.hex,
    template?.mweb?.block,
    template?.mweb?.extension,
    template?.mweb?.payload,
    template?.mweb?.serialized,
    template?.mweb?.bytes
  ];

  const direct = pickBestHex(directCandidates);
  if (direct) return direct;

  // Last-resort deep scan for wallet/daemon variants that nest mweb payloads.
  return pickBestHex(collectHexStringsDeep(template?.mweb || null));
}

/**
 * JobManager polls getblocktemplate from the coin daemon,
 * creates stratum jobs, and exposes them to the StratumServer.
 */
class JobManager extends EventEmitter {
  constructor(rpcClient, coinConfig) {
    super();
    this.rpc = rpcClient;
    this.coin = coinConfig;
    this.currentJob = null;
    this.jobs = new Map();
    // Seed job counter from timestamp so restarts don't reuse old job IDs
    this._jobCounter = Math.floor(Date.now() / 1000) & 0xffffff;
    this._pollTimer = null;
    this._lastBlockHash = null;
    this._shareCount = 0;
    this._shareWindow = []; // { ts, diff } for hashrate estimation
    this._networkInfo = {};
    this._daemonUp = false;
    this._daemonLastError = null;
    this._daemonLastOkAt = null;
    this._lastTemplate = null;
    // Merge mining: set when this chain is the PARENT (LC2)
    this._auxJobMgr = null;         // DOGE2 JobManager instance
    this._currentAuxData = null;    // latest DOGE2 template + header bytes
    this._lastAuxBlockHash = null;  // detect DOGE2 block changes
    this._auxCandidates = 0;
    this._auxSubmits = 0;
    this._auxAccepted = 0;
    this._auxRejected = 0;
    this._auxErrors = 0;
    this._lowDiffDiagCounter = 0;
    // Allow opt-in compatibility acceptance for ASIC firmware byte-order variants.
    this._scryptCompatFallback = this.coin.symbol === 'LC2' && this.coin.scryptCompatFallback !== false;
    // Merge mining: set when this chain is the AUX (DOGE2)
    this._parentJobMgr = null;      // LC2 JobManager instance (for hashrate passthrough)
  }

  start() {
    this._poll();
    // Poll every 5 seconds for new blocks
    this._pollTimer = setInterval(() => this._poll(), 5000);
    console.log(`[${this.coin.symbol}] JobManager started, polling every 5s`);
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Wire up this manager (LC2) as the parent for merged mining.
   * Call this after DOGE2 is also started.
   */
  setAuxJobManager(auxJobMgr) {
    this._auxJobMgr = auxJobMgr;
    auxJobMgr._parentJobMgr = this;
    console.log(`[${this.coin.symbol}] AuxPoW merge mining enabled → ${auxJobMgr.coin.symbol}`);
  }

  /**
   * Build the current DOGE2 job data needed for merged mining.
   * Called by the LC2 JobManager during every poll.
   */
  async getAuxData() {
    const { coinbaseTxid: calcCbTxid, buildFullCoinbaseTx } = require('./coinbase-builder');
    const template = await this.rpc.getBlockTemplate();

    // DOGE2 coinbase uses fixed zero extranonces — DOGE2 has no stratum miners
    const { coinb1, coinb2 } = buildCoinbaseSplit({
      blockHeight:   template.height,
      coinbaseValue: template.coinbasevalue,
      minerAddress:  this.coin.miningAddress,
      symbol:        this.coin.symbol
    });
    const ZERO_EN1 = '00000000';
    const ZERO_EN2 = '00000000';
    const cbTxidNatural = calcCbTxid(coinb1, ZERO_EN1, ZERO_EN2, coinb2);
    const fullCoinbaseTxHex = buildFullCoinbaseTx(coinb1, ZERO_EN1, ZERO_EN2, coinb2);

    // DOGE2 merkle root from the actual coinbase proof path, not the full tx list.
    // buildCoinbaseMerkleBranches returns internal-order branches.
    const txHashesDisplay = template.transactions.map(tx => tx.txid || tx.hash);
    const txMerkleBranchesInternal = buildCoinbaseMerkleBranches(txHashesDisplay);
    const mRoot = merkleRoot(cbTxidNatural, txMerkleBranchesInternal);

    // Build the DOGE2 block header (80 bytes, AuxPoW version bit set, nonce=0)
    const headerBytes = buildAuxHeader({
      version:      template.version,
      prevhash:     template.previousblockhash,
      merkleRootHex: mRoot,
      curtime:      template.curtime,
      bits:         template.bits
    });

    // SHA256d of DOGE2 header = the hash embedded in the LC2 coinbase
    const auxHash = computeAuxHash(headerBytes); // 32 bytes, MSB-first

    return {
      template,
      headerBytes,
      coinbaseTxHex: fullCoinbaseTxHex,
      auxHash,
      target: bitsToTarget(template.bits)
    };
  }

  async _poll() {
    try {
      let template = null;
      try {
        template = await this.rpc.getBlockTemplate();
      } catch (err) {
        // Keep polling telemetry even if template is temporarily unavailable.
        template = null;
      }

      // Fetch network/sync telemetry for dashboard status.
      // Use a dedicated unmasked health probe so _daemonUp is reliable.
      try {
        await this.rpc.call('getblockcount');
        this._daemonUp = true;
        this._daemonLastOkAt = Date.now();
        this._daemonLastError = null;
      } catch (healthErr) {
        this._daemonUp = false;
        this._daemonLastError = healthErr.message;
      }

      try {
        const [miningInfo, netInfo, chainInfo, directNetworkHashps, directDifficulty] = await Promise.all([
          this.rpc.call('getmininginfo').catch(() => ({})),
          this.rpc.call('getnetworkinfo').catch(() => ({})),
          this.rpc.getBlockchainInfo().catch(() => ({})),
          this.rpc.call('getnetworkhashps').catch(() => null),
          this.rpc.call('getdifficulty').catch(() => null)
        ]);

        const asNumber = (v) => {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        };

        const blocks = Number.isFinite(chainInfo.blocks) ? chainInfo.blocks : null;
        const headers = Number.isFinite(chainInfo.headers) ? chainInfo.headers : null;
        const blocksBehind = (blocks !== null && headers !== null)
          ? Math.max(0, headers - blocks)
          : null;

        const networkHashrate =
          asNumber(miningInfo.networkhashps) ||
          asNumber(directNetworkHashps) ||
          asNumber(chainInfo.networkhashps);

        const networkDifficulty =
          asNumber(template?.difficulty) ||
          asNumber(chainInfo.difficulty) ||
          asNumber(miningInfo.difficulty) ||
          asNumber(directDifficulty);

        this._networkInfo = {
          networkHashrate,
          blockHeight:       template?.height || blocks || this.currentJob?.height || 0,
          networkDifficulty,
          connectedPeers:    netInfo.connections || 0,
          headers:           headers || 0,
          verificationProgress: typeof chainInfo.verificationprogress === 'number' ? chainInfo.verificationprogress : 0,
          initialBlockDownload: !!chainInfo.initialblockdownload,
          blocksBehind:      blocksBehind
        };
        if (this.currentJob) Object.assign(this.currentJob, this._networkInfo);
      } catch (_) {}

      if (!template) return;

      const newBlockHash = template.previousblockhash;
      const isNewBlock = newBlockHash !== this._lastBlockHash;

      // Check if the aux chain (DOGE2) has a new block
      let isNewAuxBlock = false;
      if (this._auxJobMgr) {
        try {
          const auxData = await this._auxJobMgr.getAuxData();
          this._currentAuxData = auxData;
          const auxBlockHash = auxData.template.previousblockhash;
          if (auxBlockHash !== this._lastAuxBlockHash) {
            this._lastAuxBlockHash = auxBlockHash;
            isNewAuxBlock = true;
          }
        } catch (err) {
          console.error(`[${this.coin.symbol}] AuxPoW data fetch failed: ${err.message}`);
        }
      }

      if (isNewBlock || isNewAuxBlock) {
        this._lastBlockHash = newBlockHash;
        const job = this._createJob(template, null, this._currentAuxData);
        Object.assign(job, this._networkInfo);
        this._lastTemplate = template;
        this.currentJob = job;
        this.jobs.set(job.id, job);
        if (this.jobs.size > 32) {
          const oldest = this.jobs.keys().next().value;
          this.jobs.delete(oldest);
        }
        const reason = isNewBlock ? `height ${template.height}` : `DOGE2 block ${this._currentAuxData?.template?.height}`;
        // Only force clean (discard old work) on real LC2 block changes.
        // DOGE2 aux-only changes just update the commitment — let miners finish current nonce range.
        this.emit('newJob', job, isNewBlock);
        console.log(`[${this.coin.symbol}] New job ${job.id} (${reason})`);
      }
    } catch (err) {
      this._daemonUp = false;
      this._daemonLastError = err.message;
      console.error(`[${this.coin.symbol}] job poll failed: ${err.message}`);
    }
  }

  _createJob(template, minerAddress, auxData = null) {
    const id = (++this._jobCounter).toString(16).padStart(8, '0');
    const address = minerAddress || this.coin.miningAddress;

    // Build merged mining commitment if this pool has an aux chain wired up
    const auxCommitment = auxData
      ? buildMergedMiningCommitment(auxData.auxHash)
      : null;

    const { coinb1, coinb2 } = buildCoinbaseSplit({
      blockHeight:   template.height,
      coinbaseValue: template.coinbasevalue,
      minerAddress:  address,
      symbol:        this.coin.symbol,
      auxCommitment,
      defaultWitnessCommitmentHex: template.default_witness_commitment || null
    });

    // Compute the real coinbase merkle proof path (not raw tx hash list).
    const txHashesDisplay = template.transactions.map(tx => tx.txid || tx.hash);
    const merkleBranches = buildCoinbaseMerkleBranches(txHashesDisplay);

    // prevhash bytes are reversed for stratum
    const prevHashReversed = reverseHex(template.previousblockhash);

    return {
      id,
      template,
      coinb1,
      coinb2,
      merkleBranches,
      prevHashReversed,
      version: template.version.toString(16).padStart(8, '0'),
      nbits: template.bits,
      ntime: template.curtime.toString(16).padStart(8, '0'),
      target: bitsToTarget(template.bits),
      height: template.height,
      auxData,  // null unless merge mining is active
      defaultWitnessCommitment: template.default_witness_commitment || null,
      mwebHex: extractMwebHex(template)
    };
  }

  /**
   * Build a personalised job for a specific miner address.
   * Called when a miner authorises (to give them their own coinbase).
   */
  createJobForMiner(minerAddress) {
    const template = this._lastTemplate || this.currentJob?.template;
    if (!template) return null;
    const job = this._createJob(template, minerAddress, this._currentAuxData);
    Object.assign(job, this._networkInfo);
    // Store in jobs map so shares can be validated
    this.jobs.set(job.id, job);
    if (this.jobs.size > 64) {
      const oldest = this.jobs.keys().next().value;
      this.jobs.delete(oldest);
    }
    return job;
  }

  /**
   * Returns the stratum notify params array for a job.
   */
  getNotifyParams(job, cleanJobs = false) {
    return [
      job.id,
      flip32Hex(job.prevHashReversed),
      job.coinb1,
      job.coinb2,
      job.merkleBranches,
      job.version,
      job.nbits,
      job.ntime,
      cleanJobs
    ];
  }

  getPoolHashrate() {
    // If this chain is merge-mined by a parent (e.g. DOGE2 via LC2), use the parent's hashrate
    if (this._parentJobMgr) return this._parentJobMgr.getPoolHashrate();

    // Scrypt diff-1 constant: 65536 (2^16) matches the 0x0000ffff... share reference used by ASIC firmware.
    // Formula: hashrate = sum(share_difficulties) * SCRYPT_DIFF1 / window_seconds
    const SCRYPT_DIFF1 = 65536; // 2^16
    const now = Date.now();
    this._shareWindow = this._shareWindow.filter(s => now - s.ts < 30000);
    const totalDiff = this._shareWindow.reduce((sum, s) => sum + s.diff, 0);
    return (totalDiff * SCRYPT_DIFF1) / 30;
  }

  _recordShare(diff = 1) {
    this._shareWindow.push({ ts: Date.now(), diff });
  }

  /**
   * Validate a submitted share and, if it meets the network target, build the
   * full block hex for submission to the daemon.
   *
   * Returns: { valid: bool, meetsDifficulty: bool, blockHex?: string, error?: string }
   */
  processShare(jobId, extraNonce1Hex, extraNonce2Hex, ntime, nonce, workerName, sharesDiff = 1, submittedVersion = null) {
    const job = this.jobs.get(jobId);
    if (!job) {
      const knownIds = [...this.jobs.keys()].join(', ');
      console.log(`[${this.coin.symbol}] Job not found: submitted="${jobId}" known=[${knownIds}]`);
      return { valid: false, error: 'Job not found' };
    }

    // Reconstruct the full coinbase txid (natural = internal byte order, no reversal)
    const cbTxidNatural = coinbaseTxid(job.coinb1, extraNonce1Hex, extraNonce2Hex, job.coinb2);

    // Merkle root: natural cbTxid + internal-order branches from job notify data.
    const mRoot = merkleRoot(cbTxidNatural, job.merkleBranches);

    // Miner may send a rolled version (6th mining.submit param). Use it when valid.
    const headerVersionHex = (typeof submittedVersion === 'string' && /^[0-9a-fA-F]{8}$/.test(submittedVersion))
      ? submittedVersion.toLowerCase()
      : job.version;

    // Build 80-byte block header (all fields in wire/little-endian byte order)
    const header = Buffer.concat([
      Buffer.from(headerVersionHex, 'hex').reverse(),   // version LE
      Buffer.from(job.prevHashReversed, 'hex'),     // prevhash (already in wire order)
      Buffer.from(mRoot, 'hex'),                    // merkle root (internal byte order)
      Buffer.from(ntime, 'hex').reverse(),          // ntime LE
      Buffer.from(job.nbits, 'hex').reverse(),      // nbits LE
      Buffer.from(nonce, 'hex').reverse()           // nonce LE
    ]);

    // Compute scrypt hash
    let hashHex;
    try {
      const scrypt = require('scryptsy');
      const hash = scrypt(header, header, 1024, 1, 1, 32);
      hashHex = hash.toString('hex');
    } catch (e) {
      return { valid: false, error: `Scrypt error: ${e.message}` };
    }

    const normalizedShareDiff = Math.max(1, Math.trunc(Number(sharesDiff) || 1));
    const shareTarget = SHARE_DIFF1_TARGET / BigInt(normalizedShareDiff);

    // Check if hash meets client share difficulty first.
    const hashBigInt = BigInt('0x' + Buffer.from(hashHex, 'hex').reverse().toString('hex'));
    const hashBigIntNoReverse = BigInt('0x' + hashHex);
    const meetsShareDifficulty = hashBigInt <= shareTarget;
    const meetsShareDifficultyNoReverse = hashBigIntNoReverse <= shareTarget;
    const meetsDifficulty = hashBigInt <= job.target;

    if (!meetsShareDifficulty) {
      this._lowDiffDiagCounter++;
      const runDeepDiagnostics = (this._lowDiffDiagCounter % 25) === 1;
      let variantPass = null;
      let variantHashHex = null;
      let closestVariant = null;
      let closestVariantHashHex = null;
      try {
        const scrypt = require('scryptsy');

        const variantResults = [];
        const evaluateVariant = (name, headerBuf) => {
          const hash = scrypt(headerBuf, headerBuf, 1024, 1, 1, 32).toString('hex');
          const hashInt = BigInt('0x' + Buffer.from(hash, 'hex').reverse().toString('hex'));
          variantResults.push({ name, hash, hashInt });
          if (!variantPass && hashInt <= shareTarget) {
            variantPass = name;
            variantHashHex = hash;
          }
        };

        evaluateVariant('baseline', header);

        // Variant 1: extraNonce2 interpreted in reverse byte order inside coinbase
        const cbTxidEn2Reversed = coinbaseTxid(job.coinb1, extraNonce1Hex, reverseHex(extraNonce2Hex), job.coinb2);
        const altMRootEn2Reversed = merkleRoot(cbTxidEn2Reversed, job.merkleBranches);
        const altHeaderEn2Reversed = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(altMRootEn2Reversed, 'hex'),
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('extranonce2-reversed', altHeaderEn2Reversed);

        // Variant 1b: both extraNonce1 and extraNonce2 interpreted in reverse byte order
        const cbTxidEn1En2Reversed = coinbaseTxid(job.coinb1, reverseHex(extraNonce1Hex), reverseHex(extraNonce2Hex), job.coinb2);
        const altMRootEn1En2Reversed = merkleRoot(cbTxidEn1En2Reversed, job.merkleBranches);
        const altHeaderEn1En2Reversed = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(altMRootEn1En2Reversed, 'hex'),
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('extranonce1-extranonce2-reversed', altHeaderEn1En2Reversed);

        const altHeaderReversedMerkle = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(mRoot, 'hex').reverse(),
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('reversed-merkle-header', altHeaderReversedMerkle);

        // Variant 3: nonce NOT reversed (ASIC may submit nonce in LE wire format already)
        const altHeaderNoNonceRev = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(mRoot, 'hex'),
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex')   // NOT reversed
        ]);
        evaluateVariant('no-nonce-reverse', altHeaderNoNonceRev);

        // Variant 4: ntime NOT reversed
        const altHeaderNoNtimeRev = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(mRoot, 'hex'),
          Buffer.from(ntime, 'hex'),   // NOT reversed
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('no-ntime-reverse', altHeaderNoNtimeRev);

        // Variant 5: neither nonce nor ntime reversed
        const altHeaderNoNonceNoNtime = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(mRoot, 'hex'),
          Buffer.from(ntime, 'hex'),   // NOT reversed
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex')    // NOT reversed
        ]);
        evaluateVariant('no-nonce-no-ntime-reverse', altHeaderNoNonceNoNtime);

        // Variant 6: word-swap prevhash (each 4-byte group reversed) instead of full reversal
        const prevHashWS = Buffer.from(job.prevHashReversed, 'hex');
        for (let i = 0; i < 32; i += 4) prevHashWS.slice(i, i + 4).reverse();
        const altHeaderWordSwap = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          prevHashWS,
          Buffer.from(mRoot, 'hex'),
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('prevhash-word-swap', altHeaderWordSwap);

        // Variant 7: merkle root word-swapped (cgminer flip32 style)
        const mRootWS = Buffer.from(mRoot, 'hex');
        for (let i = 0; i < 32; i += 4) mRootWS.slice(i, i + 4).reverse();
        const altHeaderMerkleWordSwap = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          mRootWS,
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('merkle-word-swap', altHeaderMerkleWordSwap);

        // Variant 8: merkle word-swapped + nonce NOT reversed
        const mRootWSNoNonce = Buffer.from(mRoot, 'hex');
        for (let i = 0; i < 32; i += 4) mRootWSNoNonce.slice(i, i + 4).reverse();
        const altHeaderMerkleWordSwapNoNonce = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex').reverse(),
          Buffer.from(job.prevHashReversed, 'hex'),
          mRootWSNoNonce,
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex')
        ]);
        evaluateVariant('merkle-word-swap-no-nonce-reverse', altHeaderMerkleWordSwapNoNonce);

        // Variant 9: previous hash in natural byte order (no reversal)
        if (typeof job.template?.previousblockhash === 'string' && /^[0-9a-fA-F]{64}$/.test(job.template.previousblockhash)) {
          const altHeaderPrevHashNatural = Buffer.concat([
            Buffer.from(headerVersionHex, 'hex').reverse(),
            Buffer.from(job.template.previousblockhash, 'hex'),
            Buffer.from(mRoot, 'hex'),
            Buffer.from(ntime, 'hex').reverse(),
            Buffer.from(job.nbits, 'hex').reverse(),
            Buffer.from(nonce, 'hex').reverse()
          ]);
          evaluateVariant('prevhash-natural-order', altHeaderPrevHashNatural);
        }

        // Variant 10: version in natural byte order (no reversal)
        const altHeaderVersionNatural = Buffer.concat([
          Buffer.from(headerVersionHex, 'hex'),
          Buffer.from(job.prevHashReversed, 'hex'),
          Buffer.from(mRoot, 'hex'),
          Buffer.from(ntime, 'hex').reverse(),
          Buffer.from(job.nbits, 'hex').reverse(),
          Buffer.from(nonce, 'hex').reverse()
        ]);
        evaluateVariant('version-natural-order', altHeaderVersionNatural);

        if (runDeepDiagnostics) {
          const reverseBranchBytes = (arr) => arr.map(b => reverseHex(b));
          const reverseBranchOrder = (arr) => [...arr].reverse();
          const comboBranches = [
            { name: 'merkle-branches-byte-reversed', branches: reverseBranchBytes(job.merkleBranches) },
            { name: 'merkle-branches-order-reversed', branches: reverseBranchOrder(job.merkleBranches) },
            { name: 'merkle-branches-order-and-byte-reversed', branches: reverseBranchBytes(reverseBranchOrder(job.merkleBranches)) }
          ];

          for (const combo of comboBranches) {
            const comboMerkle = merkleRoot(cbTxidNatural, combo.branches);
            const comboHeader = Buffer.concat([
              Buffer.from(headerVersionHex, 'hex').reverse(),
              Buffer.from(job.prevHashReversed, 'hex'),
              Buffer.from(comboMerkle, 'hex'),
              Buffer.from(ntime, 'hex').reverse(),
              Buffer.from(job.nbits, 'hex').reverse(),
              Buffer.from(nonce, 'hex').reverse()
            ]);
            evaluateVariant(combo.name, comboHeader);

            const comboHeaderNoNonceRev = Buffer.concat([
              Buffer.from(headerVersionHex, 'hex').reverse(),
              Buffer.from(job.prevHashReversed, 'hex'),
              Buffer.from(comboMerkle, 'hex'),
              Buffer.from(ntime, 'hex').reverse(),
              Buffer.from(job.nbits, 'hex').reverse(),
              Buffer.from(nonce, 'hex')
            ]);
            evaluateVariant(`${combo.name}-no-nonce-reverse`, comboHeaderNoNonceRev);
          }
        }

        if (variantResults.length > 0) {
          const closest = variantResults.reduce((best, current) => {
            if (!best) return current;
            return current.hashInt < best.hashInt ? current : best;
          }, null);
          if (closest) {
            closestVariant = closest.name;
            closestVariantHashHex = closest.hash;
          }
        }
      } catch {
        // Best-effort diagnostics only.
      }

      if (this._scryptCompatFallback && variantPass) {
        writeDiagnosticLog('compat-share-accepted', {
          symbol: this.coin.symbol,
          workerName,
          variantPass,
          closestVariant,
          shareDiff: normalizedShareDiff,
          jobId,
          height: job.height || null
        });
        this._recordShare(normalizedShareDiff);
        return {
          valid: true,
          meetsDifficulty: false,
          hashHex: variantHashHex || hashHex,
          diag: {
            compatAccepted: true,
            compatVariant: variantPass,
            closestVariant,
            closestVariantHashHex,
            runDeepDiagnostics,
            meetsShareDifficultyNoReverse,
            variantPass,
            variantHashHex,
            headerHex: header.toString('hex'),
            extraNonce1: extraNonce1Hex
          }
        };
      }

      return {
        valid: false,
        error: 'Low difficulty share',
        hashHex,
        diag: {
          runDeepDiagnostics,
          meetsShareDifficultyNoReverse,
          variantPass,
          variantHashHex,
          closestVariant,
          closestVariantHashHex,
          headerHex: header.toString('hex'),
          extraNonce1: extraNonce1Hex
        }
      };
    }

    // Check DOGE2 AuxPoW merge mining (same Scrypt hash, checked against DOGE2 target)
    if (job.auxData) {
      if (hashBigInt <= job.auxData.target && hashBigIntNoReverse > job.auxData.target) {
        writeDiagnosticLog('aux-candidate-endian-warning', {
          aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
          height: job.auxData?.template?.height || null,
          hashLE: hashBigInt.toString(16).padStart(64, '0'),
          hashBE: hashBigIntNoReverse.toString(16).padStart(64, '0'),
          target: job.auxData.target.toString(16).padStart(64, '0'),
          bits: job.auxData?.template?.bits || null
        });
      }
      if (hashBigInt <= job.auxData.target) {
        this._auxCandidates++;
        writeDiagnosticLog('aux-candidate-hit', {
          parent: this.coin.symbol,
          aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
          workerName,
          height: job.auxData?.template?.height || null,
          parentHeight: job.height || null,
          candidates: this._auxCandidates,
          shareDiff: sharesDiff || 1
        });
        this._submitAuxBlock(job, extraNonce1Hex, extraNonce2Hex, header, workerName).catch(err => {
          this._auxErrors++;
          writeDiagnosticLog('aux-submit-exception', {
            aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
            height: job.auxData?.template?.height || null,
            errors: this._auxErrors,
            error: err.message
          });
          console.error(`[DOGE2] AuxPoW submit failed: ${err.message}`);
        });
      }
    }

    if (meetsDifficulty) {
      // Build full block for submission
      const blockHex = this._buildBlockHex(job, extraNonce1Hex, extraNonce2Hex, header);
      this._recordShare(normalizedShareDiff);
      return { valid: true, meetsDifficulty: true, blockHex, hashHex };
    }

    this._recordShare(normalizedShareDiff);
    return { valid: true, meetsDifficulty: false, hashHex };
  }

  _buildBlockHex(job, extraNonce1Hex, extraNonce2Hex, header) {
    const { buildFullCoinbaseTxWithOptions } = require('./coinbase-builder');
    const segwitCoinbase = typeof job.defaultWitnessCommitment === 'string' && job.defaultWitnessCommitment.length > 0;
    const coinbaseTxHex = buildFullCoinbaseTxWithOptions(
      job.coinb1,
      extraNonce1Hex,
      extraNonce2Hex,
      job.coinb2,
      {
        segwitCoinbase,
        witnessReservedValueHex: '00'.repeat(32)
      }
    );

    // Block = header + txcount + coinbase_tx + other_txs + mweb extension
    const txCount = require('./utils').varInt(1 + job.template.transactions.length);
    const otherTxs = job.template.transactions.map(tx => tx.data).join('');
    // Re-extract from template at submit time for maximum compatibility with
    // daemon variants; fall back to cached job.mwebHex.
    const mwebHex = extractMwebHex(job.template) || job.mwebHex || '';

    if (this.coin.symbol === 'LC2' && !mwebHex) {
      writeDiagnosticLog('mweb-template-empty', {
        symbol: this.coin.symbol,
        height: job.height,
        jobId: job.id,
        hasTemplateMweb: job.template && Object.prototype.hasOwnProperty.call(job.template, 'mweb'),
        templateKeys: job.template ? Object.keys(job.template).slice(0, 60) : []
      });
    }

    console.log(`[${this.coin.symbol}] _buildBlockHex: height=${job.height} segwit=${segwitCoinbase} mwebHex.len=${mwebHex.length} mwebHex.preview=${mwebHex.slice(0, 20) || '(empty)'}`);

    return header.toString('hex') + txCount.toString('hex') + coinbaseTxHex + otherTxs + mwebHex;
  }

  async _submitAuxBlock(lc2Job, extraNonce1Hex, extraNonce2Hex, lc2HeaderBytes, workerName = null) {
    const { buildFullCoinbaseTx } = require('./coinbase-builder');
    
    // CRITICAL: Use the cached auxData from the job, NOT a refreshed template.
    // The merged mining commitment in the LC2 coinbase was built for this specific
    // DOGE2 header. If we use a refreshed template, the header bytes may differ
    // (different merkle root, timestamp, etc.), causing hash mismatch or target miss.
    const auxData = lc2Job.auxData;
    const auxHeight = auxData.template.height;

    console.log(`[DOGE2] 🎯 AuxPoW difficulty met! Building block for height ${auxHeight}...`);

    // Verify the LC2 hash meets the DOGE2 target
    const scrypt = require('scryptsy');
    const lc2Hash = scrypt(lc2HeaderBytes, lc2HeaderBytes, 1024, 1, 1, 32);
    const lc2HashHex = lc2Hash.toString('hex');
    const lc2HashBigIntLE = BigInt('0x' + Buffer.from(lc2HashHex, 'hex').reverse().toString('hex'));
    const lc2HashBigIntBE = BigInt('0x' + lc2HashHex);
    const meetsAuxTargetLE = lc2HashBigIntLE <= auxData.target;
    const meetsAuxTargetBE = lc2HashBigIntBE <= auxData.target;

    writeDiagnosticLog('aux-submit-hash-check', {
      aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
      height: auxHeight,
      bits: auxData?.template?.bits || null,
      target: auxData.target.toString(16).padStart(64, '0'),
      lc2HashRaw: lc2HashHex,
      lc2HashLE: lc2HashBigIntLE.toString(16).padStart(64, '0'),
      lc2HashBE: lc2HashBigIntBE.toString(16).padStart(64, '0'),
      meetsAuxTargetLE,
      meetsAuxTargetBE
    });

    if (!meetsAuxTargetLE) {
      console.warn(`[DOGE2] LC2 hash does not meet DOGE2 target — skipping submit`);
      return;
    }

    const parentCoinbaseTxHex = buildFullCoinbaseTx(
      lc2Job.coinb1, extraNonce1Hex, extraNonce2Hex, lc2Job.coinb2
    );

    // Deep structure sanity checks: prove that the aux header hash we submit
    // matches the hash committed in the parent coinbase (fabe6d6d + 32-byte hash).
    const auxHeaderHashHex = computeAuxHash(auxData.headerBytes).toString('hex');
    const auxHeaderHashHexLE = Buffer.from(auxHeaderHashHex, 'hex').reverse().toString('hex');
    const mmMagicHex = 'fabe6d6d';
    const mmPos = parentCoinbaseTxHex.indexOf(mmMagicHex);
    let committedAuxHashHex = null;
    let committedAuxHashHexLE = null;
    let commitmentMatchesBE = false;
    let commitmentMatchesLE = false;
    if (mmPos >= 0 && parentCoinbaseTxHex.length >= (mmPos + 8 + 64)) {
      committedAuxHashHex = parentCoinbaseTxHex.slice(mmPos + 8, mmPos + 8 + 64).toLowerCase();
      committedAuxHashHexLE = Buffer.from(committedAuxHashHex, 'hex').reverse().toString('hex');
      commitmentMatchesBE = committedAuxHashHex === auxHeaderHashHex;
      commitmentMatchesLE = committedAuxHashHex === auxHeaderHashHexLE;
    }

    const auxHeaderVersionLE = auxData.headerBytes.readInt32LE(0);
    const auxpowBitSet = (auxHeaderVersionLE & 0x100) !== 0;

    writeDiagnosticLog('aux-submit-structure-check', {
      aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
      workerName,
      height: auxHeight,
      auxHeaderHashBE: auxHeaderHashHex,
      auxHeaderHashLE: auxHeaderHashHexLE,
      mmCommitFound: mmPos >= 0,
      committedAuxHashBE: committedAuxHashHex,
      committedAuxHashLE: committedAuxHashHexLE,
      commitmentMatchesBE,
      commitmentMatchesLE,
      auxHeaderVersionLE: auxHeaderVersionLE >>> 0,
      auxpowBitSet
    });

    const auxBlockHex = buildAuxPowBlock({
      auxHeaderBytes:       auxData.headerBytes,
      auxCoinbaseTxHex:     auxData.coinbaseTxHex,
      parentCoinbaseTxHex,
      parentMerkleBranches: lc2Job.merkleBranches,
      parentHeaderBytes:    lc2HeaderBytes,
      auxTemplate:          auxData.template,
      parentHashEncoding:   'le'
    });

    writeDiagnosticLog('aux-submit-raw-hex', {
      aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
      height: auxHeight,
      lc2HeaderBytesHex: lc2HeaderBytes.toString('hex'),
      auxHeaderBytesHex: auxData.headerBytes.toString('hex'),
      parentCoinbaseTxHex: parentCoinbaseTxHex,
      auxCoinbaseTxHex: auxData.coinbaseTxHex,
      parentMerkleBranches: lc2Job.merkleBranches,
      auxBlockHexFirst800: auxBlockHex.slice(0, 800)
    });

    const auxBlockHexAltHashBE = buildAuxPowBlock({
      auxHeaderBytes:       auxData.headerBytes,
      auxCoinbaseTxHex:     auxData.coinbaseTxHex,
      parentCoinbaseTxHex,
      parentMerkleBranches: lc2Job.merkleBranches,
      parentHeaderBytes:    lc2HeaderBytes,
      auxTemplate:          auxData.template,
      parentHashEncoding:   'be'
    });

    try {
      this._auxSubmits++;
      writeDiagnosticLog('aux-submit-attempt', {
        aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
        workerName,
        height: auxHeight,
        submits: this._auxSubmits,
        candidates: this._auxCandidates,
        parentHeight: lc2Job?.height || null
      });

      const result = await this._auxJobMgr.rpc.call('submitblock', [auxBlockHex]);
      if (result === null || result === undefined || result === '') {
        this._auxAccepted++;
        writeDiagnosticLog('aux-submit-accepted', {
          aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
          workerName,
          height: auxHeight,
          accepted: this._auxAccepted,
          submits: this._auxSubmits,
          candidates: this._auxCandidates
        });
        console.log(`[DOGE2] 🎉 AuxPoW block ACCEPTED at height ${auxHeight}!`);
        this.emit('auxBlockFound', {
          coin: 'DOGE2',
          height: auxHeight,
          blockHex: auxBlockHex,
          hashHex: null
        });
      } else {
        this._auxRejected++;
        writeDiagnosticLog('aux-submit-rejected', {
          aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
          workerName,
          height: auxHeight,
          rejected: this._auxRejected,
          submits: this._auxSubmits,
          candidates: this._auxCandidates,
          bits: auxData?.template?.bits || null,
          target: auxData.target.toString(16).padStart(64, '0'),
          lc2HashRaw: lc2HashHex,
          lc2HashLE: lc2HashBigIntLE.toString(16).padStart(64, '0'),
          lc2HashBE: lc2HashBigIntBE.toString(16).padStart(64, '0'),
          meetsAuxTargetLE,
          meetsAuxTargetBE,
          result: String(result)
        });

        // Retry once with alternate CMerkleTx.hashBlock encoding for forks that
        // expect parent block hash bytes in BE instead of LE.
        if (String(result) === 'high-hash') {
          try {
            writeDiagnosticLog('aux-submit-retry-attempt', {
              aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
              workerName,
              height: auxHeight,
              retry: 'parent-hash-be'
            });

            const retryResult = await this._auxJobMgr.rpc.call('submitblock', [auxBlockHexAltHashBE]);
            if (retryResult === null || retryResult === undefined || retryResult === '') {
              this._auxAccepted++;
              writeDiagnosticLog('aux-submit-retry-accepted', {
                aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
                workerName,
                height: auxHeight,
                accepted: this._auxAccepted,
                submits: this._auxSubmits,
                candidates: this._auxCandidates,
                retry: 'parent-hash-be'
              });
              console.log(`[DOGE2] 🎉 AuxPoW block ACCEPTED on retry at height ${auxHeight} (parent-hash-be)!`);
              this.emit('auxBlockFound', {
                coin: 'DOGE2',
                height: auxHeight,
                blockHex: auxBlockHexAltHashBE,
                hashHex: null
              });
              return;
            }

            writeDiagnosticLog('aux-submit-retry-rejected', {
              aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
              workerName,
              height: auxHeight,
              retry: 'parent-hash-be',
              result: String(retryResult)
            });
          } catch (retryErr) {
            writeDiagnosticLog('aux-submit-retry-rpc-error', {
              aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
              workerName,
              height: auxHeight,
              retry: 'parent-hash-be',
              error: retryErr.message
            });
          }
        }

        console.error(`[DOGE2] Block rejected (height ${auxHeight}): ${result}`);
      }
    } catch (err) {
      this._auxErrors++;
      writeDiagnosticLog('aux-submit-rpc-error', {
        aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
        workerName,
        height: auxHeight,
        errors: this._auxErrors,
        submits: this._auxSubmits,
        candidates: this._auxCandidates,
        error: err.message
      });
      console.error(`[DOGE2] submitblock RPC error: ${err.message}`);
    }
  }
}

module.exports = JobManager;
