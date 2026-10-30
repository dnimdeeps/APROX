/**
 * useOraclePrice — polls the OperatorPriceFeed (AggregatorV3Interface) every 3s.
 *
 * Testnet: reads OperatorPriceFeed.sol — the server pushes Pyth Hermes BTC/USD
 *          every 5s, so this hook sees a fresh price within 5s of any market move.
 * Mainnet: same hook reads a Chainlink Data Streams adapter at the same address
 *          slot — sub-second updates, no code change needed.
 *
 * The returned price is the EXACT value AproxPerpV7 uses for settlement.
 * PnL computed by useLivePnl (via computeLivePnl on the contract) therefore
 * matches what closeOrder will settle at — no divergence ever.
 *
 * Feed decimals: OperatorPriceFeed uses 8 decimals (same as Chainlink).
 * This hook returns both a plain USD float and the raw 8-dec bigint.
 */

import { useState, useEffect, useRef } from 'react'
import { publicClient } from './useModularWallet'
import { IS_MAINNET } from '@/network'

// Poll every 3s — feed is pushed every 5s; 3s gives snappy display without
// hammering the public RPC (last-write wins; duplicate reads are harmless).
const POLL_INTERVAL_MS = 3_000
// Stagger startup: oracle fires at t=0.6s, PnL at t=1.5s — never same tick.
const STARTUP_DELAY_MS = 600

// AggregatorV3Interface — same for OperatorPriceFeed and Chainlink DS adapters.
const AGGREGATOR_ABI = [
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
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

// Feed addresses read from env — branched by network.
// Testnet: OperatorPriceFeed.sol contracts pushed by the Render server (Pyth).
// Mainnet: Chainlink Data Feed proxy contracts (AggregatorV3Interface, 8 decimals, same ABI).
//   Set VITE_MAINNET_BTC_FEED, VITE_MAINNET_ETH_FEED, VITE_MAINNET_SOL_FEED on Vercel.
//   Get addresses from data.chain.link → network: Arc Mainnet.
// arc-studio-allow-onchain-literal
const FEEDS: Array<{ symbol: string; address: `0x${string}` }> = IS_MAINNET
  ? [
      { symbol: 'BTC/USD', address: (import.meta.env.VITE_MAINNET_BTC_FEED ?? '') as `0x${string}` },
      { symbol: 'ETH/USD', address: (import.meta.env.VITE_MAINNET_ETH_FEED ?? '') as `0x${string}` },
      { symbol: 'SOL/USD', address: (import.meta.env.VITE_MAINNET_SOL_FEED ?? '') as `0x${string}` },
    ].filter(f => !!f.address)
  : [
      { symbol: 'BTC/USD', address: (import.meta.env.VITE_OPERATOR_PRICE_FEED_ADDRESS ?? '') as `0x${string}` },
      { symbol: 'ETH/USD', address: (import.meta.env.VITE_ETH_PRICE_FEED_ADDRESS ?? '') as `0x${string}` },
      { symbol: 'SOL/USD', address: (import.meta.env.VITE_SOL_PRICE_FEED_ADDRESS ?? '') as `0x${string}` },
    ].filter(f => !!f.address)
// Primary feed (BTC/USD) for backwards-compatible price/price8/ageSeconds fields
const FEED_ADDRESS = FEEDS[0]?.address ?? '' as `0x${string}`

// Staleness threshold for UI warning only — not used for contract settlement.
// Testnet: AproxPerpV7.MAX_ORACLE_STALENESS = 120s (Pyth push every 30s).
// Mainnet: Chainlink feeds heartbeat 24h, deviation 0.5% — use 86400s (24h) so
//          the UI never false-alarms on a quiet market where price hasn't moved 0.5%.
const MAX_STALENESS_S = IS_MAINNET ? 86_400 : 120

export interface OraclePriceState {
  /** Plain USD float, e.g. 80735.39 */
  price: number | null
  /** Raw bigint from the feed (8 decimals), e.g. 8073539000n */
  price8: bigint | null
  /** Unix timestamp (seconds) when the feed was last pushed */
  updatedAt: number | null
  /** Age of the oracle price in seconds (null until first read) */
  ageSeconds: number | null
  /** true if the feed is older than MAX_STALENESS_S */
  isStale: boolean
  /** Per-pair map: symbol → USD float */
  prices: Record<string, number>
  /** Per-pair map: symbol → raw bigint */
  prices8: Record<string, bigint>
  /** Whether at least one feed read has succeeded */
  isReady: boolean
}

export function useOraclePrice(): OraclePriceState {
  const [state, setState] = useState<OraclePriceState>({
    price: null, price8: null, updatedAt: null, ageSeconds: null,
    isStale: false, prices: {}, prices8: {}, isReady: false,
  })

  const mountedRef  = useRef(true)
  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastAnswer  = useRef<bigint>(0n)
  const isReadyRef  = useRef(false)

  useEffect(() => {
    mountedRef.current = true

    async function fetchPrice() {
      if (!mountedRef.current) return
      if (FEEDS.length === 0) return   // no feed addresses configured

      try {
        // Fetch all feeds in parallel — each is one eth_call
        const results = await Promise.all(
          FEEDS.map(f => publicClient.readContract({
            address: f.address,
            abi: AGGREGATOR_ABI,
            functionName: 'latestRoundData',
          }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>)
        )

        if (!mountedRef.current) return

        const prices: Record<string, number>  = {}
        const prices8: Record<string, bigint> = {}
        let btcAnswer = 0n
        let btcUpdatedAt = 0n

        for (let i = 0; i < FEEDS.length; i++) {
          const [, answer, , updatedAt] = results[i]
          if (answer <= 0n) continue
          prices[FEEDS[i].symbol]  = Number(answer) / 1e8
          prices8[FEEDS[i].symbol] = answer
          if (FEEDS[i].symbol === 'BTC/USD') { btcAnswer = answer; btcUpdatedAt = updatedAt }
        }

        // btcAnswer === 0n means OperatorPriceFeed has never had a price pushed
        // (constructor sets _answer = 0). Show isStale=true, isReady=true so the
        // UI shows "Oracle stale" instead of "Reading oracle…" forever.
        if (btcAnswer === 0n) {
          if (!isReadyRef.current) {
            setState(prev => ({ ...prev, isStale: true, isReady: true }))
            isReadyRef.current = true
          }
          return
        }

        // Skip setState when BTC answer hasn't changed — avoids re-render storms
        if (btcAnswer === lastAnswer.current && isReadyRef.current) return
        lastAnswer.current = btcAnswer

        const now        = Math.floor(Date.now() / 1_000)
        const priceUsd   = Number(btcAnswer) / 1e8
        const updatedAtN = Number(btcUpdatedAt)
        const ageSeconds = now - updatedAtN
        const isStale    = ageSeconds > MAX_STALENESS_S

        setState({
          price:     priceUsd,
          price8:    btcAnswer,
          updatedAt: updatedAtN,
          ageSeconds,
          isStale,
          prices,
          prices8,
          isReady:   true,
        })
        isReadyRef.current = true
      } catch {
        // RPC hiccup — keep previous state, retry on next tick
      }
    }

    const startTimer = setTimeout(() => {
      void fetchPrice()
      timerRef.current = setInterval(() => { void fetchPrice() }, POLL_INTERVAL_MS)
    }, STARTUP_DELAY_MS)

    return () => {
      mountedRef.current = false
      clearTimeout(startTimer)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  return state
}
