/**
 * MatchChart — live BTC/USD price chart with P2P match overlays.
 *
 * Shows the BTC/USD price as a rolling window of the last N seconds,
 * and overlays the key levels for every active matched order the current
 * user is in:
 *
 *   ─── Entry price     (where the match was made)
 *   ·── Liquidation price (80% loss at the chosen leverage)
 *   ··· Breakeven       (entry price, dashed reference)
 *
 * The chart is drawn on an SVG element updated every price tick.
 * No external charting library — pure React + SVG.
 *
 * Props:
 *   prices       — array of { t: ms timestamp, v: USD float } for the BTC/USD series
 *   orders       — the user's active orders (from getActiveOrders)
 *   currentPrice — latest USD float (from usePriceFeed.price)
 *   selectedPair — bytes32 pair id (only BTC/USD orders shown for now)
 */

import { useMemo, useRef, useEffect, useState } from 'react'
import type { Order } from '@/hooks/useAproxContract'
import { PAIR_BTC_USD } from '@/hooks/useAproxContract'
import type { Hex } from 'viem'

export interface PriceTick {
  t: number   // ms epoch
  v: number   // USD float e.g. 65000.42
}

interface MatchChartProps {
  prices: PriceTick[]
  orders: Array<{ id: bigint; order: Order }>
  currentPrice: number | null
  selectedPair: Hex
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lerp(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  if (inMax === inMin) return (outMin + outMax) / 2
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin)
}

