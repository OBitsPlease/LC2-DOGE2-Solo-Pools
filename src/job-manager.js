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
      auxCommitment
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
      auxData  // null unless merge mining is active
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
      if (hashBigInt <= job.auxData.target) {
        this._auxCandidates++;
        writeDiagnosticLog('aux-candidate-hit', {
          parent: this.coin.symbol,
          aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
          height: job.auxData?.template?.height || null,
          parentHeight: job.height || null,
          candidates: this._auxCandidates,
          shareDiff: sharesDiff || 1
        });
        this._submitAuxBlock(job, extraNonce1Hex, extraNonce2Hex, header).catch(err => {
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
    const { buildFullCoinbaseTx } = require('./coinbase-builder');
    const coinbaseTxHex = buildFullCoinbaseTx(job.coinb1, extraNonce1Hex, extraNonce2Hex, job.coinb2);

    // Block = header + txcount + coinbase_tx + other_txs
    const txCount = require('./utils').varInt(1 + job.template.transactions.length);
    const otherTxs = job.template.transactions.map(tx => tx.data).join('');

    return header.toString('hex') + txCount.toString('hex') + coinbaseTxHex + otherTxs;
  }

  async _submitAuxBlock(lc2Job, extraNonce1Hex, extraNonce2Hex, lc2HeaderBytes) {
    const { buildFullCoinbaseTx } = require('./coinbase-builder');
    const cachedAuxHeight = lc2Job.auxData.template.height;

    console.log(`[DOGE2] 🎯 AuxPoW difficulty met! Building block for height ${cachedAuxHeight}...`);

    // Fetch a fresh DOGE2 template at submit time to avoid stale-block rejection.
    // If DOGE2 has already moved past this height, the submission would be rejected
    // with "high-hash" or "stale" — skip it rather than waste the RPC call.
    let auxData;
    try {
      auxData = await this._auxJobMgr.getAuxData();
    } catch (err) {
      console.error(`[DOGE2] Could not refresh aux data before submit: ${err.message} — falling back to cached template`);
      auxData = lc2Job.auxData;
    }

    const auxHeight = auxData.template.height;
    if (auxHeight !== cachedAuxHeight) {
      console.warn(`[DOGE2] Stale aux candidate: job was for height ${cachedAuxHeight} but DOGE2 is now at height ${auxHeight} — skipping submit`);
      return;
    }

    // Verify the LC2 hash still meets the fresh DOGE2 target (difficulty may have changed)
    const scrypt = require('scryptsy');
    const lc2Hash = scrypt(lc2HeaderBytes, lc2HeaderBytes, 1024, 1, 1, 32);
    const lc2HashBigInt = BigInt('0x' + Buffer.from(lc2Hash).reverse().toString('hex'));
    if (lc2HashBigInt > auxData.target) {
      console.warn(`[DOGE2] LC2 hash no longer meets refreshed DOGE2 target — skipping submit`);
      return;
    }

    const parentCoinbaseTxHex = buildFullCoinbaseTx(
      lc2Job.coinb1, extraNonce1Hex, extraNonce2Hex, lc2Job.coinb2
    );

    const auxBlockHex = buildAuxPowBlock({
      auxHeaderBytes:       auxData.headerBytes,
      auxCoinbaseTxHex:     auxData.coinbaseTxHex,
      parentCoinbaseTxHex,
      parentMerkleBranches: lc2Job.merkleBranches,
      parentHeaderBytes:    lc2HeaderBytes,
      auxTemplate:          auxData.template
    });

    try {
      this._auxSubmits++;
      writeDiagnosticLog('aux-submit-attempt', {
        aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
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
          height: auxHeight,
          rejected: this._auxRejected,
          submits: this._auxSubmits,
          candidates: this._auxCandidates,
          result: String(result)
        });
        console.error(`[DOGE2] Block rejected (height ${auxHeight}): ${result}`);
      }
    } catch (err) {
      this._auxErrors++;
      writeDiagnosticLog('aux-submit-rpc-error', {
        aux: this._auxJobMgr?.coin?.symbol || 'DOGE2',
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
