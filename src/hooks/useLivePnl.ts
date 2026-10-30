/**
 * useLivePnl — polls computeLivePnl for every active order every second
 *
 * Uses a single Multicall3 aggregate3 call to batch all order PnL reads into
 * ONE eth_call per second — no matter how many orders are open.
 *
 * computeLivePnl is a pure view function on AproxPerpV6 that reads the
 * OperatorPriceFeed and runs the exact same math as closeOrder/liquidate.
 * The numbers shown here are therefore identical to settlement — no divergence.
 *
 * Returns: Map<orderId (string), pnlUsdc (number)>
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Hex } from 'viem'
import { publicClient } from './useModularWallet'

// Poll every 3s — OperatorPriceFeed is pushed every 5s, so
// faster polling wastes RPC budget without producing new numbers.
const POLL_INTERVAL_MS = 3_000
// Staggered startup: fires at t=1.5s, oracle fires at t=0.6s — never same tick.
const STARTUP_DELAY_MS = 1_500
// 429 backoff: doubles on each consecutive rate-limit hit, caps at 30s.
const MAX_BACKOFF_MS = 30_000

const PERP_ADDRESS = (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '') as Hex

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex

const PERP_ABI = parseAbi([
  'function computeLivePnl(uint256 orderId) external view returns (int256 pnl)',
])

const MULTICALL3_ABI = [
  {
    name: 'aggregate3',
    type: 'function',
    stateMutability: 'view',
    inputs: [{
      name: 'calls', type: 'tuple[]',
      components: [
        { name: 'target',       type: 'address' },
        { name: 'allowFailure', type: 'bool'    },
        { name: 'callData',     type: 'bytes'   },
      ],
    }],
    outputs: [{
      name: 'returnData', type: 'tuple[]',
      components: [
        { name: 'success',    type: 'bool'  },
        { name: 'returnData', type: 'bytes' },
      ],
    }],
  },
] as const

/**
 * @param orderIds  array of bigint order IDs currently active (matchedCollateral > 0)
 *                  Pass an empty array when the user has no active orders.
 */
export function useLivePnl(orderIds: bigint[]): Map<string, number> {
  const [pnlMap, setPnlMap] = useState<Map<string, number>>(new Map())

  const mountedRef  = useRef(true)
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idsRef      = useRef<bigint[]>(orderIds)
  const backoffRef  = useRef(POLL_INTERVAL_MS)
  // Stable string key — computed via useMemo so it only changes when IDs actually
  // change, not on every render. This is what drives the poller useEffect dep.
  const idKey = useMemo(
    () => orderIds.map(id => id.toString()).join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderIds.length, orderIds.map(id => id.toString()).join(',')]
  )

  // Keep idsRef in sync with current orderIds every render
  useEffect(() => {
    idsRef.current = orderIds
  }, [orderIds])

  useEffect(() => {
    mountedRef.current = true
    backoffRef.current = POLL_INTERVAL_MS

    function scheduleNext(delayMs: number) {
      if (!mountedRef.current) return
      timerRef.current = setTimeout(() => {
        void fetchPnl()
      }, delayMs)
    }

    async function fetchPnl() {
      if (!mountedRef.current) return
      const ids = idsRef.current
      if (!PERP_ADDRESS || ids.length === 0) {
        if (mountedRef.current) setPnlMap(new Map())
        scheduleNext(POLL_INTERVAL_MS)
        return
      }

      try {
        const calls = ids.map(id => ({
          target: PERP_ADDRESS,
          allowFailure: true as const,
          callData: encodeFunctionData({
            abi: PERP_ABI,
            functionName: 'computeLivePnl',
            args: [id],
          }),
        }))

        const results = await publicClient.readContract({
          address: MULTICALL3_ADDRESS,
          abi: MULTICALL3_ABI,
          functionName: 'aggregate3',
          args: [calls],
        }) as Array<{ success: boolean; returnData: Hex }>

        if (!mountedRef.current) return

        const next = new Map<string, number>()
        for (let i = 0; i < results.length; i++) {
          const { success, returnData } = results[i]
          if (!success || !returnData || returnData === '0x') continue
          try {
            const decoded = decodeFunctionResult({
              abi: PERP_ABI,
              functionName: 'computeLivePnl',
              data: returnData,
            }) as bigint
            // int256 in 6-decimal USDC (same unit as collateral)
            next.set(ids[i].toString(), Number(decoded) / 1e6)
          } catch { /* skip malformed result for this order */ }
        }
        setPnlMap(next)
        // Successful fetch — reset backoff and schedule next normal tick
        backoffRef.current = POLL_INTERVAL_MS
        scheduleNext(POLL_INTERVAL_MS)
      } catch (err: unknown) {
        // On rate-limit (429) or payload-too-large: exponential backoff so we
        // stop hammering the RPC instead of silently freezing.
        const msg = err instanceof Error ? err.message : String(err)
        const isRateLimit = msg.includes('rate limit') || msg.includes('429')
          || msg.includes('exceeds defined limit') || msg.includes('Request limit')
        if (isRateLimit) {
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS)
        } else {
          backoffRef.current = POLL_INTERVAL_MS
        }
        // Keep previous PnL values visible — do not wipe the map on transient errors
        scheduleNext(backoffRef.current)
      }
    }

    // Staggered startup — wait before first fetch
    const startTimer = setTimeout(() => {
      void fetchPnl()
    }, STARTUP_DELAY_MS)

    return () => {
      mountedRef.current = false
      clearTimeout(startTimer)
      if (timerRef.current) clearTimeout(timerRef.current as ReturnType<typeof setTimeout>)
    }
  // Recreate the poller only when the set of order IDs actually changes.
  // idKey is a stable memoized string — not an inline expression — so React
  // correctly compares it by value and doesn't restart the poller every render.
  }, [idKey])

  return pnlMap
}
