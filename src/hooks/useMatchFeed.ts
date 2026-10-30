/**
 * useMatchFeed — polls recent OrderMatched, Liquidated, LiquidationReMatched
 * events from AproxPerpV7 and returns a live activity feed.
 *
 * Polls every 15s. Keeps the last 30 events sorted newest-first.
 * Uses getLogs from publicClient — no indexer needed.
 * Starts from head - 5000 blocks to avoid full-chain scan.
 */

import { useState, useEffect, useRef } from 'react'
import { publicClient } from './useModularWallet'
import type { Hex } from 'viem'

const PERP_ADDRESS = (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '') as Hex
const POLL_INTERVAL_MS = 15_000
const LOOKBACK_BLOCKS  = 5_000n
const MAX_EVENTS       = 30

export type FeedEventType = 'match' | 'liquidated' | 'rematched' | 'closed'

export interface FeedEvent {
  id: string            // unique key
  type: FeedEventType
  blockNumber: bigint
  txHash: Hex
  timestamp: number     // ms, estimated from block (null → Date.now())
  // match
  pairId?: bigint
  longOrderId?: bigint
  shortOrderId?: bigint
  lockedCollateral?: bigint  // 6-dec USDC
  price?: bigint             // 8-dec
  longTrader?: Hex
  shortTrader?: Hex
  leverage?: number
  // liquidated
  orderId?: bigint
  trader?: Hex
  keeper?: Hex
  keeperReward?: bigint
  // rematched
  survivingOrderId?: bigint
  newLockedCollateral?: bigint
  newEntryPrice?: bigint
}

// ABI slices for the events we care about
const EVENTS_ABI = [
  {
    type: 'event',
    name: 'OrderMatched',
    inputs: [
      { name: 'pairId',           type: 'uint256', indexed: true  },
      { name: 'longOrderId',      type: 'uint256', indexed: true  },
      { name: 'shortOrderId',     type: 'uint256', indexed: true  },
      { name: 'lockedCollateral', type: 'uint256', indexed: false },
      { name: 'price',            type: 'int256',  indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Liquidated',
    inputs: [
      { name: 'orderId',      type: 'uint256', indexed: true  },
      { name: 'trader',       type: 'address', indexed: true  },
      { name: 'keeper',       type: 'address', indexed: true  },
      { name: 'keeperReward', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LiquidationReMatched',
    inputs: [
      { name: 'liquidatedOrderId',  type: 'uint256', indexed: true  },
      { name: 'survivingOrderId',   type: 'uint256', indexed: true  },
      { name: 'newPairId',          type: 'uint256', indexed: true  },
      { name: 'newLockedCollateral',type: 'uint256', indexed: false },
      { name: 'newEntryPrice',      type: 'int256',  indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OrderClosed',
    inputs: [
      { name: 'orderId', type: 'uint256', indexed: true  },
      { name: 'trader',  type: 'address', indexed: true  },
      { name: 'pnl',     type: 'int256',  indexed: false },
      { name: 'payout',  type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OrderOpened',
    inputs: [
      { name: 'orderId',    type: 'uint256', indexed: true  },
      { name: 'trader',     type: 'address', indexed: true  },
      { name: 'pairId',     type: 'bytes32', indexed: true  },
      { name: 'isLong',     type: 'bool',    indexed: false },
      { name: 'collateral', type: 'uint256', indexed: false },
      { name: 'leverage',   type: 'uint256', indexed: false },
    ],
  },
] as const

// Map orderId → { trader, leverage } built from OrderOpened logs
type OrderMeta = { trader: Hex; leverage: number }

export function useMatchFeed(): { events: FeedEvent[]; loading: boolean; headBlock: bigint | null } {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [headBlock, setHeadBlock] = useState<bigint | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      if (!PERP_ADDRESS || !mountedRef.current) return
      try {
        const head = await publicClient.getBlockNumber()
        if (mountedRef.current) setHeadBlock(head)
        const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n

        const [matchLogs, liqLogs, rematchLogs, closedLogs, openedLogs] = await Promise.all([
          publicClient.getLogs({ address: PERP_ADDRESS, event: EVENTS_ABI[0], fromBlock }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: EVENTS_ABI[1], fromBlock }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: EVENTS_ABI[2], fromBlock }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: EVENTS_ABI[3], fromBlock }),
          publicClient.getLogs({ address: PERP_ADDRESS, event: EVENTS_ABI[4], fromBlock }),
        ])

        // Build orderId → meta map from OrderOpened logs
        const orderMeta = new Map<string, OrderMeta>()
        for (const log of openedLogs) {
          const args = log.args as { orderId?: bigint; trader?: string; leverage?: bigint }
          if (args.orderId != null && args.trader && args.leverage != null) {
            orderMeta.set(args.orderId.toString(), {
              trader: args.trader as Hex,
              leverage: Number(args.leverage),
            })
          }
        }

        const all: FeedEvent[] = []

        for (const log of matchLogs) {
          const args = log.args as {
            pairId?: bigint; longOrderId?: bigint; shortOrderId?: bigint
            lockedCollateral?: bigint; price?: bigint | string
          }
          const longMeta  = args.longOrderId  != null ? orderMeta.get(args.longOrderId.toString())  : undefined
          const shortMeta = args.shortOrderId != null ? orderMeta.get(args.shortOrderId.toString()) : undefined
          all.push({
            id: `match-${log.transactionHash}-${log.logIndex}`,
            type: 'match',
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash as Hex,
            timestamp: Date.now(),
            pairId:           args.pairId,
            longOrderId:      args.longOrderId,
            shortOrderId:     args.shortOrderId,
            lockedCollateral: args.lockedCollateral,
            price:            args.price != null ? BigInt(args.price.toString()) : undefined,
            longTrader:       longMeta?.trader,
            shortTrader:      shortMeta?.trader,
            leverage:         longMeta?.leverage ?? shortMeta?.leverage,
          })
        }

        for (const log of liqLogs) {
          all.push({
            id: `liq-${log.transactionHash}-${log.logIndex}`,
            type: 'liquidated',
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash as Hex,
            timestamp: Date.now(),
            orderId:      log.args.orderId,
            trader:       log.args.trader as Hex,
            keeper:       log.args.keeper as Hex,
            keeperReward: log.args.keeperReward,
          })
        }

        for (const log of rematchLogs) {
          all.push({
            id: `rematch-${log.transactionHash}-${log.logIndex}`,
            type: 'rematched',
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash as Hex,
            timestamp: Date.now(),
            survivingOrderId:   log.args.survivingOrderId,
            newLockedCollateral:log.args.newLockedCollateral,
            newEntryPrice:      log.args.newEntryPrice ? BigInt(log.args.newEntryPrice.toString()) : undefined,
          })
        }

        for (const log of closedLogs) {
          all.push({
            id: `closed-${log.transactionHash}-${log.logIndex}`,
            type: 'closed',
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash as Hex,
            timestamp: Date.now(),
            orderId: log.args.orderId,
            trader:  log.args.trader as Hex,
          })
        }

        // Sort by block descending, take newest MAX_EVENTS
        all.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))
        const trimmed = all.slice(0, MAX_EVENTS)

        if (mountedRef.current) {
          setEvents(trimmed)
          setLoading(false)
        }
      } catch {
        // silent — stale feed is fine
      }
      if (mountedRef.current) {
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    void poll()
    return () => {
      mountedRef.current = false
      clearTimeout(timer)
    }
  }, [])

  return { events, loading, headBlock }
}
