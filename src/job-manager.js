'use strict';

const EventEmitter = require('events');
const { buildCoinbaseSplit, coinbaseTxid, EXTRA_NONCE_1_LEN } = require('./coinbase-builder');
const { dsha256, reverseHex, merkleRoot, bitsToTarget } = require('./utils');
const { buildAuxHeader, computeAuxHash, buildMergedMiningCommitment, buildAuxPowBlock } = require('./auxpow-builder');

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
    const cbTxidHex = calcCbTxid(coinb1, ZERO_EN1, ZERO_EN2, coinb2);
    const fullCoinbaseTxHex = buildFullCoinbaseTx(coinb1, ZERO_EN1, ZERO_EN2, coinb2);

    // DOGE2 merkle root from coinbase txid + template tx hashes
    const txHashes = template.transactions.map(tx => tx.txid || tx.hash);
    const mRoot = merkleRoot(cbTxidHex, txHashes);

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
      const template = await this.rpc.getBlockTemplate();
      if (!template) return;

      // Fetch network info for dashboard
      try {
        const [miningInfo, netInfo] = await Promise.all([
          this.rpc.call('getmininginfo').catch(() => ({})),
          this.rpc.call('getnetworkinfo').catch(() => ({}))
        ]);
        this._networkInfo = {
          networkHashrate:   miningInfo.networkhashps || 0,
          blockHeight:       template.height,
          networkDifficulty: template.difficulty || miningInfo.difficulty || 0,
          connectedPeers:    netInfo.connections || 0
        };
        if (this.currentJob) Object.assign(this.currentJob, this._networkInfo);
      } catch (_) {}

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
      console.error(`[${this.coin.symbol}] getblocktemplate failed: ${err.message}`);
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

    // Compute merkle branches (all tx hashes except coinbase)
    const merkleBranches = template.transactions.map(tx => tx.txid || tx.hash);

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
      job.prevHashReversed,
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

    // Scrypt ASIC diff1 constant: empirically ~2^27 (not 2^32 which is for SHA256).
    // Formula: hashrate = sum(share_difficulties) * SCRYPT_DIFF1 / window_seconds
    const SCRYPT_DIFF1 = 134217728; // 2^27
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
  processShare(jobId, extraNonce1Hex, extraNonce2Hex, ntime, nonce, workerName, sharesDiff = 1) {
    const job = this.jobs.get(jobId);
    if (!job) {
      const knownIds = [...this.jobs.keys()].join(', ');
      console.log(`[${this.coin.symbol}] Job not found: submitted="${jobId}" known=[${knownIds}]`);
      return { valid: false, error: 'Job not found' };
    }

    // Reconstruct the full coinbase txid
    const cbTxid = coinbaseTxid(job.coinb1, extraNonce1Hex, extraNonce2Hex, job.coinb2);

    // Merkle root
    const mRoot = merkleRoot(cbTxid, job.merkleBranches);

    // Build 80-byte block header
    const header = Buffer.concat([
      Buffer.from(job.version, 'hex').reverse(),   // version LE
      Buffer.from(job.prevHashReversed, 'hex'),     // prevhash (already in wire order)
      Buffer.from(mRoot, 'hex').reverse(),          // merkle root LE
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

    // Check if hash meets network difficulty
    const hashBigInt = BigInt('0x' + Buffer.from(hashHex, 'hex').reverse().toString('hex'));
    const meetsDifficulty = hashBigInt <= job.target;

    // Check DOGE2 AuxPoW merge mining (same Scrypt hash, checked against DOGE2 target)
    if (job.auxData) {
      if (hashBigInt <= job.auxData.target) {
        this._submitAuxBlock(job, extraNonce1Hex, extraNonce2Hex, header).catch(err => {
          console.error(`[DOGE2] AuxPoW submit failed: ${err.message}`);
        });
      }
    }

    if (meetsDifficulty) {
      // Build full block for submission
      const blockHex = this._buildBlockHex(job, extraNonce1Hex, extraNonce2Hex, header);
      this._recordShare(sharesDiff);
      return { valid: true, meetsDifficulty: true, blockHex, hashHex };
    }

    this._recordShare(sharesDiff);
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
    const auxData = lc2Job.auxData;
    const auxHeight = auxData.template.height;

    console.log(`[DOGE2] 🎯 AuxPoW difficulty met! Building block for height ${auxHeight}...`);

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
      const result = await this._auxJobMgr.rpc.call('submitblock', [auxBlockHex]);
      if (result === null || result === undefined || result === '') {
        console.log(`[DOGE2] 🎉 AuxPoW block ACCEPTED at height ${auxHeight}!`);
        this.emit('auxBlockFound', { coin: 'DOGE2', height: auxHeight });
      } else {
        console.error(`[DOGE2] Block rejected (height ${auxHeight}): ${result}`);
      }
    } catch (err) {
      console.error(`[DOGE2] submitblock RPC error: ${err.message}`);
    }
  }
}

module.exports = JobManager;
