/**
 * useMarketDepth — reads pendingLong/pendingShort for each leverage tier
 * across all trading pairs via getMarketDepth() on AproxPerpV7.
 * Polls every 10s. Uses a single Multicall3 batch.
 */

import { useState, useEffect, useRef } from 'react'
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from 'viem'
import { publicClient } from './useModularWallet'
import { IS_MAINNET } from '@/network'
import { PAIR_BTC_USD, PAIR_ETH_USD, PAIR_SOL_USD, TRADING_PAIRS } from './useAproxContract'

const PERP_ADDRESS = (IS_MAINNET
  ? (import.meta.env.VITE_MAINNET_APROX_PERP_ADDRESS ?? '')
  : (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '')) as Hex

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex

const DEPTH_ABI = parseAbi([
  'function getMarketDepth(uint8 leverage, bytes32 pairId) external view returns (uint256 pendingLong, uint256 pendingShort)',
])

const MC_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
])

// Leverage tiers to show
export const LEVERAGE_TIERS = [2, 5, 10, 25, 50, 100] as const

export interface DepthEntry {
  leverage: number
  pairId: Hex
  pairLabel: string
  pendingLong: bigint   // 6-dec USDC
  pendingShort: bigint
}

export function useMarketDepth() {
  const [depth, setDepth] = useState<DepthEntry[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    async function poll() {
      if (!PERP_ADDRESS || !mountedRef.current) return
      try {
        const pairs: Array<{ id: Hex; label: string }> = [
          { id: PAIR_BTC_USD, label: 'BTC/USD' },
          { id: PAIR_ETH_USD, label: 'ETH/USD' },
          { id: PAIR_SOL_USD, label: 'SOL/USD' },
        ]

        // Build one call per (leverage × pair)
        const calls: Array<{ target: Hex; allowFailure: boolean; callData: Hex }> = []
        const meta: Array<{ leverage: number; pairId: Hex; pairLabel: string }> = []

        for (const lev of LEVERAGE_TIERS) {
          for (const pair of pairs) {
            calls.push({
              target: PERP_ADDRESS,
              allowFailure: true,
              callData: encodeFunctionData({ abi: DEPTH_ABI, functionName: 'getMarketDepth', args: [lev, pair.id] }),
            })
            meta.push({ leverage: lev, pairId: pair.id, pairLabel: pair.label })
          }
        }

        const results = await publicClient.readContract({
          address: MULTICALL3,
          abi: MC_ABI,
          functionName: 'aggregate3',
          args: [calls],
        }) as Array<{ success: boolean; returnData: Hex }>

        const entries: DepthEntry[] = []
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          const m = meta[i]
          if (!r.success || !r.returnData || r.returnData === '0x') {
            entries.push({ ...m, pendingLong: 0n, pendingShort: 0n })
            continue
          }
          const decoded = decodeFunctionResult({ abi: DEPTH_ABI, functionName: 'getMarketDepth', data: r.returnData }) as [bigint, bigint]
          entries.push({ ...m, pendingLong: decoded[0], pendingShort: decoded[1] })
        }

        if (mountedRef.current) {
          setDepth(entries)
          setLoading(false)
        }
      } catch {
        // silent — stale depth is fine
        if (mountedRef.current) setLoading(false)
      }
    }

    void poll()
    const timer = setInterval(() => { void poll() }, 10_000)
    return () => { mountedRef.current = false; clearInterval(timer) }
  }, [])

  return { depth, loading }
}
