/**
 * One-time bootstrap script:
 * 1. Registers the Circle entity secret
 * 2. Calls setPriceFeed on AproxPerpV5 for BTC/USD, ETH/USD, SOL/USD
 *    using the Circle platform deployer wallet (the contract owner)
 *
 * Run once: bun run scripts/register-entity-and-set-feeds.ts
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  registerEntitySecretCiphertext,
  initiateDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets'

const API_KEY = process.env.CIRCLE_API_KEY
if (!API_KEY) {
  console.error('CIRCLE_API_KEY not set')
  process.exit(1)
}

// ── Step 1: Register entity secret ──────────────────────────────────────────

const recoveryDir = '/home/user/app/.circle'
fs.mkdirSync(recoveryDir, { recursive: true })

const entitySecret = crypto.randomBytes(32).toString('hex')

console.log('[1/4] Registering entity secret with Circle...')
const regResponse = await registerEntitySecretCiphertext({
  apiKey: API_KEY,
  entitySecret,
  recoveryFileDownloadPath: recoveryDir,
})

const recoveryPath = path.join(recoveryDir, 'recovery_file.dat')
if (regResponse.data?.recoveryFile) {
  fs.writeFileSync(recoveryPath, regResponse.data.recoveryFile)
}

// Persist to .env
const envPath = '/home/user/app/.env'
fs.appendFileSync(envPath, `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`, 'utf-8')
console.log('[1/4] Entity secret registered and written to .env')

// ── Step 2: Verify registration ───────────────────────────────────────────

const walletsClient = initiateDeveloperControlledWalletsClient({
  apiKey: API_KEY,
  entitySecret,
})

console.log('[2/4] Verifying registration...')
await walletsClient.listWalletSets({ pageSize: 1 })
console.log('[2/4] Verification OK')

// ── Step 3: Call setPriceFeed for all three pairs ─────────────────────────

// The contract metadata records the deployer wallet ID — that wallet IS the owner
const DEPLOYER_WALLET_ID = '3c2464b2-8369-52e2-a782-800bbeca5396'
const PERP = '0x8fe72d26098eb32696aff816b880fa1d3653c1b6'

// Pair IDs — keccak256 of raw UTF-8 bytes, verified against live contract constants
const PAIR_BTC = '0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489'
const PAIR_ETH = '0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45'
const PAIR_SOL = '0x2b1b43ec7f6691d6bf679978bab5c093fa45ee74c0baac6cc75649dc59cc21d3'

const feeds: Array<{ name: string; pairId: string; feedAddress: string }> = [
  { name: 'BTC/USD', pairId: PAIR_BTC, feedAddress: '0x67001b88d40354de65185397b763d2c8e2d5146d' },
  { name: 'ETH/USD', pairId: PAIR_ETH, feedAddress: '0x100761b064ccef934ed3b3effbed3f9a08bd747b' },
  { name: 'SOL/USD', pairId: PAIR_SOL, feedAddress: '0xb8ada5ae28eee0507430c33bb7c077b9849ba7bc' },
]

console.log('[3/4] Sending setPriceFeed transactions...')

const txIds: string[] = []
for (const feed of feeds) {
  console.log(`  Setting ${feed.name} feed -> ${feed.feedAddress}`)
  const resp = await walletsClient.createContractExecutionTransaction({
    walletId: DEPLOYER_WALLET_ID,
    contractAddress: PERP,
    abiFunctionSignature: 'setPriceFeed(bytes32,address)',
    abiParameters: [feed.pairId, feed.feedAddress],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey: crypto.randomUUID(),
    blockchain: 'ARC-TESTNET',
  })
  const txId = resp.data?.id
  if (!txId) throw new Error(`No tx ID for ${feed.name}`)
  console.log(`  ${feed.name} tx submitted: ${txId}`)
  txIds.push(txId)
}

// ── Step 4: Poll until all transactions complete ──────────────────────────

console.log('[4/4] Waiting for transactions to confirm...')

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'])
const MAX_POLLS = 30

for (const txId of txIds) {
  let done = false
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const tx = await walletsClient.getTransaction({ id: txId })
    const state = tx.data?.transaction?.state
    process.stdout.write(`  ${txId} → ${state}\r`)
    if (state && TERMINAL.has(state)) {
      console.log(`  ${txId} → ${state}`)
      if (state !== 'COMPLETE') throw new Error(`Transaction ${txId} ended in state ${state}`)
      done = true
      break
    }
  }
  if (!done) throw new Error(`Transaction ${txId} did not complete in time`)
}

console.log('\nDone! All three price feeds registered on 0x8fe72d26...')
console.log('Recovery file written to .circle/recovery_file.dat — download and back it up.')
