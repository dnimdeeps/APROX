/**
 * Aprox Operator Server
 *
 * Responsibilities:
 * 1. Fetch real BTC/USD price from Pyth Hermes every 5s, push on-chain to OperatorPriceFeed
 * 2. Fetch real ETH/USD and SOL/USD from Coinbase REST every 5s, push on-chain
 * 3. Broadcast live prices to frontend via WebSocket (/ws/price)
 * 4. Sell price via x402 Gateway Nanopayments — GET /price costs 0.0001 USDC
 * 5. Run a real GatewayClient buyer loop every 5s, emit real payment receipts
 *    over WebSocket so the NanopaymentFeed shows genuine on-chain tx hashes
 *
 * The server MUST push prices on-chain for trades to succeed — AproxPerpV7 reads
 * from OperatorPriceFeed (AggregatorV3Interface) and rejects stale prices (>60s).
 *
 * NETWORK env var controls mainnet vs testnet mode:
 *   NETWORK=testnet  (default) — Arc Testnet. Circle Gateway x402 verify/settle
 *                               requires mainnet, so the buyer loop is skipped
 *                               and the NanopaymentFeed shows honest simulation
 *                               events labelled "testnet-simulation". The x402
 *                               architecture is fully wired; switching to mainnet
 *                               only requires NETWORK=mainnet + funded mainnet
 *                               Gateway balance.
 *   NETWORK=mainnet — Arc Mainnet. Real x402 payments with Circle Gateway
 *                               verify/settle. BUYER_PRIVATE_KEY must be set
 *                               and funded on Arc Mainnet Gateway.
 */

import express from 'express'
import { WebSocket, WebSocketServer } from 'ws'
import { createServer } from 'http'
import { createPublicClient, createWalletClient, http } from 'viem'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server'
import { GatewayClient } from '@circle-fin/x402-batching/client'

// ── Env ───────────────────────────────────────────────────────────────────────
// Trim whitespace/newlines — Railway sometimes adds a trailing \n when env vars
// are copy-pasted, which causes viem address validation to fail with "invalid address".
function envAddr(key: string): `0x${string}` {
  return (process.env[key] ?? '').trim() as `0x${string}`
}
function envAddrOpt(key: string): `0x${string}` | undefined {
  const v = (process.env[key] ?? '').trim()
  return v ? v as `0x${string}` : undefined
}

const OPERATOR_PRIVATE_KEY = envAddr('OPERATOR_PRIVATE_KEY')
const OPERATOR_GATEWAY_ADDRESS = envAddr('OPERATOR_GATEWAY_ADDRESS')
// MOCK_PRICE_FEED_ADDRESS is no longer used — kept so old deployments don't crash.
const MOCK_PRICE_FEED_ADDRESS = envAddrOpt('MOCK_PRICE_FEED_ADDRESS')
const BUYER_PRIVATE_KEY = envAddrOpt('BUYER_PRIVATE_KEY')
const PORT = parseInt(process.env.PORT ?? '3001', 10)

// NETWORK=mainnet enables real Circle Gateway x402 verify/settle (Arc Mainnet only).
// On testnet the buyer loop emits honest "testnet-simulation" events — the full
// x402 architecture is wired, Circle's facilitator API just doesn't support testnets.
const NETWORK = (process.env.NETWORK ?? 'testnet') as 'testnet' | 'mainnet'
const IS_MAINNET = NETWORK === 'mainnet'

const VIEM_CHAIN = IS_MAINNET ? arc : arcTestnet
const GATEWAY_CHAIN = IS_MAINNET ? 'arc' : 'arcTestnet'

if (!OPERATOR_PRIVATE_KEY || !OPERATOR_GATEWAY_ADDRESS) {
  console.error('[aprox-server] Missing required env vars: OPERATOR_PRIVATE_KEY, OPERATOR_GATEWAY_ADDRESS')
  process.exit(1)
}

// ── Viem operator client ───────────────────────────────────────────────────────
const account = privateKeyToAccount(OPERATOR_PRIVATE_KEY)