function formatUSD(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function formatPnl(n: number) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)} USDC`
}

// Entry prices are stored as 8-decimal integers in the order struct (OperatorPriceFeed).
// The Order type in useAproxContract maps entryPrice as bigint from the contract.
function entryPriceUsd(order: Order): number | null {
  if (order.entryPrice <= 0n) return null
  return Number(order.entryPrice) / 1e18
}

function liqPrice(entry: number, isLong: boolean, leverage: number): number {
  // Position is liquidated when loss = 80% of collateral.
  // loss = collateral * leverage * |priceDelta| / entry = 0.8 * collateral
  // => |priceDelta| / entry = 0.8 / leverage
  const factor = 0.8 / leverage
  return isLong ? entry * (1 - factor) : entry * (1 + factor)
}

function livePnl(order: Order, currentPrice: number): number {
  if (order.matchedCollateral === 0n || order.entryPrice === 0n) return 0
  const entry = Number(order.entryPrice) / 1e18
  if (entry <= 0) return 0
  const collateral = Number(order.matchedCollateral) / 1e6
  const delta = (currentPrice - entry) / entry
  return (order.isLong ? 1 : -1) * delta * collateral * order.leverage
}

// ── Colour palette for multiple open orders ───────────────────────────────────
const ORDER_COLORS = [
  { line: '#22d3ee', liq: '#f87171', fill: 'rgba(34,211,238,0.08)' },  // cyan
  { line: '#a78bfa', liq: '#fb923c', fill: 'rgba(167,139,250,0.08)' }, // violet
  { line: '#34d399', liq: '#f43f5e', fill: 'rgba(52,211,153,0.08)' },  // emerald
  { line: '#fbbf24', liq: '#f87171', fill: 'rgba(251,191,36,0.08)' },  // amber
]

// ── Chart ─────────────────────────────────────────────────────────────────────

export function MatchChart({ prices, orders, currentPrice, selectedPair }: MatchChartProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 600, h: 220 })

  // Observe container width changes so chart fills its parent responsively.
  useEffect(() => {
    const el = svgRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width
      if (w > 0) setSize({ w, h: Math.round(w * 0.36) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Only show orders for the currently selected pair that are matched.
  const activeOrders = useMemo(() =>
    orders.filter(({ order }) =>
      order.pairId === selectedPair &&
      order.matchedCollateral > 0n &&
      order.entryPrice > 0n
    ),
    [orders, selectedPair]
  )

  // If the rolling buffer has fewer than 2 ticks but we have a live price,
  // synthesise a flat 2-point line so overlay levels are always visible immediately.
  const effectivePrices = useMemo<PriceTick[]>(() => {
    if (prices.length >= 2) return prices
    if (currentPrice) return [
      { t: Date.now() - 5_000, v: currentPrice },
      { t: Date.now(),         v: currentPrice },
    ]
    return prices
  }, [prices, currentPrice])

  // Derive Y domain from price history + all overlay levels.
  const { yMin, yMax } = useMemo(() => {
    const vals: number[] = effectivePrices.map(p => p.v)
    activeOrders.forEach(({ order }) => {
      const e = entryPriceUsd(order)
      if (!e) return
      vals.push(e)
      vals.push(liqPrice(e, order.isLong, order.leverage))
    })
    if (currentPrice) vals.push(currentPrice)
    if (vals.length === 0) return { yMin: 60000, yMax: 70000 }
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = Math.max((hi - lo) * 0.12, hi * 0.003)
    return { yMin: lo - pad, yMax: hi + pad }
  }, [effectivePrices, activeOrders, currentPrice])

  const PAD = { top: 12, right: 56, bottom: 24, left: 12 }
  const chartW = size.w - PAD.left - PAD.right
  const chartH = size.h - PAD.top - PAD.bottom

  const tMin = effectivePrices.length > 0 ? effectivePrices[0].t : Date.now() - 60_000
  const tMax = effectivePrices.length > 0 ? effectivePrices[effectivePrices.length - 1].t : Date.now()

  function px(t: number) { return PAD.left + lerp(t, tMin, tMax, 0, chartW) }
  function py(v: number) { return PAD.top  + lerp(v, yMax, yMin, 0, chartH) }

  const linePath = useMemo(() => {
    if (effectivePrices.length === 0) return ''
    return effectivePrices.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`).join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePrices, yMin, yMax, size])

  const areaPath = useMemo(() => {
    if (effectivePrices.length === 0) return ''
    const bottom = (PAD.top + chartH).toFixed(1)
    const line = effectivePrices.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`).join(' ')
    const lastX = px(effectivePrices[effectivePrices.length - 1].t).toFixed(1)
    const firstX = px(effectivePrices[0].t).toFixed(1)
    return `${line} L${lastX},${bottom} L${firstX},${bottom} Z`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePrices, yMin, yMax, size])

  const gridLines = useMemo(() => {
    const steps = 4
    return Array.from({ length: steps + 1 }, (_, i) => {
      const v = yMin + (yMax - yMin) * (i / steps)
      return { y: py(v), label: formatUSD(v) }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yMin, yMax, size])

  const noData = effectivePrices.length < 2
  const showPair = selectedPair === PAIR_BTC_USD ? 'BTC/USD' :
                   selectedPair === '0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45' ? 'ETH/USD' : 'SOL/USD'

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--ink)]">{showPair} Live Chart</span>
          {currentPrice && (
            <span className="mono text-sm font-bold text-[var(--accent)] tabular-nums">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          )}
        </div>
        {activeOrders.length > 0 && (
          <span className="text-xs text-[var(--subtle)]">
            {activeOrders.length} active position{activeOrders.length > 1 ? 's' : ''} overlaid
          </span>
        )}
      </div>

      {/* SVG chart */}
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="w-full"
        style={{ display: 'block' }}
      >
        <defs>
          {/* Price area gradient */}
          <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
          {/* Clip to chart area */}
          <clipPath id="chartClip">
            <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} />
          </clipPath>
        </defs>

        {/* Grid lines */}
        {gridLines.map(({ y, label }) => (
          <g key={label}>
            <line
              x1={PAD.left} y1={y} x2={PAD.left + chartW} y2={y}
              stroke="var(--border)" strokeWidth="0.5" strokeDasharray="3 4"
            />
            <text
              x={PAD.left + chartW + 4} y={y + 3.5}
              fontSize="9" fill="var(--subtle)" fontFamily="monospace"
            >{label}</text>
          </g>
        ))}

        {/* No-data message */}
        {noData && (
          <text
            x={PAD.left + chartW / 2} y={PAD.top + chartH / 2}
            textAnchor="middle" fontSize="11" fill="var(--subtle)"
          >Waiting for price data…</text>
        )}

        {/* Price area fill */}
        {!noData && (
          <path
            d={areaPath} fill="url(#priceGrad)"
            clipPath="url(#chartClip)"
          />
        )}

        {/* Price line */}
        {!noData && (
          <path
            d={linePath} fill="none"
            stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round"
            clipPath="url(#chartClip)"
          />
        )}

        {/* ── Per-order overlays ─────────────────────────────────────────── */}
        {activeOrders.map(({ id, order }, idx) => {
          const entry = entryPriceUsd(order)
          if (!entry) return null
          const liq    = liqPrice(entry, order.isLong, order.leverage)
          const pnl    = currentPrice ? livePnl(order, currentPrice) : 0
          const col    = ORDER_COLORS[idx % ORDER_COLORS.length]
          const eyE    = py(entry)
          const eyL    = py(liq)
          const labelX = PAD.left + chartW + 4

          // PnL band between entry and current price
          const curY   = currentPrice ? py(currentPrice) : null
          const bandTop    = curY !== null ? Math.min(eyE, curY) : eyE
          const bandBottom = curY !== null ? Math.max(eyE, curY) : eyE

          const dirLabel = order.isLong ? 'L' : 'S'

          return (
            <g key={id.toString()}>
              {/* PnL fill band */}
              {curY !== null && (
                <rect
                  x={PAD.left} y={bandTop}
                  width={chartW} height={Math.max(0, bandBottom - bandTop)}
                  fill={pnl >= 0 ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)'}
                  clipPath="url(#chartClip)"
                />
              )}

              {/* Entry price line */}
              <line
                x1={PAD.left} y1={eyE} x2={PAD.left + chartW} y2={eyE}
                stroke={col.line} strokeWidth="1" strokeDasharray="5 3"
                clipPath="url(#chartClip)"
              />
              <text
                x={labelX} y={eyE + 3.5}
                fontSize="9" fill={col.line} fontFamily="monospace"
              >#{id.toString().slice(-3)}{dirLabel} E</text>

              {/* Liquidation price line */}
              <line
                x1={PAD.left} y1={eyL} x2={PAD.left + chartW} y2={eyL}
                stroke={col.liq} strokeWidth="1" strokeDasharray="2 3"
                clipPath="url(#chartClip)"
              />
              <text
                x={labelX} y={eyL + 3.5}
                fontSize="9" fill={col.liq} fontFamily="monospace"
              >#{id.toString().slice(-3)}{dirLabel} Liq</text>

              {/* Entry price dot at right edge */}
              <circle cx={PAD.left + chartW} cy={eyE} r="3" fill={col.line} />

              {/* Live PnL label near entry line */}
              {curY !== null && (
                <text
                  x={PAD.left + chartW * 0.5}
                  y={Math.max(PAD.top + 10, Math.min(bandTop + (bandBottom - bandTop) / 2 + 4, PAD.top + chartH - 4))}
                  textAnchor="middle" fontSize="10" fontWeight="bold"
                  fill={pnl >= 0 ? '#34d399' : '#f87171'}
                  fontFamily="monospace"
                >
                  {formatPnl(pnl)}
                </text>
              )}
            </g>
          )
        })}

        {/* Current price horizontal tick on right axis */}
        {currentPrice && !noData && (
          <g>
            <rect
              x={PAD.left + chartW - 1} y={py(currentPrice) - 7}
              width={54} height={14} rx="3"
              fill="var(--accent)" opacity="0.9"
            />
            <text
              x={PAD.left + chartW + 26} y={py(currentPrice) + 4}
              textAnchor="middle" fontSize="9.5" fill="white" fontFamily="monospace" fontWeight="bold"
            >
              {currentPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </text>
          </g>
        )}

        {/* X-axis time labels */}
        {prices.length > 1 && (
          <>
            <text
              x={PAD.left} y={PAD.top + chartH + 14}
              fontSize="9" fill="var(--subtle)" fontFamily="monospace"
            >{new Date(tMin).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</text>
            <text
              x={PAD.left + chartW} y={PAD.top + chartH + 14}
              textAnchor="end" fontSize="9" fill="var(--subtle)" fontFamily="monospace"
            >{new Date(tMax).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</text>
          </>
        )}
      </svg>

      {/* Legend */}
      {activeOrders.length > 0 && (
        <div className="flex flex-wrap gap-3 px-4 pb-3 pt-1 border-t border-[var(--border)]">
          {activeOrders.map(({ id, order }, idx) => {
            const entry = entryPriceUsd(order)
            const pnl   = (currentPrice && entry) ? livePnl(order, currentPrice) : null
            const col   = ORDER_COLORS[idx % ORDER_COLORS.length]
            return (
              <div key={id.toString()} className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: col.line }} />
                <span className="text-[var(--ink-2)]">
                  #{id.toString()} {order.isLong ? 'Long' : 'Short'} {order.leverage}x
                </span>
                {entry && (
                  <span className="mono text-[var(--subtle)]">
                    E: ${formatUSD(entry)}
                  </span>
                )}
                {pnl !== null && (
                  <span className={`mono font-semibold ${pnl >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                    {formatPnl(pnl)}
                  </span>
                )}
              </div>
            )
          })}
          <div className="flex items-center gap-2 text-xs ml-auto text-[var(--subtle)]">
            <span className="inline-block w-5 border-t border-dashed" style={{ borderColor: '#6ee7b7' }} />
            Entry
            <span className="inline-block w-5 border-t border-dashed" style={{ borderColor: '#f87171' }} />
            Liq.
          </div>
        </div>
      )}
    </div>
  )
}
