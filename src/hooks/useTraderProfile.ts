/**
 * useTraderProfile — loads full match history and stats for one wallet address.
 *
 * Reads:
 *  - getStats(address) from contract (win/loss/streak/volume)
 *  - OrderOpened events filtered by trader
 *  - OrderClosed events filtered by trader
 *  - Liquidated events filtered by trader (as victim)
 *  - LiquidationReMatched events where survivingOrderId matches one of trader's orders
 *
 * Builds a survival chain: sequences of consecutive re-matches from a single
 * starting order, showing how far the position compounded.
 */

import { useState, useEffect, useRef } from 'react'
import { parseAbi, type Hex } from 'viem'
import { publicClient } from './useModularWallet'
import type { TraderStats } from './useAproxContract'

const PERP_ADDRESS = (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '') as Hex
const LOOKBACK     = 5_000n

export interface MatchRecord {
  orderId: bigint
  blockNumber: bigint
  txHash: Hex
  outcome: 'win' | 'loss' | 'liquidated' | 'open'
  /** undefined = never matched */
  entryPrice?: bigint
}

export interface SurvivalChain {
  /** First orderId in the chain */
  startOrderId: bigint
  /** All orderIds in order (start → latest re-match) */
  chain: bigint[]
  length: number
}

export interface TraderProfile {
  address: Hex
  stats: TraderStats
  matches: MatchRecord[]
  survivalChains: SurvivalChain[]
  loading: boolean
}

const NULL_STATS: TraderStats = {
  totalMatches: 0n,
  totalWins: 0n,
  totalLosses: 0n,
  totalVolume: 0n,
  winStreak: 0n,
  bestStreak: 0n,
}

const STATS_ABI = parseAbi([
  'function getStats(address trader) external view returns ((uint256 totalMatches, uint256 totalWins, uint256 totalLosses, uint256 totalVolume, uint256 winStreak, uint256 bestStreak))',
])

const OPENED_EV = {
  type: 'event' as const,
  name: 'OrderOpened',
  inputs: [
    { name: 'orderId',    type: 'uint256' as const, indexed: true  },
    { name: 'trader',     type: 'address' as const, indexed: true  },
    { name: 'isLong',     type: 'bool'    as const, indexed: false },
    { name: 'leverage',   type: 'uint8'   as const, indexed: false },
    { name: 'collateral', type: 'uint256' as const, indexed: false },
  ],
}

const CLOSED_EV = {
  type: 'event' as const,
  name: 'OrderClosed',
  inputs: [
    { name: 'orderId', type: 'uint256' as const, indexed: true  },
    { name: 'trader',  type: 'address' as const, indexed: true  },
    { name: 'pnl',     type: 'int256'  as const, indexed: false },
    { name: 'payout',  type: 'uint256' as const, indexed: false },
  ],
}

const LIQUIDATED_EV = {
  type: 'event' as const,
  name: 'Liquidated',
  inputs: [
    { name: 'orderId',      type: 'uint256' as const, indexed: true  },
    { name: 'trader',       type: 'address' as const, indexed: true  },
    { name: 'keeper',       type: 'address' as const, indexed: true  },
    { name: 'keeperReward', type: 'uint256' as const, indexed: false },
  ],
}

const REMATCH_EV = {
  type: 'event' as const,
  name: 'LiquidationReMatched',
  inputs: [
    { name: 'liquidatedOrderId',   type: 'uint256' as const, indexed: true  },
    { name: 'survivingOrderId',    type: 'uint256' as const, indexed: true  },
    { name: 'newPairId',           type: 'uint256' as const, indexed: true  },
    { name: 'newLockedCollateral', type: 'uint256' as const, indexed: false },
    { name: 'newEntryPrice',       type: 'int256'  as const, indexed: false },
  ],
}

