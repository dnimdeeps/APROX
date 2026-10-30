/**
 * retryTransport — viem HTTP transport with 429-aware backoff for Arc RPC.
 *
 * Priority order for the RPC endpoint:
 *   1. Arc Studio RPC proxy (VITE_RPC_PROXY_BASE_URL + VITE_RPC_PROXY_TOKEN) —
 *      higher rate limits, set automatically in Vercel/studio environments.
 *   2. Public Arc RPC (rpc.testnet.arc.io / rpc.arc.io) — low rate limit,
 *      used as fallback when the proxy is not configured.
 *
 * Both paths use viem's built-in retryCount/retryDelay so transient 429s and
 * 5xx errors are retried with exponential backoff before surfacing to the UI.
 *
 * JSON-RPC batching (batchSize: 20) collapses multiple eth_call requests that
 * happen in the same JS tick into a single HTTP round-trip.  The multicall3
 * helper in useAproxContract already merges order reads into one call; batching
 * here catches any remaining stragglers (balance reads, depth queries).
 */

import { http, fallback } from 'viem'

const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.io'
const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io'

// Arc Studio RPC proxy — present in Vercel and studio sandbox environments.
// Key is VITE_-prefixed so Vite exposes it to the browser bundle.
const PROXY_BASE  = import.meta.env.VITE_RPC_PROXY_BASE_URL as string | undefined
const PROXY_TOKEN = import.meta.env.VITE_RPC_PROXY_TOKEN    as string | undefined
const PROXY_CHAINS = (import.meta.env.VITE_RPC_PROXY_CHAINS as string | undefined) ?? ''

function proxyUrl(chainKey: string): string | null {
  if (!PROXY_BASE || !PROXY_TOKEN) return null
  if (!PROXY_CHAINS.split(',').map(s => s.trim()).includes(chainKey)) return null
  return `${PROXY_BASE}/api/rpc/${chainKey}?_rpc_token=${PROXY_TOKEN}`
}

/**
 * makeArcTransport(isMainnet)
 *
 * Returns a transport that:
 *  - Prefers the RPC proxy when available (no rate-limit issues).
 *  - Falls back to the public endpoint with retry/backoff.
 *  - Batches JSON-RPC calls to reduce raw request count.
 */
export function makeArcTransport(isMainnet: boolean) {
  const publicUrl  = isMainnet ? ARC_MAINNET_RPC : ARC_TESTNET_RPC
  const chainKey   = isMainnet ? 'Arc'           : 'Arc_Testnet'
  const url        = proxyUrl(chainKey) ?? publicUrl

  // Primary: proxy (or public). Batch up to 20 calls per HTTP request so a
  // single refresh tick (balance + orders) doesn't fire dozens of separate POSTs.
  // retryCount reduced from 3→1 on proxy, 2→1 on public.
  // With the old counts a single 429 triggered up to 3 retries = 4× the requests,
  // spiralling into sustained rate-limit loops. Our app-level backoff in
  // useLivePnl and TradingPanel.refresh handles retries at the right cadence.
  const primary = http(url, {
    retryCount: 1,
    retryDelay: 1_000,
    timeout: 15_000,
    batch: { batchSize: 20 },
  })

  const secondary = http(publicUrl, {
    retryCount: 1,
    retryDelay: 2_000,
    timeout: 15_000,
    batch: { batchSize: 10 },
  })

  return fallback([primary, secondary], { rank: false })
}
