/**
 * retryTransport — wraps a viem HTTP transport with exponential backoff
 * for 429 Too Many Requests and 5xx transient errors.
 *
 * The Arc Testnet public RPC (rpc.testnet.arc.io) has a low rate limit.
 * Without retries a burst of eth_call reads (balance + orders scan) hits
 * 429 and silently fails, making the UI show stale data or ghost errors.
 */

import { http, fallback } from 'viem'

const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.io'
const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io'

/**
 * Returns a viem transport with built-in retry and backoff for Arc RPC calls.
 *
 * viem's http() transport supports `retryCount` and `retryDelay` natively.
 * We stack two endpoints in a fallback so a persistent 429 from the first
 * automatically routes to the second (same host here, but the retry window
 * resets between them, giving a second chance without custom middleware).
 *
 * retryCount: 3  — retries up to 3× per request
 * retryDelay: exponential starting at 500ms (500 → 1000 → 2000ms)
 * timeout:    10s per attempt
 */
export function makeArcTransport(isMainnet: boolean) {
  const url = isMainnet ? ARC_MAINNET_RPC : ARC_TESTNET_RPC

  const primary = http(url, {
    retryCount: 3,
    retryDelay: 1000,
    timeout: 10_000,
    batch: { batchSize: 8 },
  })

  // Fallback to the same endpoint — gives a clean retry window after primary exhausts
  const secondary = http(url, {
    retryCount: 2,
    retryDelay: 1000,
    timeout: 10_000,
  })

  return fallback([primary, secondary], { rank: false })
}
