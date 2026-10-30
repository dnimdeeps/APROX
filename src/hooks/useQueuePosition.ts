/**
 * useQueuePosition — for a PENDING order, returns the position in the matching queue.
 * Position 1 = next to be matched. Polls every 6s.
 */

import { useState, useEffect, useRef } from 'react'
import { parseAbi, type Hex } from 'viem'
import { publicClient } from './useModularWallet'
import { IS_MAINNET } from '@/network'

const PERP_ADDRESS = (IS_MAINNET
  ? (import.meta.env.VITE_MAINNET_APROX_PERP_ADDRESS ?? '')
  : (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '')) as Hex

const ABI = parseAbi([
  'function getPendingQueue(bool isLong, uint8 leverage, bytes32 pairId) external view returns (uint256[])',
])

export function useQueuePosition(
  orderId: bigint | undefined,
  isLong: boolean,
  leverage: number,
  pairId: Hex,
  enabled: boolean,
) {
  const [position, setPosition] = useState<number | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    if (!enabled || !orderId || !PERP_ADDRESS) { setPosition(null); return }
    mountedRef.current = true

    async function poll() {
      if (!mountedRef.current) return
      try {
        const queue = await publicClient.readContract({
          address: PERP_ADDRESS,
          abi: ABI,
          functionName: 'getPendingQueue',
          args: [isLong, leverage, pairId],
        }) as bigint[]

        const idx = queue.findIndex(id => id === orderId)
        if (mountedRef.current) setPosition(idx >= 0 ? idx + 1 : null)
      } catch {
        // silent
      }
    }

    void poll()
    const timer = setInterval(() => { void poll() }, 6_000)
    return () => { mountedRef.current = false; clearInterval(timer) }
  }, [orderId, isLong, leverage, pairId, enabled])

  return position
}