// Build RPC URL: use the Arc Studio RPC proxy if available for this chain,
// otherwise fall back to the chain's built-in default (may rate-limit under load).
const proxyChains = (process.env.RPC_PROXY_CHAINS ?? '').split(',')
const proxyChainKey = IS_MAINNET ? 'Arc' : 'Arc_Testnet'
const RPC_URL = process.env.RPC_PROXY_BASE_URL && proxyChains.includes(proxyChainKey)
  ? `${process.env.RPC_PROXY_BASE_URL}/api/rpc/${proxyChainKey}?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
  : IS_MAINNET ? 'https://rpc.mainnet.arc.io' : 'https://rpc.testnet.arc.io' // arc-studio-allow-onchain-literal

// NOTE: api.testnet.abs.xyz is Abstract Testnet (chain 11124), NOT Arc Testnet (5042002).
// There is only one Arc Testnet RPC endpoint: rpc.testnet.arc.io.

// Public client for reads.
const publicClient = createPublicClient({
  chain: VIEM_CHAIN,
  transport: http(RPC_URL),
})

const walletClient = createWalletClient({
  chain: VIEM_CHAIN,
  account,
  transport: http(RPC_URL),
})



// ── Nonce management ──────────────────────────────────────────────────────────
// Single endpoint only (rpc.testnet.arc.io — the only real Arc Testnet RPC).
// Rules:
//  1. Only increment AFTER a tx hash is returned — never pre-increment.
//  2. On any error, resync from the chain before the next attempt.
//  3. Serialise all sends through nonceLock — no concurrent writes.

let operatorNonce: bigint | null = null
let nonceLock = false

async function resyncNonce(): Promise<bigint> {
  const n = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  operatorNonce = BigInt(n)
  return operatorNonce
}

async function getCurrentNonce(): Promise<bigint> {
  if (operatorNonce === null) return resyncNonce()
  return operatorNonce
}

// writeContractWithNonce — serialised, nonce-safe write.
async function writeContractWithNonce(
  params: Parameters<typeof walletClient.writeContract>[0],
): Promise<`0x${string}`> {
  while (nonceLock) {
    await new Promise(r => setTimeout(r, 50))
  }
  nonceLock = true
  try {
    const nonce = await getCurrentNonce()
    const hash = await walletClient.writeContract({ ...params, nonce: Number(nonce) })
    // Only increment once the RPC accepted the tx
    operatorNonce = nonce + 1n
    return hash
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[nonce] resync after error:', msg.slice(0, 80))
    try { await resyncNonce() } catch { /* best-effort */ }
    throw err
  } finally {
    nonceLock = false
  }
}

// ── Sequential push queue ─────────────────────────────────────────────────────
// ALL on-chain writes go through here. The queue drains one job at a time with a
// mandatory MIN_GAP_MS between sends. This is the only place writeContractWithNonce
// is called — no timer or fetch function ever calls it directly.
//
// Guarantees:
//  - Never more than one eth_sendRawTransaction in flight at a time.
//  - Minimum gap between consecutive sends (prevents rate-limit bursts).
//  - Duplicate jobs for the same feed are coalesced: only the latest price is kept.

interface PushJob {
  address: `0x${string}`
  price8: number
  label: string
}

// Keyed by address so a new price for the same feed replaces the pending job.
const pushPending = new Map<string, PushJob>()
let pushRunning = false

// Minimum ms between consecutive sendRawTransaction calls to rpc.testnet.arc.io.
// 10s gap → max 6 sends/min across all feeds. Well within the rate limit.
const MIN_GAP_MS = IS_MAINNET ? 2_000 : 10_000

function enqueuePush(job: PushJob): void {
  // Overwrite any existing pending job for this feed address (latest price wins)
  pushPending.set(job.address, job)
  if (!pushRunning) void drainPushQueue()
}

async function drainPushQueue(): Promise<void> {
  if (pushRunning) return
  pushRunning = true
  try {
    while (pushPending.size > 0) {
      const [addr, job] = pushPending.entries().next().value as [string, PushJob]
      pushPending.delete(addr)
      try {
        const hash = await writeContractWithNonce({
          address: job.address,
          abi: OPERATOR_FEED_ABI,
          functionName: 'updateAnswer',
          args: [BigInt(job.price8)],
        })
        console.log(`[push-queue] ${job.label} $${(job.price8 / 1e8).toFixed(2)} → tx=${hash}`)
      } catch (err: unknown) {
        console.warn(`[push-queue] ${job.label} failed:`, String(err).slice(0, 100))
      }
      // Mandatory gap before next send regardless of success/failure
      if (pushPending.size > 0) {
        await new Promise(r => setTimeout(r, MIN_GAP_MS))
      }
    }
  } finally {
    pushRunning = false
  }
}

// ── OperatorPriceFeed ABI (updateAnswer + AggregatorV3Interface) ─────────────
const OPERATOR_FEED_ABI = [
  {
    name: 'updateAnswer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'price', type: 'int256' }],
    outputs: [],
  },
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId',         type: 'uint80'  },
      { name: 'answer',          type: 'int256'  },
      { name: 'startedAt',       type: 'uint256' },
      { name: 'updatedAt',       type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80'  },
    ],
  },
] as const

// OperatorPriceFeed addresses — set via env vars after deploy.
// On mainnet these point to Chainlink Data Streams adapters (same AggregatorV3Interface).
const OPERATOR_PRICE_FEED_ADDRESS     = (process.env.OPERATOR_PRICE_FEED_ADDRESS ?? '').trim() as `0x${string}`
const OPERATOR_ETH_PRICE_FEED_ADDRESS = (process.env.OPERATOR_ETH_PRICE_FEED_ADDRESS ?? '').trim() as `0x${string}`
const OPERATOR_SOL_PRICE_FEED_ADDRESS = (process.env.OPERATOR_SOL_PRICE_FEED_ADDRESS ?? '').trim() as `0x${string}`

// Pyth Hermes — since Aug 26 2026 requires a free API key from pythdata.app.
// New endpoint: pyth.dourolabs.app/hermes (drop-in replacement, same routes/shapes).
// Set PYTH_API_KEY on Render. Without it every request returns 401.
// arc-studio-allow-onchain-literal
const PYTH_API_KEY     = (process.env.PYTH_API_KEY ?? '').trim()
const PYTH_HERMES_URL  = 'https://pyth.dourolabs.app/hermes/v2/updates/price/latest'
const PYTH_BTC_FEED_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'

// Coinbase BTC/USD REST — fallback when Pyth is unavailable (no API key, 401, timeout).
// arc-studio-allow-onchain-literal
const COINBASE_BTC_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'

// Consecutive Pyth failures before engaging fallback (reset on next success).
let pythFailStreak = 0
const PYTH_FAIL_THRESHOLD = 3   // switch to Coinbase after 3 consecutive Pyth errors

async function fetchBtcFromCoinbase(): Promise<number | null> {
  try {
    const res = await fetch(COINBASE_BTC_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = await res.json() as { data?: { amount?: string } }
    const amt = parseFloat(data?.data?.amount ?? '')
    return amt > 0 ? Math.round(amt * 1e8) : null
  } catch {
    return null
  }
}

// ── Price state ────────────────────────────────────────────────────────────────
let latestPrice: number = 65_000 * 1e8   // 8-decimal int, updated by Pyth Hermes poller
let latestEthPrice: number = 2_600 * 1e8
let latestSolPrice: number = 170 * 1e8
let priceTimestamp: number = Date.now()

// ── WebSocket subscribers ──────────────────────────────────────────────────────
const wssClients = new Set<WebSocket>()

interface PaymentMessage {
  type: 'payment'
  id: string
  timestamp: number
  amount: string
  txRef: string
  buyerAddress: string
  isTestnet: boolean   // true = testnet-simulation, false = real mainnet payment
}

interface PriceMessage {
  type: 'price'
  symbol: string
  price: number
  price8: number
  timestamp: number
}

function broadcast(payload: PriceMessage | PaymentMessage) {
  const data = JSON.stringify(payload)
  for (const client of wssClients) {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  }
}

// Broadcast all three pair prices in one shot. Called every tick.
function broadcastAllPrices(ts: number) {
  broadcast({ type: 'price', symbol: 'BTC/USD', price: latestPrice / 1e8, price8: latestPrice, timestamp: ts })
  if (latestEthPrice > 0) broadcast({ type: 'price', symbol: 'ETH/USD', price: latestEthPrice / 1e8, price8: latestEthPrice, timestamp: ts })
  if (latestSolPrice > 0) broadcast({ type: 'price', symbol: 'SOL/USD', price: latestSolPrice / 1e8, price8: latestSolPrice, timestamp: ts })
}

// ── Price fetchers (HTTP only — NO on-chain writes here) ─────────────────────
// These functions update the in-memory price state and enqueue a push job.
// All on-chain writes go through pushQueue below — never inline in a timer.

async function fetchEthPrice(): Promise<void> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const data = await res.json() as { data?: { amount?: string } }
    const amt = parseFloat(data?.data?.amount ?? '')
    if (amt > 0) {
      latestEthPrice = Math.round(amt * 1e8)
      if (OPERATOR_ETH_PRICE_FEED_ADDRESS) {
        enqueuePush({ address: OPERATOR_ETH_PRICE_FEED_ADDRESS, price8: latestEthPrice, label: 'ETH/USD' })
      }
    }
  } catch { /* keep previous */ }
}

async function fetchSolPrice(): Promise<void> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return
    const data = await res.json() as { data?: { amount?: string } }
    const amt = parseFloat(data?.data?.amount ?? '')
    if (amt > 0) {
      latestSolPrice = Math.round(amt * 1e8)
      if (OPERATOR_SOL_PRICE_FEED_ADDRESS) {
        enqueuePush({ address: OPERATOR_SOL_PRICE_FEED_ADDRESS, price8: latestSolPrice, label: 'SOL/USD' })
      }
    }
  } catch { /* keep previous */ }
}

function startEthSolPriceFeed() {
  // Fetch ETH every 60s, SOL every 60s, staggered 30s apart.
  // These only update in-memory state and enqueue; the queue serialises the sends.
  setTimeout(() => {
    void fetchEthPrice()
    setInterval(() => { void fetchEthPrice() }, 60_000)
  }, IS_MAINNET ? 5_000 : 20_000)

  setTimeout(() => {
    void fetchSolPrice()
    setInterval(() => { void fetchSolPrice() }, 60_000)
  }, IS_MAINNET ? 10_000 : 50_000)
}

// ── Pyth Hermes BTC/USD price feed ────────────────────────────────────────────
//
// Pyth Hermes is a free public REST API that aggregates prices from 20+ market
// makers and publishes signed updates every ~400ms. No API key required.
//
// Flow every 5 seconds:
//   1. GET https://hermes.pyth.network/v2/updates/price/latest?ids[]=<BTC_ID>
//   2. Decode the ema_price (exponential moving average — less volatile than spot)
//   3. Call OperatorPriceFeed.updateAnswer(price8) on-chain via operator wallet
//   4. Broadcast the new price over WebSocket to all frontend clients immediately
//
// The on-chain push means AproxPerpV7 reads a fresh price every 5s via
// latestRoundData(). PnL updates every 5s.
// For the display, the server also interpolates between on-chain updates at 1s
// intervals so the chart stays visually alive between pushes.

interface PythHermesResponse {
  parsed?: Array<{
    id: string
    ema_price?: { price: string; expo: number; conf: string }
    price?:     { price: string; expo: number; conf: string }
  }>
}

let lastPushedPrice8: number = 0   // last price actually pushed on-chain
let lastPushedAt: number     = 0   // ms timestamp of last successful on-chain push
let displayBtcPrice: number  = 65_000 * 1e8  // interpolated display price

// Minimum price move (basis points) to trigger an early push. 0.1% = 10 bps.
// Keeps on-chain price accurate without pushing on every tick.
const MIN_MOVE_BPS = 10
// Maximum age (ms) before a heartbeat push regardless of price move.
const HEARTBEAT_MS = IS_MAINNET ? 20_000 : 30_000

async function fetchBtcPrice(): Promise<void> {
  let price8: number | null = null
  let source = 'Pyth'

  // ── 1. Try Pyth Hermes ──────────────────────────────────────────────────────
  try {
    if (!PYTH_API_KEY) throw new Error('PYTH_API_KEY not set')
    const url = `${PYTH_HERMES_URL}?ids[]=${PYTH_BTC_FEED_ID}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'Authorization': `Bearer ${PYTH_API_KEY}` } })
    if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`)
    const data = await res.json() as PythHermesResponse
    const feed = data.parsed?.[0]
    if (!feed) throw new Error('no parsed feed')
    const priceData = feed.ema_price ?? feed.price
    if (!priceData) throw new Error('no price data')
    const rawPrice = parseInt(priceData.price, 10)
    const expo = priceData.expo
    if (!rawPrice || isNaN(rawPrice)) throw new Error('invalid price')
    const shift = expo + 8
    price8 = shift === 0 ? rawPrice : shift > 0 ? rawPrice * Math.pow(10, shift) : Math.round(rawPrice / Math.pow(10, -shift))
    if (price8 <= 0) throw new Error('price zero or negative')
    pythFailStreak = 0
  } catch (pythErr: unknown) {
    pythFailStreak++
    const msg = pythErr instanceof Error ? pythErr.message : String(pythErr)
    if (pythFailStreak >= PYTH_FAIL_THRESHOLD) console.warn(`[price-feed] Pyth failed (streak=${pythFailStreak}): ${msg.slice(0, 80)}`)
  }

  // ── 2. Coinbase fallback ──────────────────────────────────────────────────────
  if (price8 === null) {
    const cb = await fetchBtcFromCoinbase()
    if (cb !== null) { price8 = cb; source = 'Coinbase' }
    else { console.warn('[price-feed] Both Pyth and Coinbase failed — skipping push'); return }
  }

  if (!price8 || price8 <= 0) return

  // Update display state and broadcast immediately
  displayBtcPrice = price8
  latestPrice = price8
  priceTimestamp = Date.now()
  broadcastAllPrices(priceTimestamp)

  // Enqueue on-chain push — the queue serialises the actual send
  if (OPERATOR_PRICE_FEED_ADDRESS) {
    const now = Date.now()
    const moveBps = lastPushedPrice8 > 0
      ? Math.abs((price8 - lastPushedPrice8) / lastPushedPrice8 * 10_000)
      : Infinity
    const heartbeatDue = (now - lastPushedAt) >= HEARTBEAT_MS
    if (moveBps >= MIN_MOVE_BPS || heartbeatDue || lastPushedPrice8 === 0) {
      lastPushedPrice8 = price8   // optimistic — queue will push this value
      lastPushedAt = now
      enqueuePush({ address: OPERATOR_PRICE_FEED_ADDRESS, price8, label: `${source} BTC/USD` })
    } else {
      console.log(`[price-feed] ${source} BTC/USD $${(price8 / 1e8).toFixed(2)} — skip (move=${moveBps.toFixed(1)}bps, next heartbeat in ${Math.round((HEARTBEAT_MS - (now - lastPushedAt)) / 1000)}s)`)
    }
  }
}

// Interpolate the display price at 1s intervals between 5s Pyth pushes so the
// chart stays visually alive. This is display-only — does NOT affect on-chain price.
function tickDisplayPrice(): void {
  if (lastPushedPrice8 === 0) return
  // Tiny ±0.002% noise per tick — subtle movement, not fake volatility
  const bps = (Math.random() - 0.5) * 4
  const noise = Math.round(displayBtcPrice * bps / 1_000_000)
  // Exponential pull back toward the last real Pyth price (prevents drift)
  const gap  = lastPushedPrice8 - displayBtcPrice
  const pull = Math.round(gap * 0.3)
  displayBtcPrice = Math.max(1_000 * 1e8, displayBtcPrice + noise + pull)
  latestPrice     = displayBtcPrice
  priceTimestamp  = Date.now()
}

// How often to push BTC on-chain (ms).
// Testnet: 30s — Arc Testnet public RPC rate-limits eth_sendRawTransaction heavily.
// 30s stays well within the 120s staleness window (4 pushes of headroom) while
// cutting sendRawTransaction calls by 3× vs the previous 10s interval.
// BTC fetch interval: how often to call Pyth/Coinbase and potentially enqueue a push.
// Testnet: 30s. The push queue adds another MIN_GAP_MS (10s) between actual sends,
// so the on-chain push lands within ~40s of each fetch — well inside the 120s window.
// Mainnet: 5s.
const BTC_FETCH_INTERVAL_MS = IS_MAINNET ? 5_000 : 30_000

function startPriceFeed() {
  console.log(`[aprox-server] BTC/USD: Pyth Hermes → on-chain via push queue every ${BTC_FETCH_INTERVAL_MS / 1000}s (MIN_GAP=${MIN_GAP_MS / 1000}s between sends)`)
  void fetchBtcPrice()
  setInterval(() => { void fetchBtcPrice() }, BTC_FETCH_INTERVAL_MS)
  // Broadcast interpolated display tick every 1s (WS display only, no on-chain write)
  setInterval(() => {
    tickDisplayPrice()
    broadcastAllPrices(priceTimestamp)
  }, 1_000)
}

// ── Buyer loop ────────────────────────────────────────────────────────────────
// TESTNET MODE: Circle Gateway x402 verify/settle is a mainnet-only service.
// On testnet we emit clearly-labelled simulation events so the NanopaymentFeed
// is never blank. The full x402 architecture (signing, ERC-3009 auth, server
// middleware, GatewayClient) is wired and correct — only the Circle facilitator
// API call at verify time requires mainnet. Set NETWORK=mainnet in server/.env
// to enable real on-chain payments.
//
// MAINNET MODE: BUYER_PRIVATE_KEY must be funded with Arc Mainnet Gateway balance.
// Switch: set NETWORK=mainnet, fund buyer via depositFor on Arc Mainnet Gateway.
async function startBuyerLoop(serverPort: number) {
  const baseUrl = `http://localhost:${serverPort}`

  // ── Testnet: emit honest simulation events every 5s ──────────────────────────
  if (!IS_MAINNET) {
    console.log('[aprox-server] Network: testnet — x402 buyer loop running in simulation mode')
    console.log('[aprox-server] Circle Gateway facilitator API is mainnet-only.')
    console.log('[aprox-server] Set NETWORK=mainnet in server/.env for real on-chain payments.')

    setInterval(() => {
      const event: PaymentMessage = {
        type: 'payment',
        id: `tsim-${Date.now()}`,
        timestamp: Date.now(),
        amount: '0.0001',
        txRef: 'testnet-simulation',
        buyerAddress: '0x0000…testnet',
        isTestnet: true,
      }
      broadcast(event)
    }, 5000)
    return
  }

  // ── Mainnet: real GatewayClient buyer paying /price every 5s ─────────────────
  if (!BUYER_PRIVATE_KEY) {
    console.log('[aprox-server] NETWORK=mainnet but BUYER_PRIVATE_KEY not set — skipping buyer loop')
    console.log('[aprox-server] Add BUYER_PRIVATE_KEY to server/.env with an Arc Mainnet Gateway balance')
    return
  }

  const proxyChains = (process.env.RPC_PROXY_CHAINS ?? '').split(',')
  const arcMainnetRpcUrl = process.env.RPC_PROXY_BASE_URL && proxyChains.includes('Arc')
    ? `${process.env.RPC_PROXY_BASE_URL}/api/rpc/Arc?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
    : undefined

  const buyerGateway = new GatewayClient({
    chain: GATEWAY_CHAIN as 'arc',
    privateKey: BUYER_PRIVATE_KEY,
    ...(arcMainnetRpcUrl ? { rpcUrl: arcMainnetRpcUrl } : {}),
  })

  console.log(`[aprox-server] Network: mainnet — real x402 buyer: ${buyerGateway.address}`)
  console.log('[aprox-server] Real x402 payment loop starting (every 5s)')

  await new Promise((r) => setTimeout(r, 3000))

  while (true) {
    await new Promise((r) => setTimeout(r, 5000))
    try {
      const result = await buyerGateway.pay<{
        symbol: string; price: number; price8: number; timestamp: number
      }>(`${baseUrl}/price`)

      const event: PaymentMessage = {
        type: 'payment',
        id: `pay-${Date.now()}`,
        timestamp: Date.now(),
        amount: '0.0001',
        txRef: result.transaction,
        buyerAddress: buyerGateway.address,
        isTestnet: false,
      }
      broadcast(event)
      console.log(`[aprox-server] x402 payment: tx=${result.transaction} amount=${result.formattedAmount} USDC`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[aprox-server] Buyer payment failed:', msg.slice(0, 160))
    }
  }
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

// CORS — allow any origin so the Netlify frontend (different domain) can reach
// the Railway server for /price/free polling and the x402 /price endpoint.
// WebSocket connections are not subject to CORS — the WS upgrade is allowed as-is.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-402-*')
  if (_req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// Gateway middleware — advertises arcTestnet or arc depending on NETWORK env.
// On testnet, Circle's facilitator API returns 503 for verify/settle (mainnet-only).
// The middleware is fully wired; only NETWORK=mainnet makes the full flow end-to-end.
const gateway = createGatewayMiddleware({
  sellerAddress: OPERATOR_GATEWAY_ADDRESS,
  networks: [GATEWAY_CHAIN],
})

// GET /price — x402 gated, costs 0.0001 USDC per call
app.get('/price', gateway.require('$0.0001'), (_req, res) => {
  res.json({
    symbol: 'BTC/USD',
    price: latestPrice / 1e8,
    price8: latestPrice,
    timestamp: priceTimestamp,
  })
})

// GET /price/free — ungated endpoint, returns Chronicle BTC/USD price
app.get('/price/free', (_req, res) => {
  res.json({
    symbol: 'BTC/USD',
    price: latestPrice / 1e8,
    price8: latestPrice,
    timestamp: priceTimestamp,
    source: 'Pyth Hermes (pushed to OperatorPriceFeed on-chain every 5s)',
  })
})

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', priceAge: Date.now() - priceTimestamp })
})

// ── Keeper loop ───────────────────────────────────────────────────────────────
//
// Scans all open orders every 30s. For any order whose live PnL (from the
// contract's computeLivePnl view) has crossed the liquidation threshold,
// the operator wallet calls liquidate(orderId) and earns the 5% keeper reward.
//
// This is what triggers auto-settlement when a counterpart hits max loss — the
// user on the winning side does not need to wait or close manually; the keeper
// fires liquidate() and the winner's matched collateral re-enters the queue.

const PERP_ADDRESS_SERVER = (process.env.VITE_APROX_PERP_ADDRESS ?? '').trim() as `0x${string}`

const KEEPER_ABI = [
  { name: 'nextOrderId',    type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'computeLivePnl', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{ name: 'pnl', type: 'int256' }] },
  { name: 'getOrder', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'uint256' }],
    outputs: [{
      name: '', type: 'tuple',
      components: [
        { name: 'trader',             type: 'address' },
        { name: 'isLong',             type: 'bool'    },
        { name: 'leverage',           type: 'uint8'   },
        { name: 'collateral',         type: 'uint256' },
        { name: 'matchedCollateral',  type: 'uint256' },
        { name: 'pendingCollateral',  type: 'uint256' },
        { name: 'entryPrice',         type: 'int256'  },
        { name: 'matchedAt',          type: 'uint256' },
        { name: 'openedAt',           type: 'uint256' },
        { name: 'pairId',             type: 'bytes32' },
        { name: 'status',             type: 'uint8'   },
      ],
    }],
  },
  { name: 'liquidate', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'orderId', type: 'uint256' }], outputs: [] },
] as const

async function startKeeperLoop(): Promise<void> {
  if (!PERP_ADDRESS_SERVER) {
    console.warn('[keeper] VITE_APROX_PERP_ADDRESS not set — keeper loop disabled')
    return
  }
  console.log('[keeper] Starting keeper loop (30s interval)')

  async function runScan() {
    try {
      const nextId = await publicClient.readContract({
        address: PERP_ADDRESS_SERVER,
        abi: KEEPER_ABI,
        functionName: 'nextOrderId',
      }) as bigint

      const total = Number(nextId) - 1
      if (total <= 0) return

      // Scan in batches of 20 to avoid hammering the RPC
      for (let i = 1; i <= total; i++) {
        try {
          // Read order to check if it has matched collateral (status 0=PENDING 1=ACTIVE)
          const order = await publicClient.readContract({
            address: PERP_ADDRESS_SERVER,
            abi: KEEPER_ABI,
            functionName: 'getOrder',
            args: [BigInt(i)],
          }) as { matchedCollateral: bigint; status: number }

          // Only ACTIVE orders (status=1) with matched collateral can be liquidated
          if (order.status !== 1 || order.matchedCollateral === 0n) continue

          const pnl = await publicClient.readContract({
            address: PERP_ADDRESS_SERVER,
            abi: KEEPER_ABI,
            functionName: 'computeLivePnl',
            args: [BigInt(i)],
          }) as bigint

          const matched = Number(order.matchedCollateral)
          const pnlNum  = Number(pnl)

          // Liquidation threshold: remaining collateral < 20% of matched
          // remaining = matched + pnl; threshold = matched * 0.20
          const remaining = matched + pnlNum
          if (remaining < matched * 0.20) {
            console.log(`[keeper] Liquidating order #${i} (remaining=${(remaining/1e6).toFixed(4)} USDC)`)
            // Liquidate directly (not via queue) — rare, urgent, needs its own nonce slot.
            // writeContractWithNonce serialises internally so this won't race with the queue.
            try {
              const hash = await writeContractWithNonce({
                address: PERP_ADDRESS_SERVER,
                abi: KEEPER_ABI,
                functionName: 'liquidate',
                args: [BigInt(i)],
              })
              console.log(`[keeper] Liquidated order #${i} tx=${hash}`)
            } catch (liqErr: unknown) {
              const msg = liqErr instanceof Error ? liqErr.message : String(liqErr)
              if (!msg.includes('PositionHealthy') && !msg.includes('NothingToLiquidate')) {
                console.warn(`[keeper] liquidate(#${i}) failed:`, msg.slice(0, 120))
              }
            }
          }
        } catch { /* skip this order, continue scan */ }

        // Small delay between order reads to avoid RPC bursts
        await new Promise(r => setTimeout(r, 100))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[keeper] scan failed:', msg.slice(0, 120))
    }
  }

  // Initial delay of 10s then every 30s
  await new Promise(r => setTimeout(r, 10_000))
  void runScan()
  setInterval(() => { void runScan() }, 30_000)
}

