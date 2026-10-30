/**
 * useMyHistory — fetches personal trade history from OrderClosed events
 * filtered by the connected wallet address. Returns closed trades newest-first.
 * Polls every 30s — history doesn't change frequently.
 */

import { useState, useEffect, useRef } from 'react'
import { publicClient } from './useModularWallet'
import type { Hex } from 'viem'
import { IS_MAINNET } from '@/network'
import { PAIR_BTC_USD, PAIR_ETH_USD, PAIR_SOL_USD } from './useAproxContract'

const PERP_ADDRESS = (IS_MAINNET
  ? (import.meta.env.VITE_MAINNET_APROX_PERP_ADDRESS ?? '')
  : (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '')) as Hex

const LOOKBACK = 50_000n   // wider window for personal history

const ORDER_CLOSED_EVENT = {
  type: 'event',
  name: 'OrderClosed',
  inputs: [
    { name: 'orderId', type: 'uint256', indexed: true  },
    { name: 'trader',  type: 'address', indexed: true  },
    { name: 'pnl',     type: 'int256',  indexed: false },
    { name: 'payout',  type: 'uint256', indexed: false },
  ],
} as const

const ORDER_OPENED_EVENT = {
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
} as const

export interface TradeRecord {
  orderId: bigint
  pnl: bigint        // signed, 6-dec USDC
  payout: bigint
  txHash: Hex
  blockNumber: bigint
  // from OrderOpened cross-ref
  isLong?: boolean
  leverage?: number
  pairLabel?: string
  collateral?: bigint
}

function pairLabel(pairId: string): string {
  if (pairId === PAIR_BTC_USD) return 'BTC/USD'
  if (pairId === PAIR_ETH_USD) return 'ETH/USD'
  if (pairId === PAIR_SOL_USD) return 'SOL/USD'
  return 'Unknown'
}

export function useMyHistory(address: string | null) {
  const [trades, setTrades] = useState<TradeRecord[]>([])
  const [loading, setLoading] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    if (!address || !PERP_ADDRESS) { setTrades([]); return }
    mountedRef.current = true
    setLoading(true)

    async function fetch() {
      if (!mountedRef.current || !address) return
      try {
        const head = await publicClient.getBlockNumber()
        const fromBlock = head > LOOKBACK ? head - LOOKBACK : 0n

        const [closedLogs, openedLogs] = await Promise.all([
          publicClient.getLogs({
            address: PERP_ADDRESS,
            event: ORDER_CLOSED_EVENT,
            args: { trader: address as Hex },
            fromBlock,
          }),
          publicClient.getLogs({
            address: PERP_ADDRESS,
            event: ORDER_OPENED_EVENT,
            args: { trader: address as Hex },
            fromBlock,
          }),
        ])

        // Build orderId → open info map
        const openMap = new Map<string, { isLong: boolean; leverage: number; pairLabel: string; collateral: bigint }>()
        for (const log of openedLogs) {
          const args = log.args as { orderId?: bigint; isLong?: boolean; leverage?: bigint; pairId?: string; collateral?: bigint }
          if (args.orderId != null) {
            openMap.set(args.orderId.toString(), {
              isLong: args.isLong ?? false,
              leverage: Number(args.leverage ?? 1n),
              pairLabel: pairLabel(args.pairId ?? ''),
              collateral: args.collateral ?? 0n,
            })
          }
        }

        const records: TradeRecord[] = closedLogs.map(log => {
          const args = log.args as { orderId?: bigint; pnl?: bigint; payout?: bigint }
          const id = args.orderId ?? 0n
          const meta = openMap.get(id.toString())
          return {
            orderId: id,
            pnl: args.pnl ?? 0n,
            payout: args.payout ?? 0n,
            txHash: log.transactionHash as Hex,
            blockNumber: log.blockNumber ?? 0n,
            ...meta,
          }
        })

        records.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : -1))

        if (mountedRef.current) {
          setTrades(records)
          setLoading(false)
        }
      } catch {
        if (mountedRef.current) setLoading(false)
      }
    }

    void fetch()
    const timer = setInterval(() => { void fetch() }, 30_000)
    return () => { mountedRef.current = false; clearInterval(timer) }
  }, [address])

  return { trades, loading }
}