export function useTraderProfile(address: Hex | null): TraderProfile {
  const [profile, setProfile] = useState<TraderProfile>({
    address: (address ?? '0x') as Hex,
    stats: NULL_STATS,
    matches: [],
    survivalChains: [],
    loading: true,
  })
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    if (!address || !PERP_ADDRESS) {
      setProfile(p => ({ ...p, loading: false }))
      return
    }

    async function load() {
      if (!address) return
      try {
        const head = await publicClient.getBlockNumber()
        const from = head > LOOKBACK ? head - LOOKBACK : 0n

        const [statsRaw, openedLogs, closedLogs, liqLogs, rematchLogs] = await Promise.all([
          publicClient.readContract({
            address: PERP_ADDRESS, abi: STATS_ABI, functionName: 'getStats', args: [address],
          }) as Promise<{ totalMatches: bigint; totalWins: bigint; totalLosses: bigint; totalVolume: bigint; winStreak: bigint; bestStreak: bigint }>,
          publicClient.getLogs({ address: PERP_ADDRESS, event: OPENED_EV, args: { trader: address }, fromBlock: from }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: CLOSED_EV, args: { trader: address }, fromBlock: from }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: LIQUIDATED_EV, args: { trader: address }, fromBlock: from }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: REMATCH_EV, fromBlock: from }),
        ])

        const stats: TraderStats = statsRaw

        // Build outcome map: orderId → outcome
        const closedMap = new Map<string, 'win' | 'loss'>()
        for (const log of closedLogs) {
          const a = log.args as { orderId?: bigint; pnl?: bigint }
          if (!a.orderId) continue
          const pnl = a.pnl ?? 0n
          closedMap.set(a.orderId.toString(), pnl > 0n ? 'win' : 'loss')
        }
        const liqSet = new Set<string>()
        for (const log of liqLogs) {
          const a = log.args as { orderId?: bigint }
          if (a.orderId) liqSet.add(a.orderId.toString())
        }

        // Build trader's order id set from opened events
        const myOrderIds = new Set<string>()
        const matches: MatchRecord[] = []
        for (const log of openedLogs) {
          const a = log.args as { orderId?: bigint }
          if (!a.orderId) continue
          const id = a.orderId
          myOrderIds.add(id.toString())
          const outcome = liqSet.has(id.toString())
            ? 'liquidated'
            : closedMap.get(id.toString()) ?? 'open'
          matches.push({
            orderId: id,
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash as Hex,
            outcome,
          })
        }

        // Build survival chains
        const rematchMap = new Map<string, string>() // liquidatedId → survivingId
        for (const log of rematchLogs) {
          const a = log.args as { survivingOrderId?: bigint; liquidatedOrderId?: bigint }
          if (!a.survivingOrderId || !a.liquidatedOrderId) continue
          if (myOrderIds.has(a.survivingOrderId.toString())) {
            rematchMap.set(a.liquidatedOrderId.toString(), a.survivingOrderId.toString())
          }
        }

        // Find chain roots: surviving orders that aren't themselves a re-match target
        const nonRoots = new Set(rematchMap.values())
        const chains: SurvivalChain[] = []
        for (const [liquidatedId, survivingId] of rematchMap) {
          if (nonRoots.has(liquidatedId)) continue // not a root
          const chain: bigint[] = [BigInt(liquidatedId)]
          let cur = survivingId
          while (cur) {
            chain.push(BigInt(cur))
            cur = rematchMap.get(cur) ?? ''
          }
          if (chain.length >= 2) {
            chains.push({ startOrderId: BigInt(liquidatedId), chain, length: chain.length })
          }
        }

        chains.sort((a, b) => b.length - a.length)
        matches.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))

        if (mountedRef.current) {
          setProfile({ address, stats, matches, survivalChains: chains, loading: false })
        }
      } catch {
        if (mountedRef.current) setProfile(p => ({ ...p, loading: false }))
      }
    }

    void load()
    return () => { mountedRef.current = false }
  }, [address])

  return profile
}