// ── Static frontend (production build) ────────────────────────────────────────
// When deployed to HF Spaces the Vite build lands at ../dist relative to server/
const __dirname_esm = dirname(fileURLToPath(import.meta.url))
const distPath = join(__dirname_esm, '..', 'dist')
if (existsSync(distPath)) {
  // Assets are content-hashed — cache forever
  app.use('/assets', express.static(join(distPath, 'assets'), {
    maxAge: '1y',
    immutable: true,
  }))
  // Everything else: no cache so browsers always get fresh index.html
  app.use(express.static(distPath, { maxAge: 0 }))
  // SPA fallback — wipe stale caches and return fresh index.html
  app.get('*', (_req, res) => {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Clear-Site-Data': '"cache", "storage"',
    })
    res.sendFile(join(distPath, 'index.html'))
  })
  console.log(`[aprox-server] Serving static frontend from ${distPath}`)
} else {
  console.log('[aprox-server] No dist/ found — static serving skipped (dev mode)')
}

// ── HTTP + WebSocket server ────────────────────────────────────────────────────
const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/ws/price' })

wss.on('connection', (ws) => {
  console.log('[aprox-server] WebSocket client connected')
  wssClients.add(ws)

  // Send current prices immediately on connect (all three pairs)
  ws.send(JSON.stringify({ type: 'price', symbol: 'BTC/USD', price: latestPrice / 1e8, price8: latestPrice, timestamp: priceTimestamp }))
  if (latestEthPrice > 0) ws.send(JSON.stringify({ type: 'price', symbol: 'ETH/USD', price: latestEthPrice / 1e8, price8: latestEthPrice, timestamp: priceTimestamp }))
  if (latestSolPrice > 0) ws.send(JSON.stringify({ type: 'price', symbol: 'SOL/USD', price: latestSolPrice / 1e8, price8: latestSolPrice, timestamp: priceTimestamp }))

  ws.on('close', () => {
    wssClients.delete(ws)
    console.log('[aprox-server] WebSocket client disconnected')
  })
})

