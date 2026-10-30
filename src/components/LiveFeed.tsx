/**
 * LiveFeed — scrolling activity ticker for recent APROX on-chain events.
 *
 * Shows OrderMatched, Liquidated, LiquidationReMatched, and OrderClosed
 * events from the last 5000 blocks, sorted newest-first.
 * Refreshes every 15s via useMatchFeed.
 */

import { useMatchFeed } from '@/hooks/useMatchFeed'
import type { FeedEvent } from '@/hooks/useMatchFeed'
import { Zap, TrendingDown, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react'

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function formatUsdc(raw: bigint) {
  return (Number(raw) / 1e6).toFixed(2)
}

function formatPrice(raw: bigint) {
  return (Number(raw) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function timeAgo(blockNumber: bigint, headBlock: bigint): string {
  const diff = Number(headBlock - blockNumber)
  if (diff <= 1) return 'now'
  // Arc ~1s blocks
  const secs = diff
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

function EventRow({ ev, headBlock }: { ev: FeedEvent; headBlock: bigint }) {
  const txUrl = `https://explorer.testnet.arc.io/tx/${ev.txHash}`
  const time  = timeAgo(ev.blockNumber, headBlock)

  const isLiq = ev.type === 'liquidated'

  // Build one-line summary
  let summary = ''
  let dotColor = 'var(--subtle)'

  if (ev.type === 'match') {
    dotColor = 'var(--accent)'
    const lev   = ev.leverage ? `${ev.leverage}×` : ''
    const col   = ev.lockedCollateral ? `$${formatUsdc(ev.lockedCollateral)}` : ''
    const price = ev.price ? `@ $${formatPrice(ev.price)}` : ''
    const long  = ev.longTrader  ? shortAddr(ev.longTrader)  : ''
    const short = ev.shortTrader ? shortAddr(ev.shortTrader) : ''
    const vs    = long && short ? `${long} vs ${short}` : long || short
    summary = ['Match', lev, col, price, vs].filter(Boolean).join(' · ')
  } else if (ev.type === 'liquidated') {
    dotColor = 'var(--danger)'
    const keeper = ev.keeper ? `keeper ${shortAddr(ev.keeper)}` : ''
    summary = ['LIQUIDATED', ev.trader ? shortAddr(ev.trader) : '', keeper].filter(Boolean).join(' · ')
  } else if (ev.type === 'rematched') {
    dotColor = 'var(--bar-rematched)'
    const col = ev.newLockedCollateral ? `$${formatUsdc(ev.newLockedCollateral)}` : ''
    summary = ['Re-matched', col].filter(Boolean).join(' · ')
  } else if (ev.type === 'closed') {
    dotColor = 'var(--border-strong)'
    summary = ['Closed', ev.trader ? shortAddr(ev.trader) : ''].filter(Boolean).join(' · ')
  }

  return (
    <a href={txUrl} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-3 px-4 transition-colors hover:bg-white/[0.03]"
      style={{
        paddingTop: isLiq ? 10 : 7,
        paddingBottom: isLiq ? 10 : 7,
        borderBottom: '1px solid var(--border)',
        background: isLiq ? 'rgba(255,61,87,0.04)' : undefined,
      }}>
      {/* Signal dot */}
      <span className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: dotColor, boxShadow: isLiq ? `0 0 6px ${dotColor}` : 'none' }} />
      {/* One-line text */}
      <span className="mono text-[11px] flex-1 truncate"
        style={{ color: isLiq ? 'var(--danger)' : 'var(--ink-2)' }}>
        {summary}
      </span>
      {/* Time */}
      <span className="mono text-[10px] shrink-0" style={{ color: 'var(--subtle)' }}>{time}</span>
    </a>
  )
}

export function LiveFeed() {
  const { events, loading, headBlock } = useMatchFeed()
  const head = headBlock ?? 0n

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-[var(--border)]">
        <div className="flex items-baseline gap-3">
          <h2 className="display text-xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>Live Feed</h2>
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--success)' }} />
            <span className="mono text-[10px]" style={{ color: 'var(--subtle)' }}>block #{head.toString()}</span>
          </span>
        </div>
        <span className="mono text-[10px]" style={{ color: 'var(--subtle)' }}>5k blocks · 15s</span>
      </div>

      {/* Events list */}
      <div className="max-h-[520px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12" style={{ color: 'var(--subtle)' }}>
            <Loader2 size={14} className="animate-spin" />
            <span className="mono text-xs">Scanning chain…</span>
          </div>
        ) : events.length === 0 ? (
          <div className="py-12 text-center">
            <p className="mono text-xs" style={{ color: 'var(--subtle)' }}>No recent activity.</p>
          </div>
        ) : (
          events.map(ev => <EventRow key={ev.id} ev={ev} headBlock={head} />)
        )}
      </div>
    </div>
  )
}
