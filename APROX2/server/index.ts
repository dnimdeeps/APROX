/**
 * Aprox Operator Server
 *
 * Responsibilities:
 * 1. Mock BTC/USD price oscillator (sandbox mode — no Binance WS access)
 * 2. Push latest price on-chain to MockPriceFeed.sol every ~1 second
 * 3. Sell price via x402 Gateway Nanopayments — GET /price costs 0.0001 USDC
 * 4. Run a real GatewayClient buyer loop every 5s, emit real payment receipts
 *    over WebSocket so the NanopaymentFeed shows genuine on-chain tx hashes
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
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toBytes } from 'viem'
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
const MOCK_PRICE_FEED_ADDRESS = envAddr('MOCK_PRICE_FEED_ADDRESS')
const PRICE_FEED_ETH = envAddrOpt('PRICE_FEED_ETH')
const PRICE_FEED_SOL = envAddrOpt('PRICE_FEED_SOL')
const BUYER_PRIVATE_KEY = envAddrOpt('BUYER_PRIVATE_KEY')
const APROX_PERP_ADDRESS = envAddrOpt('APROX_PERP_ADDRESS')
const PORT = parseInt(process.env.PORT ?? '3001', 10)

// NETWORK=mainnet enables real Circle Gateway x402 verify/settle (Arc Mainnet only).
// On testnet the buyer loop emits honest "testnet-simulation" events — the full
// x402 architecture is wired, Circle's facilitator API just doesn't support testnets.
const NETWORK = (process.env.NETWORK ?? 'testnet') as 'testnet' | 'mainnet'
const IS_MAINNET = NETWORK === 'mainnet'

// Price-push chain: Arc Testnet when NETWORK=testnet, Arc Mainnet when NETWORK=mainnet.
// Contracts must match the chain — testnet contracts on testnet, mainnet contracts on mainnet.
const VIEM_CHAIN = IS_MAINNET ? arc : arcTestnet
const GATEWAY_CHAIN = IS_MAINNET ? 'arc' : 'arcTestnet'

if (!OPERATOR_PRIVATE_KEY || !OPERATOR_GATEWAY_ADDRESS || !MOCK_PRICE_FEED_ADDRESS) {
  console.error('[aprox-server] Missing required env vars. Check server/.env')
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
  : IS_MAINNET ? 'https://rpc.arc.io' : 'https://rpc.testnet.arc.io' // arc-studio-allow-onchain-literal

const walletClient = createWalletClient({
  chain: VIEM_CHAIN,
  account,
  transport: http(RPC_URL),
})

const publicClient = createPublicClient({
  chain: VIEM_CHAIN,
  transport: http(RPC_URL),
})

const PRICE_FEED_ABI = parseAbi([
  'function updatePrice(int256 newPrice) external',
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

const PERP_ABI = parseAbi([
  'function setPriceFeed(bytes32 pairId, address feed) external',
  'function getPriceFeed(bytes32 pairId) external view returns (address)',
  'function owner() external view returns (address)',
])

// Pair IDs — keccak256 of raw UTF-8 bytes, matching Solidity keccak256("BTC/USD")
const PAIR_BTC_USD = keccak256(toBytes('BTC/USD'))
const PAIR_ETH_USD = keccak256(toBytes('ETH/USD'))
const PAIR_SOL_USD = keccak256(toBytes('SOL/USD'))

/**
 * ensurePriceFeeds — registers price feed addresses on the AproxPerp contract
 * if they are not already set. Runs once at server startup. The operator wallet
 * must be the contract owner for setPriceFeed to succeed.
 */
async function ensurePriceFeeds() {
  if (!APROX_PERP_ADDRESS) {
    console.log('[aprox-server] APROX_PERP_ADDRESS not set — skipping setPriceFeed bootstrap')
    return
  }

  const feeds: Array<{ pairId: `0x${string}`; feed: `0x${string}`; name: string }> = [
    { pairId: PAIR_BTC_USD, feed: MOCK_PRICE_FEED_ADDRESS, name: 'BTC/USD' },
  ]
  if (PRICE_FEED_ETH) feeds.push({ pairId: PAIR_ETH_USD, feed: PRICE_FEED_ETH, name: 'ETH/USD' })
  if (PRICE_FEED_SOL) feeds.push({ pairId: PAIR_SOL_USD, feed: PRICE_FEED_SOL, name: 'SOL/USD' })

  for (const { pairId, feed, name } of feeds) {
    try {
      const current = await publicClient.readContract({
        address: APROX_PERP_ADDRESS,
        abi: PERP_ABI,
        functionName: 'getPriceFeed',
        args: [pairId],
      })
      if (current.toLowerCase() === feed.toLowerCase()) {
        console.log(`[aprox-server] ${name} price feed already registered: ${feed}`)
        continue
      }
      console.log(`[aprox-server] Registering ${name} price feed: ${feed}`)
      const hash = await walletClient.writeContract({
        address: APROX_PERP_ADDRESS,
        abi: PERP_ABI,
        functionName: 'setPriceFeed',
        args: [pairId, feed],
      })
      console.log(`[aprox-server] ${name} setPriceFeed tx: ${hash}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[aprox-server] Failed to register ${name} price feed:`, msg.slice(0, 200))
    }
  }
}

