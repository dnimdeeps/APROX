/**
 * MatchBar — Duel equity visualizer per the Aprox Design Guide.
 *
 * Two vertical columns side by side. Left = you (green). Right = opponent (red).
 * A dashed baseline marks the 50/50 entry point (80px from bottom of 160px container).
 * Bars grow upward from the baseline as equity shifts.
 *
 * Your bar has three layers stacked bottom → top:
 *   1. Dark green  (#1a6b3c) — original stake (fixed)
 *   2. Bright green (#00c853) — live profit from current match PnL
 *   3. Teal        (#69f0ae) — re-match winnings carried from prior liquidations
 *
 * Opponent bar pulses near liquidation (< 25% equity remaining).
 * Liquidation moment: opponent bar collapses with ease-out, white flash, silence.
 */

import { useEffect, useRef, useState } from 'react'
import type { Order } from '@/hooks/useAproxContract'

interface MatchBarProps {
  order: Order
  livePnlUsdc: number | null
}

const BAR_H      = 160   // total container height px
const BASELINE   = 80    // midpoint — entry state px from bottom
const LIQ_THRESH = 0.20  // 20% of original collateral

// Map a USDC value to bar height in px, clamped to container
function toHeight(usdcVal: number, scaleUsdc: number): number {
  if (scaleUsdc <= 0) return BASELINE
  // 1 USDC = BASELINE/scaleUsdc px; full container = 2× scale
  const px = (usdcVal / scaleUsdc) * BASELINE
  return Math.max(0, Math.min(BAR_H, Math.round(px)))
}

