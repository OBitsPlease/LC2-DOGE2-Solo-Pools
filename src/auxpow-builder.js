'use strict';

/**
 * AuxPoW (Auxiliary Proof-of-Work) merge mining support.
 *
 * In merge mining, the parent chain (LC2) does the Scrypt work.
 * A commitment to the aux chain's (DOGE2's) block hash is embedded in the
 * LC2 coinbase. When a Scrypt hash meets DOGE2's difficulty, this module
 * builds the full AuxPoW block to submit to the DOGE2 daemon.
 *
 * Byte-order conventions used here:
 *   - Node.js dsha256() returns bytes MSB-first (standard SHA256 output order)
 *   - Bitcoin wire format for 256-bit hashes: LE (LSB-first, reversed from display)
 *   - Merged mining coinbase commitment stores the aux chain merkle root bytes
 *     in LE order to match DOGE2 AuxPoW validator lookup in parent coinbase.
 *   - CMerkleTx.hashBlock on wire: LE (like all uint256 in wire format)
 *
 * Reference: https://en.bitcoin.it/wiki/Merged_mining_specification
 */

const { dsha256, varInt, writeInt32LE, writeUInt32LE, reverseHex } = require('./utils');

// Magic bytes that signal a merged mining commitment in the coinbase scriptSig.
const MERGED_MINING_MAGIC = Buffer.from([0xfa, 0xbe, 0x6d, 0x6d]);

/**
 * Build the 80-byte block header for an AuxPoW block (DOGE2).
 *
 * - Version has BLOCK_VERSION_AUXPOW bit set (0x100)
 * - Nonce is 0 (proof-of-work comes from the parent chain)
 * - All fields in wire (little-endian) byte order
 */
function buildAuxHeader({ version, prevhash, merkleRootHex, curtime, bits }) {
  return Buffer.concat([
    writeInt32LE(version | 0x100),               // AuxPoW version bit set
    Buffer.from(reverseHex(prevhash), 'hex'),     // prevhash in wire order (LE)
    Buffer.from(merkleRootHex, 'hex'),            // merkle root already in internal/wire order
    writeUInt32LE(curtime),
    Buffer.from(bits, 'hex').reverse(),           // bits in wire order (LE)
    writeUInt32LE(0)                              // nonce = 0 for AuxPoW
  ]);
}

/**
 * Compute the SHA256d hash of the aux block header.
 * Returns 32 bytes MSB-first (standard dsha256 output).
 * This is what the DOGE2 validator finds in the LC2 coinbase after
 * performing std::reverse on its internal uint256 (LE) representation.
 */
function computeAuxHash(auxHeaderBytes) {
  return dsha256(auxHeaderBytes); // 32 bytes, MSB-first
}

/**
 * Build the 44-byte merged mining commitment for the LC2 coinbase scriptSig.
 *
 * Format:
 *   0xfabe6d6d  (4 bytes)   magic
 *   aux_hash    (32 bytes)  SHA256d of DOGE2 header, LE bytes
 *   chain_count (4 bytes)   = 1 (LE int32)
 *   nonce       (4 bytes)   = 0 (LE int32)
 */
function buildMergedMiningCommitment(auxHash) {
  const auxHashLE = Buffer.from(auxHash).reverse();
  return Buffer.concat([
    MERGED_MINING_MAGIC,
    auxHashLE,         // 32 bytes LE
    writeInt32LE(1),   // 1 aux chain
    writeInt32LE(0)    // nonce = 0
  ]);
}

/**
 * Build a complete serialised AuxPoW block ready to submit to the DOGE2 daemon.
 *
 * AuxPoW block structure:
 *  [DOGE2 block header, 80 bytes — version has AuxPoW bit set, nonce=0]
 *  [CAuxPow:
 *     CMerkleTx:
 *       [LC2 coinbase transaction bytes]
 *       [LC2 block hash, 32 bytes LE — dsha256(lc2_header) reversed]
 *       [varint count + coinbase merkle branch hashes]
 *       [nIndex = 0, int32LE]
 *     [varint 0 — empty vChainMerkleBranch (only 1 aux chain)]
 *     [nChainIndex = 0, int32LE]
 *     [LC2 block header, 80 bytes]
 *  ]
 *  [varint: DOGE2 transaction count]
 *  [DOGE2 coinbase transaction]
 *  [other DOGE2 transactions]
 */
function buildAuxPowBlock({
  auxHeaderBytes,        // Buffer: 80-byte DOGE2 block header
  auxCoinbaseTxHex,      // string: complete DOGE2 coinbase tx hex
  parentCoinbaseTxHex,   // string: complete LC2 coinbase tx hex
  parentMerkleBranches,  // string[]: LC2 merkle branches (coinbase merkle proof)
  parentHeaderBytes,     // Buffer: 80-byte LC2 block header
  auxTemplate,           // object: DOGE2 getblocktemplate (for transaction data)
  parentHashEncoding = 'le' // 'le' (default) or 'be' for CMerkleTx.hashBlock
}) {
  const parentHashBE = Buffer.from(dsha256(parentHeaderBytes));
  // CMerkleTx.hashBlock fallback mode: some AuxPoW forks expect BE bytes here.
  const parentBlockHash = parentHashEncoding === 'be'
    ? parentHashBE
    : Buffer.from(parentHashBE).reverse();

  // CMerkleTx: [parent_coinbase_tx][block_hash][merkle_branch][nIndex]
  const cMerkleTx = Buffer.concat([
    Buffer.from(parentCoinbaseTxHex, 'hex'),
    parentBlockHash,
    serializeMerkleBranch(parentMerkleBranches),
    writeInt32LE(0)   // nIndex = 0 (coinbase is always first tx)
  ]);

  // vChainMerkleBranch = empty (single aux chain), nChainIndex = 0
  const chainMerkleSection = Buffer.concat([
    varInt(0),
    writeInt32LE(0)
  ]);

  // DOGE2 transaction payload: coinbase + rest of txs from template
  const doge2TxCount = varInt(1 + auxTemplate.transactions.length);
  const doge2OtherTxs = auxTemplate.transactions.map(tx => tx.data).join('');

  return [
    auxHeaderBytes.toString('hex'),
    cMerkleTx.toString('hex'),
    chainMerkleSection.toString('hex'),
    parentHeaderBytes.toString('hex'),
    doge2TxCount.toString('hex'),
    auxCoinbaseTxHex,
    doge2OtherTxs
  ].join('');
}

function serializeMerkleBranch(hashes) {
  const count = varInt(hashes.length);
  const hashBufs = hashes.map(h => Buffer.from(h, 'hex'));
  return Buffer.concat([count, ...hashBufs]);
}

module.exports = {
  buildAuxHeader,
  computeAuxHash,
  buildMergedMiningCommitment,
  buildAuxPowBlock
};