// ── Price state ────────────────────────────────────────────────────────────────
let latestPrice: number = 65_000 * 1e8
let latestEthPrice: number = 2_600 * 1e8
let latestSolPrice: number = 170 * 1e8
let lastPushedPrice: number = 0
let lastPushedEthPrice: number = 0
let lastPushedSolPrice: number = 0
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

// ── Mock BTC price oscillator (last-resort fallback only) ────────────────────
let mockSeed = latestPrice

function tickMockPrice() {
  const bps = (Math.random() - 0.5) * 10  // ±5 BPS per tick (~0.05%)
  const delta = Math.round(mockSeed * bps / 10_000)
  mockSeed = Math.max(1_000 * 1e8, mockSeed + delta)
  latestPrice = Math.round(mockSeed)
  priceTimestamp = Date.now()
  broadcastAllPrices(priceTimestamp)
}

// ── Multi-source Real BTC/USD price fallback (Coinbase -> Binance -> CoinGecko) ──
async function fetchRealPrice(): Promise<number | null> {
  // 1. Try Coinbase REST (highly reliable, no key, no cloud block)
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = await res.json() as { data?: { amount?: string } }
      const amt = parseFloat(data?.data?.amount ?? '')
      if (amt > 0) return Math.round(amt * 1e8)
    }
  } catch { /* try next */ }

  // 2. Try Binance REST (fast spot ticker)
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = await res.json() as { price?: string }
      const amt = parseFloat(data?.price ?? '')
      if (amt > 0) return Math.round(amt * 1e8)
    }
  } catch { /* try next */ }

  // 3. Try CoinGecko REST
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const data = await res.json() as { bitcoin?: { usd?: number } }
      const usd = data?.bitcoin?.usd
      if (usd && usd > 0) return Math.round(usd * 1e8)
    }
  } catch { /* fallback to null */ }

  return null
}

// ── Fetch ETH and SOL prices (Coinbase REST, 5s interval) ───────────────────
async function fetchEthSolPrices(): Promise<void> {
  try {
    const [ethRes, solRes] = await Promise.all([
      fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(5000) }),
      fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: AbortSignal.timeout(5000) }),
    ])
    if (ethRes.ok) {
      const data = await ethRes.json() as { data?: { amount?: string } }
      const amt = parseFloat(data?.data?.amount ?? '')
      if (amt > 0) latestEthPrice = Math.round(amt * 1e8)
    }
    if (solRes.ok) {
      const data = await solRes.json() as { data?: { amount?: string } }
      const amt = parseFloat(data?.data?.amount ?? '')
      if (amt > 0) latestSolPrice = Math.round(amt * 1e8)
    }
  } catch { /* keep previous values */ }
}

// Start ETH/SOL price polling (5s interval, independent of BTC feed)
function startEthSolPriceFeed() {
  void fetchEthSolPrices()
  setInterval(() => { void fetchEthSolPrices() }, 5000)
}