export function MatchBar({ order, livePnlUsdc }: MatchBarProps) {
  const matchedUsdc   = Number(order.matchedCollateral) / 1e6
  const originalStake = Number(order.collateral) / 1e6
  const pnl           = livePnlUsdc ?? 0

  // Scale: at entry, matchedUsdc maps to BASELINE px
  const scaleUsdc = matchedUsdc > 0 ? matchedUsdc : 1

  // My equity layers
  const myTotalEquity  = Math.max(0, matchedUsdc + pnl)
  const rematched      = Math.max(0, myTotalEquity - originalStake - Math.max(0, pnl))
  const liveProfit     = Math.max(0, pnl)
  const stakeLayer     = Math.min(myTotalEquity, originalStake - Math.max(0, -pnl))

  // Their equity
  const theirEquity    = Math.max(0, matchedUsdc - pnl)
  const theirStart     = matchedUsdc

  // Heights
  const stakeH         = toHeight(Math.max(0, stakeLayer), scaleUsdc)
  const profitH        = toHeight(liveProfit, scaleUsdc)
  const rematchH       = toHeight(rematched, scaleUsdc)
  const myTotalH       = toHeight(myTotalEquity, scaleUsdc)
  const theirH         = toHeight(theirEquity, scaleUsdc)
  const liqTickH       = toHeight(theirStart * LIQ_THRESH, scaleUsdc)

  const nearLiq        = theirEquity > 0 && theirEquity <= theirStart * (LIQ_THRESH + 0.05)
  const isWinning      = pnl > 0
  const isLosing       = pnl < 0

  // Liquidation flash animation state
  const [flash, setFlash]     = useState(false)
  const prevTheirH            = useRef(theirH)
  useEffect(() => {
    if (prevTheirH.current > 4 && theirH === 0) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 200)
      return () => clearTimeout(t)
    }
    prevTheirH.current = theirH
  }, [theirH])

  if (matchedUsdc === 0) return null

  const myPct    = matchedUsdc > 0 ? ((myTotalEquity / (myTotalEquity + theirEquity)) * 100) : 50
  const theirPct = 100 - myPct

  return (
    <div className="mt-4 select-none">
      {/* Column labels */}
      <div className="flex gap-1 mb-2">
        <div className="flex-1 text-center">
          <span className="text-[10px] font-semibold tracking-widest uppercase"
            style={{ color: 'var(--success)' }}>You</span>
        </div>
        <div className="w-1" />
        <div className="flex-1 text-center">
          <span className={`text-[10px] font-semibold tracking-widest uppercase ${nearLiq ? 'animate-pulse' : ''}`}
            style={{ color: nearLiq ? 'var(--danger)' : 'var(--subtle)' }}>Opponent</span>
        </div>
      </div>

      {/* Bar container */}
      <div className="flex gap-1 relative" style={{ height: BAR_H }}>

        {/* ── Your bar (left) ── */}
        <div className="flex-1 relative flex flex-col justify-end rounded-sm overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.04)' }}>

          {/* Stacked layers bottom → top */}
          <div className="absolute bottom-0 left-0 right-0 flex flex-col-reverse"
            style={{ height: myTotalH, transition: 'height 600ms cubic-bezier(0.16,1,0.3,1)' }}>

            {/* Original stake — dark green base */}
            <div style={{
              height: stakeH,
              background: 'var(--bar-stake)',
              flexShrink: 0,
            }} />

            {/* Live profit — bright green */}
            {profitH > 0 && (
              <div style={{
                height: profitH,
                background: 'var(--bar-profit)',
                flexShrink: 0,
              }} />
            )}

            {/* Re-match winnings — teal */}
            {rematchH > 0 && (
              <div style={{
                height: rematchH,
                background: 'var(--bar-rematched)',
                flexShrink: 0,
              }} />
            )}
          </div>

          {/* Baseline dashed line */}
          <div className="absolute left-0 right-0 pointer-events-none"
            style={{
              bottom: BASELINE,
              borderTop: '1px dashed rgba(255,255,255,0.18)',
            }} />

          {/* Dollar label above bar */}
          <div className="absolute left-0 right-0 flex justify-center"
            style={{ bottom: myTotalH + 4, transition: 'bottom 600ms cubic-bezier(0.16,1,0.3,1)' }}>
            <span className="mono text-[10px] font-semibold tabular-nums"
              style={{ color: isWinning ? 'var(--success)' : isLosing ? 'var(--danger)' : 'var(--ink-2)' }}>
              ${myTotalEquity.toFixed(2)}
            </span>
          </div>
        </div>

        {/* ── Opponent bar (right) ── */}
        <div className="flex-1 relative flex flex-col justify-end rounded-sm overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.04)' }}>

          {/* Opponent equity */}
          <div className="absolute bottom-0 left-0 right-0"
            style={{
              height: theirH,
              background: flash ? 'rgba(255,255,255,0.9)' : 'var(--bar-opponent)',
              transition: flash ? 'none' : 'height 500ms cubic-bezier(0.16,1,0.3,1)',
              opacity: nearLiq && !flash ? undefined : 1,
            }}>
            {/* Near-liq pulse via keyframe class */}
            {nearLiq && !flash && (
              <div className="absolute inset-0 animate-pulse"
                style={{ background: 'rgba(255,61,87,0.25)' }} />
            )}
          </div>

          {/* Liquidation threshold tick */}
          {liqTickH > 0 && theirH > 0 && (
            <div className="absolute left-0 right-0 pointer-events-none z-10"
              style={{
                bottom: liqTickH,
                borderTop: nearLiq
                  ? '1.5px solid #fbbf24'
                  : '1px dashed rgba(251,191,36,0.5)',
                boxShadow: nearLiq ? '0 0 6px rgba(251,191,36,0.6)' : 'none',
              }} />
          )}

          {/* Baseline dashed line */}
          <div className="absolute left-0 right-0 pointer-events-none"
            style={{
              bottom: BASELINE,
              borderTop: '1px dashed rgba(255,255,255,0.18)',
            }} />

          {/* Dollar label above bar */}
          <div className="absolute left-0 right-0 flex justify-center"
            style={{ bottom: theirH + 4, transition: 'bottom 500ms cubic-bezier(0.16,1,0.3,1)' }}>
            <span className="mono text-[10px] tabular-nums"
              style={{ color: nearLiq ? 'var(--danger)' : 'var(--subtle)' }}>
              ${theirEquity.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom row: percentages + pool */}
      <div className="flex gap-1 mt-1.5">
        <div className="flex-1 text-center">
          <span className="mono text-[10px] tabular-nums"
            style={{ color: isWinning ? 'var(--success)' : isLosing ? 'var(--danger)' : 'var(--subtle)' }}>
            {myPct.toFixed(1)}%
          </span>
        </div>
        <div className="w-1 flex items-center justify-center">
          <span className="text-[9px]" style={{ color: 'var(--subtle)' }}>·</span>
        </div>
        <div className="flex-1 text-center">
          <span className="mono text-[10px] tabular-nums" style={{ color: 'var(--subtle)' }}>
            {theirPct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* Re-match winnings note */}
      {rematchH > 0 && (
        <p className="text-center text-[9px] mt-1" style={{ color: 'var(--bar-rematched)' }}>
          +${rematched.toFixed(2)} carried from prior match
        </p>
      )}
    </div>
  )
}