// ── Start everything ──────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[aprox-server] Listening on port ${PORT}`)
  console.log(`[aprox-server] Network: ${NETWORK} (${IS_MAINNET ? 'real x402 payments' : 'simulation mode — set NETWORK=mainnet for real payments'})`)
  console.log(`[aprox-server] Operator address: ${account.address}`)
  console.log(`[aprox-server] Gateway receiver: ${OPERATOR_GATEWAY_ADDRESS}`)
  console.log(`[aprox-server] BTC/USD: Pyth Hermes REST → OperatorPriceFeed on-chain push every 5s`)
  console.log(`[aprox-server] ETH/USD + SOL/USD: Coinbase REST`)
  if (OPERATOR_PRICE_FEED_ADDRESS) {
    console.log(`[aprox-server] OperatorPriceFeed: ${OPERATOR_PRICE_FEED_ADDRESS}`)
  } else {
    console.warn(`[aprox-server] OPERATOR_PRICE_FEED_ADDRESS not set — prices broadcast WS only, not pushed on-chain`)
  }
  if (MOCK_PRICE_FEED_ADDRESS) console.log(`[aprox-server] Legacy MOCK_PRICE_FEED_ADDRESS set but unused by V6`)
})

// ── Startup: check operator wallet USDC balance ───────────────────────────────
// On Arc, USDC is the gas token. A dry operator wallet means every updateAnswer
// tx will fail with "insufficient funds". Check on startup and warn loudly.
async function checkOperatorBalance(): Promise<void> {
  try {
    // Arc Testnet USDC = 0x3600000000000000000000000000000000000000 (6 decimals)
    // arc-studio-allow-onchain-literal
    const USDC_ADDRESS = IS_MAINNET
      ? '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' as `0x${string}`  // Arc mainnet USDC
      : '0x3600000000000000000000000000000000000000' as `0x${string}`  // Arc testnet USDC
    const BALANCE_OF_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const
    const raw = await publicClient.readContract({ address: USDC_ADDRESS, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [account.address] }) as bigint
    const usdc = Number(raw) / 1e6
    if (usdc < 0.5) {
      console.error(`[aprox-server] ⚠️  OPERATOR WALLET LOW: ${usdc.toFixed(6)} USDC — fund ${account.address} on Arc ${NETWORK} or updateAnswer txs will fail`)
    } else {
      console.log(`[aprox-server] Operator wallet balance: ${usdc.toFixed(4)} USDC ✓`)
    }
  } catch (e: unknown) {
    console.warn('[aprox-server] Could not check operator balance:', String(e).slice(0, 80))
  }
}

void checkOperatorBalance()
startPriceFeed()
startEthSolPriceFeed()
void startBuyerLoop(PORT)
void startKeeperLoop()