// ── Real BTC/USD price via Binance WebSocket (primary) ───────────────────────
function startPriceFeed() {
  let mockInterval: ReturnType<typeof setInterval> | null = null
  let pollInterval: ReturnType<typeof setInterval> | null = null
  let binanceActive = false

  function startRestFallback() {
    if (pollInterval) return
    console.log('[aprox-server] Starting real price REST polling (Coinbase/Binance, 5s interval)')
    // Fetch immediately, then every 5s
    void fetchRealPrice().then((p) => {
      if (p && !binanceActive) {
        latestPrice = p; mockSeed = p; priceTimestamp = Date.now()
        broadcastAllPrices(priceTimestamp)
        console.log(`[aprox-server] Real BTC price: $${(p / 1e8).toFixed(2)}`)
      }
    })
    pollInterval = setInterval(async () => {
      if (binanceActive) return
      const p = await fetchRealPrice()
      if (p) {
        latestPrice = p; mockSeed = p; priceTimestamp = Date.now()
        broadcastAllPrices(priceTimestamp)
      } else {
        startMockFallback()
      }
    }, 5000)
  }

  function stopRestFallback() {
    if (!pollInterval) return
    clearInterval(pollInterval)
    pollInterval = null
  }

  function startMockFallback() {
    if (mockInterval) return
    console.log('[aprox-server] External feeds unreachable — falling back to mock oscillator')
    mockInterval = setInterval(tickMockPrice, 1000)
  }

  function stopMockFallback() {
    if (!mockInterval) return
    clearInterval(mockInterval)
    mockInterval = null
  }

  function connect() {
    const BINANCE_WS = 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade'
    const ws = new WebSocket(BINANCE_WS)

    const timeoutHandle = setTimeout(() => {
      console.log('[aprox-server] Binance WS timeout — switching to real REST fallback')
      try { ws.terminate() } catch { /* ignore */ }
      startRestFallback()
    }, 6000)

    ws.on('open', () => {
      clearTimeout(timeoutHandle)
      stopRestFallback()
      stopMockFallback()
      binanceActive = true
      console.log('[aprox-server] Connected to Binance BTC/USD real-time feed')
    })

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { p: string; T: number }
        const price = Math.round(parseFloat(msg.p) * 1e8)
        if (price > 0) {
          latestPrice = price
          mockSeed = price
          priceTimestamp = msg.T ?? Date.now()
          broadcastAllPrices(priceTimestamp)
        }
      } catch { /* ignore */ }
    })

    ws.on('close', () => {
      clearTimeout(timeoutHandle)
      binanceActive = false
      console.log('[aprox-server] Binance WS closed — real REST fallback active, retry WS in 10s')
      startRestFallback()
      setTimeout(connect, 10_000)
    })

    ws.on('error', (err: Error) => {
      clearTimeout(timeoutHandle)
      binanceActive = false
      console.log('[aprox-server] Binance WS error:', err.message.slice(0, 80), '— real REST fallback active')
      try { ws.terminate() } catch { /* ignore */ }
      startRestFallback()
    })
  }

  connect()
}

// ── On-chain price push loop (with smooth circuit-breaker ramping) ────────────
// pushOneFeed — attempts to push a single price update, retrying up to maxRetries
// times with exponential backoff on rate-limit errors. Returns true on success.
async function pushOneFeed(
  address: `0x${string}`,
  price: number,
  label: string,
  maxRetries = 3,
): Promise<boolean> {
  let delay = 2000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const hash = await walletClient.writeContract({
        address,
        abi: PRICE_FEED_ABI,
        functionName: 'updatePrice',
        args: [BigInt(price)],
      })
      console.log(`[aprox-server] ${label} price pushed: $${(price / 1e8).toFixed(2)} tx=${hash}`)
      return true
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('PriceChangeTooLarge')) {
        // Circuit breaker tripped — caller should step the price down; no point retrying same value
        console.log(`[aprox-server] ${label} circuit breaker: price move >20%, adapting step`)
        return false
      }
      if (message.includes('NotOperator')) {
        console.error(`[aprox-server] ${label} push rejected: operator wallet mismatch — check OPERATOR_PRIVATE_KEY`)
        return false
      }
      if (attempt < maxRetries) {
        const isRateLimit = message.includes('exceeds defined limit') || message.includes('rate') || message.includes('429')
        console.warn(`[aprox-server] ${label} push failed (attempt ${attempt + 1}/${maxRetries + 1})${isRateLimit ? ' [rate limit]' : ''} — retrying in ${delay / 1000}s`)
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 16000)
      } else {
        console.error(`[aprox-server] ${label} price push failed after ${maxRetries + 1} attempts:`, message.slice(0, 120))
      }
    }
  }
  return false
}

