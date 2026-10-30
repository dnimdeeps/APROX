/**
 * PriceBar — Live BTC/USD price display
 *
 * PRIMARY source: OperatorPriceFeed (same on-chain price the contract uses, pushed from Pyth/Coinbase).
 *   - Updates whenever the oracle pushes (~1% move or 1h heartbeat).
 *   - Shows age since last oracle push and a staleness badge.
 *   - This is the price entry, PnL, and settlement all reference.
 *
 * SECONDARY source: server WebSocket price (Binance/Coinbase via Railway).
 *   - Used only for the green/red flash animation and the secondary display.
 *   - Never used in PnL calculations.
 */

import { useState, useEffect, useRef } from 'react'
import { Activity, Clock, AlertTriangle } from 'lucide-react'
import type { UsePriceFeedReturn } from '@/hooks/usePriceFeed'
import type { OraclePriceState } from '@/hooks/useOraclePrice'

interface PriceBarProps {
  feed: UsePriceFeedReturn
  oracle: OraclePriceState
  pairLabel?: string
}

function formatUSD(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function formatAge(seconds: number): string {
  if (seconds < 60)   return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

export function PriceBar({ feed, oracle, pairLabel = 'BTC/USD' }: PriceBarProps) {
  // Oracle price — primary, same as contract
  const oraclePrice = oracle.prices[pairLabel] ?? oracle.price ?? null
  const [ageSeconds, setAgeSeconds] = useState<number | null>(oracle.ageSeconds)

  // Tick the age display every second from oracle.updatedAt
  useEffect(() => {
    setAgeSeconds(oracle.ageSeconds)
    if (oracle.updatedAt === null) return
    const updatedAt = oracle.updatedAt
    const timer = setInterval(() => {
      setAgeSeconds(Math.floor(Date.now() / 1000) - updatedAt)
    }, 1000)
    return () => clearInterval(timer)
  }, [oracle.updatedAt, oracle.ageSeconds])

  // Server WS price — secondary, for flash animation only
  const { prices: wsPrices } = feed
  const wsPrice = wsPrices[pairLabel] ?? null
  const prevWsPrice = useRef<number | null>(null)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    if (wsPrice === null) return
    if (prevWsPrice.current !== null && prevWsPrice.current !== wsPrice) {
      setFlash(wsPrice > prevWsPrice.current ? 'up' : 'down')
      setTimeout(() => setFlash(null), 400)
    }
    prevWsPrice.current = wsPrice
  }, [wsPrice])

  // Session delta — computed from oracle price changes
  const firstOraclePrice = useRef<number | null>(null)
  const [priceDelta, setPriceDelta] = useState(0)
  useEffect(() => {
    if (pairLabel) { firstOraclePrice.current = null; setPriceDelta(0) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairLabel])

  useEffect(() => {
    if (oraclePrice === null) return
    if (firstOraclePrice.current === null) firstOraclePrice.current = oraclePrice
    setPriceDelta(((oraclePrice - firstOraclePrice.current) / firstOraclePrice.current) * 100)
  }, [oraclePrice])

  const isPositive = priceDelta >= 0
  // Show oracle price once it's available.
  // Only fall back to WS price if the oracle feed address is not configured
  // (local dev without .env set). When the feed IS configured and returns null
  // it means the server hasn't pushed yet — show "–" rather than a stale WS default.
  const FEED_CONFIGURED = !!import.meta.env.VITE_OPERATOR_PRICE_FEED_ADDRESS
  const displayPrice = oraclePrice ?? (FEED_CONFIGURED ? null : wsPrice)
  // Flash direction: use WS ticks (sub-second) since oracle moves infrequently.
  // The color flash is visual only and has no effect on any number.

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Symbol */}
      <div className="flex items-center gap-1.5">
        <Activity size={15} className="text-[var(--accent)]" />
        <span className="font-semibold text-sm text-[var(--muted)] display">{pairLabel}</span>
      </div>

      {/* Price — flashes on WS tick, value from oracle */}
      <div
        className={`display text-2xl font-semibold tabular-nums transition-colors duration-200 ${
          flash === 'up'
            ? 'text-[var(--success)]'
            : flash === 'down'
              ? 'text-[var(--danger)]'
              : 'text-[var(--ink)]'
        }`}
      >
        {displayPrice !== null ? formatUSD(displayPrice) : '–'}
      </div>

      {/* Session delta */}
      {displayPrice !== null && (
        <div className={`text-sm font-medium tabular-nums ${isPositive ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
          {isPositive ? '+' : ''}{priceDelta.toFixed(3)}%
          <span className="text-[var(--subtle)] text-xs ml-1">(session)</span>
        </div>
      )}

      {/* Oracle badge — shows age and staleness */}
      <div className="flex items-center gap-1 ml-auto">
        {oracle.isStale ? (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-500/10 border border-yellow-500/30">
            <AlertTriangle size={10} className="text-yellow-400" />
            <span className="text-xs text-yellow-400">Oracle stale</span>
          </div>
        ) : oraclePrice !== null ? (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20">
            <Clock size={10} className="text-[var(--accent)]" />
            <span className="text-xs text-[var(--accent)]">
              Oracle {ageSeconds !== null ? formatAge(ageSeconds) : '—'}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--surface-muted)] border border-[var(--border)]">
            <Clock size={10} className="text-[var(--subtle)]" />
            <span className="text-xs text-[var(--subtle)]">Reading oracle…</span>
          </div>
        )}
      </div>
    </div>
  )
}
