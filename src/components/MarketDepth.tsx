/**
 * MarketDepth — shows pending USDC long/short per leverage tier and pair.
 * Reads from useMarketDepth (getMarketDepth Multicall3 batch, 10s refresh).
 */

import { useMarketDepth, LEVERAGE_TIERS } from '@/hooks/useMarketDepth'
import { Loader2 } from 'lucide-react'

const PAIRS = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const
type PairLabel = typeof PAIRS[number]

function fmt(raw: bigint): string {
  const n = Number(raw) / 1e6
  if (n === 0) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function DepthBar({ long, short }: { long: bigint; short: bigint }) {
  const l = Number(long)
  const s = Number(short)
  const total = l + s
  if (total === 0) return <div className="h-1 rounded-full w-full" style={{ background: 'var(--border)' }} />
  const longPct = (l / total) * 100
  return (
    <div className="h-1 rounded-full overflow-hidden flex w-full" style={{ background: 'var(--border)' }}>
      <div className="h-full transition-all duration-500" style={{ width: `${longPct}%`, background: 'var(--success)' }} />
      <div className="h-full flex-1" style={{ background: 'var(--danger)' }} />
    </div>
  )
}

export function MarketDepth({ defaultPair = 'BTC/USD' }: { defaultPair?: PairLabel }) {
  const { depth, loading } = useMarketDepth()

  const filtered = depth.filter(d => d.pairLabel === defaultPair)

  // Totals across all tiers for this pair
  const totalLong  = filtered.reduce((s, d) => s + d.pendingLong,  0n)
  const totalShort = filtered.reduce((s, d) => s + d.pendingShort, 0n)

  return (
    <div className="rounded-xl border border-[var(--border)]" style={{ background: 'var(--surface)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-[var(--border)]">
        <h3 className="display text-sm font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
          Market Depth
        </h3>
        {loading
          ? <Loader2 size={11} className="animate-spin" style={{ color: 'var(--subtle)' }} />
          : (
            <div className="flex items-center gap-3 mono text-[10px]">
              <span style={{ color: 'var(--success)' }}>L {fmt(totalLong)}</span>
              <span style={{ color: 'var(--subtle)' }}>/</span>
              <span style={{ color: 'var(--danger)' }}>S {fmt(totalShort)}</span>
            </div>
          )}
      </div>

      {/* Combined bar */}
      <div className="px-4 pt-3 pb-2">
        <DepthBar long={totalLong} short={totalShort} />
        <div className="flex justify-between mt-1 mono text-[9px]" style={{ color: 'var(--subtle)' }}>
          <span>Long</span>
          <span>Short</span>
        </div>
      </div>

      {/* Per-leverage table */}
      <div className="pb-3">
        {LEVERAGE_TIERS.map(lev => {
          const entry = filtered.find(d => d.leverage === lev)
          const l = entry?.pendingLong ?? 0n
          const s = entry?.pendingShort ?? 0n
          if (l === 0n && s === 0n) return null
          return (
            <div key={lev} className="flex items-center gap-3 px-4 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="mono text-[10px] w-8 shrink-0" style={{ color: 'var(--accent)' }}>{lev}×</span>
              <div className="flex-1">
                <DepthBar long={l} short={s} />
              </div>
              <span className="mono text-[10px] w-10 text-right" style={{ color: 'var(--success)' }}>{fmt(l)}</span>
              <span className="mono text-[10px] w-10 text-right" style={{ color: 'var(--danger)' }}>{fmt(s)}</span>
            </div>
          )
        })}
        {!loading && filtered.every(d => d.pendingLong === 0n && d.pendingShort === 0n) && (
          <p className="text-center mono text-[11px] py-4" style={{ color: 'var(--subtle)' }}>No pending orders</p>
        )}
      </div>
    </div>
  )
}
