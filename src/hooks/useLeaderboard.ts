/**
 * useLeaderboard — discovers all unique traders from OrderMatched + OrderClosed
 * events (last 5000 blocks) then reads getStats() for each in one Multicall3 batch.
 *
 * Returns a sorted array by win rate (default), refreshed every 30s.
 * All data is on-chain — no backend, fully trustless.
 */

import { useState, useEffect, useRef } from 'react'
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from 'viem'
import { publicClient } from './useModularWallet'
import type { TraderStats } from './useAproxContract'

const PERP_ADDRESS   = (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '') as Hex
const MULTICALL3     = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex
const POLL_MS        = 30_000
const LOOKBACK       = 5_000n

export type SortKey = 'winRate' | 'totalWins' | 'bestStreak' | 'totalVolume' | 'totalMatches'

export interface LeaderboardEntry {
  address: Hex
  stats: TraderStats
  winRate: number   // 0-100
}

const STATS_ABI = parseAbi([
  'function getStats(address trader) external view returns ((uint256 totalMatches, uint256 totalWins, uint256 totalLosses, uint256 totalVolume, uint256 winStreak, uint256 bestStreak))',
])

const MULTICALL_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
])

const ORDER_MATCHED_EVENT = {
  type: 'event' as const,
  name: 'OrderMatched',
  inputs: [
    { name: 'pairId',           type: 'uint256' as const, indexed: true  },
    { name: 'longOrderId',      type: 'uint256' as const, indexed: true  },
    { name: 'shortOrderId',     type: 'uint256' as const, indexed: true  },
    { name: 'lockedCollateral', type: 'uint256' as const, indexed: false },
    { name: 'price',            type: 'int256'  as const, indexed: false },
  ],
}

const ORDER_OPENED_EVENT = {
  type: 'event' as const,
  name: 'OrderOpened',
  inputs: [
    { name: 'orderId',     type: 'uint256'  as const, indexed: true  },
    { name: 'trader',      type: 'address'  as const, indexed: true  },
    { name: 'isLong',      type: 'bool'     as const, indexed: false },
    { name: 'leverage',    type: 'uint8'    as const, indexed: false },
    { name: 'collateral',  type: 'uint256'  as const, indexed: false },
  ],
}

export function useLeaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let timer: ReturnType<typeof setTimeout>

    async function load() {
      if (!PERP_ADDRESS || !mountedRef.current) return
      try {
        const head = await publicClient.getBlockNumber()
        const from = head > LOOKBACK ? head - LOOKBACK : 0n

        // Discover traders from OrderOpened events (direct trader index)
        const openedLogs = await publicClient.getLogs({
          address: PERP_ADDRESS,
          event: ORDER_OPENED_EVENT,
          fromBlock: from,
        })

        const traders = new Set<Hex>()
        for (const log of openedLogs) {
          const args = log.args as { trader?: string }
          if (args.trader) traders.add(args.trader as Hex)
        }

        if (traders.size === 0) {
          if (mountedRef.current) { setEntries([]); setLoading(false) }
          return
        }

        // Batch getStats for all traders via Multicall3
        const addrs = Array.from(traders)
        const calls = addrs.map(addr => ({
          target: PERP_ADDRESS,
          allowFailure: true,
          callData: encodeFunctionData({ abi: STATS_ABI, functionName: 'getStats', args: [addr] }),
        }))

        const results = await publicClient.readContract({
          address: MULTICALL3,
          abi: MULTICALL_ABI,
          functionName: 'aggregate3',
          args: [calls],
        }) as Array<{ success: boolean; returnData: Hex }>

        const leaderboard: LeaderboardEntry[] = []
        for (let i = 0; i < addrs.length; i++) {
          const r = results[i]
          if (!r.success || r.returnData === '0x') continue
          try {
            const decoded = decodeFunctionResult({
              abi: STATS_ABI,
              functionName: 'getStats',
              data: r.returnData,
            }) as { totalMatches: bigint; totalWins: bigint; totalLosses: bigint; totalVolume: bigint; winStreak: bigint; bestStreak: bigint }
            const stats: TraderStats = decoded
            const closed = Number(stats.totalWins + stats.totalLosses)
            const winRate = closed > 0 ? (Number(stats.totalWins) / closed) * 100 : 0
            leaderboard.push({ address: addrs[i], stats, winRate })
          } catch { /* skip decode failures */ }
        }

        // Default sort: win rate desc, then total wins desc
        leaderboard.sort((a, b) =>
          b.winRate !== a.winRate
            ? b.winRate - a.winRate
            : Number(b.stats.totalWins - a.stats.totalWins)
        )

        if (mountedRef.current) {
          setEntries(leaderboard)
          setLoading(false)
        }
      } catch {
        if (mountedRef.current) setLoading(false)
      }
      if (mountedRef.current) timer = setTimeout(load, POLL_MS)
    }

    void load()
    return () => {
      mountedRef.current = false
      clearTimeout(timer)
    }
  }, [])

  return { entries, loading }
}