async function pushPriceLoop() {
  // Sync initial on-chain price on boot to avoid jumping from 0
  try {
    const roundData = await publicClient.readContract({
      address: MOCK_PRICE_FEED_ADDRESS,
      abi: PRICE_FEED_ABI,
      functionName: 'latestRoundData',
    })
    lastPushedPrice = Number(roundData[1])
    console.log(`[aprox-server] Current on-chain BTC price: $${(lastPushedPrice / 1e8).toFixed(2)}`)
  } catch (err: unknown) {
    console.warn('[aprox-server] Could not fetch initial on-chain price:', (err as Error).message.slice(0, 100))
  }

  // Track when we last successfully pushed so we can detect staleness proactively.
  let lastSuccessfulPushAt = Date.now()

  while (true) {
    // Push every 20 seconds. The contract allows 1 hour of staleness, so 20s gives
    // 180 attempts per hour — plenty of headroom even if most are rate-limited.
    // Previously at 1s the RPC started returning "Request exceeds defined limit"
    // which caused all pushes to fail and the feed to go stale.
    await new Promise((r) => setTimeout(r, 20_000))

    const now = Date.now()

    // Smooth ramping: step at most 15% per push so the 20% circuit breaker is never tripped
    // even after a gap (e.g. after a Railway restart where price moved a lot)
    let priceToPush = latestPrice
    if (lastPushedPrice > 0) {
      const maxDelta = Math.floor(lastPushedPrice * 15 / 100)
      if (priceToPush > lastPushedPrice + maxDelta) priceToPush = lastPushedPrice + maxDelta
      else if (priceToPush < lastPushedPrice - maxDelta) priceToPush = lastPushedPrice - maxDelta
    }

    // Always push if price changed. Also force a push every 10 minutes even if price
    // is the same — this keeps the on-chain timestamp fresh and prevents the feed going
    // stale during a flat market or when all REST fetches return the same value.
    const priceChanged = priceToPush !== lastPushedPrice
    const refreshNeeded = now - lastSuccessfulPushAt > 10 * 60 * 1000

    if (priceChanged || refreshNeeded) {
      const ok = await pushOneFeed(MOCK_PRICE_FEED_ADDRESS, priceToPush, 'BTC')
      if (ok) {
        lastPushedPrice = priceToPush
        lastSuccessfulPushAt = now
      }
    }

    // Push ETH if feed is configured and price has changed
    if (PRICE_FEED_ETH) {
      let ethToPush = latestEthPrice
      if (lastPushedEthPrice > 0) {
        const maxDelta = Math.floor(lastPushedEthPrice * 15 / 100)
        if (ethToPush > lastPushedEthPrice + maxDelta) ethToPush = lastPushedEthPrice + maxDelta
        else if (ethToPush < lastPushedEthPrice - maxDelta) ethToPush = lastPushedEthPrice - maxDelta
      }
      if (ethToPush !== lastPushedEthPrice || refreshNeeded) {
        const ok = await pushOneFeed(PRICE_FEED_ETH, ethToPush, 'ETH')
        if (ok) lastPushedEthPrice = ethToPush
      }
    }

    // Push SOL if feed is configured and price has changed
    if (PRICE_FEED_SOL) {
      let solToPush = latestSolPrice
      if (lastPushedSolPrice > 0) {
        const maxDelta = Math.floor(lastPushedSolPrice * 15 / 100)
        if (solToPush > lastPushedSolPrice + maxDelta) solToPush = lastPushedSolPrice + maxDelta
        else if (solToPush < lastPushedSolPrice - maxDelta) solToPush = lastPushedSolPrice - maxDelta
      }
      if (solToPush !== lastPushedSolPrice || refreshNeeded) {
        const ok = await pushOneFeed(PRICE_FEED_SOL, solToPush, 'SOL')
        if (ok) lastPushedSolPrice = solToPush
      }
    }
  }
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

// GET /price/free — ungated internal endpoint
app.get('/price/free', (_req, res) => {
  res.json({
    symbol: 'BTC/USD',
    price: latestPrice / 1e8,
    price8: latestPrice,
    timestamp: priceTimestamp,
    note: 'Internal — not for user consumption',
  })
})

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', priceAge: Date.now() - priceTimestamp })
})

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
  console.log(`[aprox-server] Price feed contract (BTC): ${MOCK_PRICE_FEED_ADDRESS}`)
  if (PRICE_FEED_ETH) console.log(`[aprox-server] Price feed contract (ETH): ${PRICE_FEED_ETH}`)
  if (PRICE_FEED_SOL) console.log(`[aprox-server] Price feed contract (SOL): ${PRICE_FEED_SOL}`)
})

void ensurePriceFeeds()
startPriceFeed()
startEthSolPriceFeed()
void pushPriceLoop()
void startBuyerLoop(PORT)
