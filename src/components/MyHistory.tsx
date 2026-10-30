/**
 * MyHistory — personal trade history tab.
 * Shows closed trades from OrderClosed events, sorted newest-first.
 * Displays pair, direction, leverage, PnL, payout, and tx link.
 */

import { useMyHistory, type TradeRecord } from '@/hooks/useMyHistory'
import { Loader2 } from 'lucide-react'

function fmtPnl(pnl: bigint): string {
  const n = Number(pnl) / 1e6
  const sign = n >= 0 ? '+' : ''
  return `${sign}$${n.toFixed(2)}`
}

function fmtUsdc(raw: bigint): string {
  return `$${(Number(raw) / 1e6).toFixed(2)}`
}

function TradeRow({ t }: { t: TradeRecord }) {
  const isWin = t.pnl >= 0n
  const txUrl = `https://explorer.testnet.arc.io/tx/${t.txHash}`

  return (
    <a href={txUrl} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors"
      style={{ borderBottom: '1px solid var(--border)' }}>

      {/* Direction badge */}
      <span className="mono text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
        style={{
          background: t.isLong ? 'rgba(0,230,118,0.12)' : 'rgba(255,61,87,0.12)',
          color: t.isLong ? 'var(--success)' : 'var(--danger)',
        }}>
        {t.isLong ? 'LONG' : 'SHORT'}
      </span>

      {/* Pair + leverage */}
      <div className="flex-1 min-w-0">
        <p className="mono text-[11px]" style={{ color: 'var(--ink)' }}>
          {t.pairLabel ?? '—'} {t.leverage ? `${t.leverage}×` : ''}
        </p>
        {t.collateral != null && (
          <p className="mono text-[9px]" style={{ color: 'var(--subtle)' }}>
            {fmtUsdc(t.collateral)} collateral
          </p>
        )}
      </div>

      {/* PnL */}
      <span className="mono text-xs font-bold tabular-nums shrink-0"
        style={{ color: isWin ? 'var(--success)' : 'var(--danger)' }}>
        {fmtPnl(t.pnl)}
      </span>

      {/* Explorer arrow */}
      <span className="mono text-[10px] shrink-0" style={{ color: 'var(--subtle)' }}>↗</span>
    </a>
  )
}

function SummaryBar({ trades }: { trades: TradeRecord[] }) {
  if (trades.length === 0) return null
  const wins   = trades.filter(t => t.pnl >= 0n).length
  const losses = trades.length - wins
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0n)
  const isPos = totalPnl >= 0n
  const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 100) : 0

  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b border-[var(--border)]"
      style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div>
        <p className="mono text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--subtle)' }}>Win Rate</p>
        <p className="display font-bold text-lg" style={{ color: winRate >= 50 ? 'var(--success)' : 'var(--danger)', letterSpacing: '-0.04em' }}>
          {winRate}%
        </p>
      </div>
      <div className="w-px h-8 self-center" style={{ background: 'var(--border)' }} />
      <div>
        <p className="mono text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--subtle)' }}>Total P&L</p>
        <p className="display font-bold text-lg tabular-nums" style={{ color: isPos ? 'var(--success)' : 'var(--danger)', letterSpacing: '-0.04em' }}>
          {fmtPnl(totalPnl)}
        </p>
      </div>
      <div className="w-px h-8 self-center" style={{ background: 'var(--border)' }} />
      <div>
        <p className="mono text-[9px] uppercase tracking-wider mb-0.5" style={{ color: 'var(--subtle)' }}>Trades</p>
        <p className="mono text-sm font-bold" style={{ color: 'var(--ink)' }}>
          <span style={{ color: 'var(--success)' }}>{wins}W</span>
          <span style={{ color: 'var(--subtle)' }}> / </span>
          <span style={{ color: 'var(--danger)' }}>{losses}L</span>
        </p>
      </div>
    </div>
  )
}

export function MyHistory({ address }: { address: string | null }) {
  const { trades, loading } = useMyHistory(address)

  if (!address) {
    return (
      <div className="rounded-xl border border-[var(--border)] py-12 text-center" style={{ background: 'var(--surface)' }}>
        <p className="mono text-xs" style={{ color: 'var(--subtle)' }}>Connect your wallet to view history.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-[var(--border)]">
        <h2 className="display text-xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>
          My History
        </h2>
        {loading && <Loader2 size={13} className="animate-spin" style={{ color: 'var(--subtle)' }} />}
      </div>

      {/* Summary */}
      {!loading && <SummaryBar trades={trades} />}

      {/* Trade list */}
      <div className="max-h-[460px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12" style={{ color: 'var(--subtle)' }}>
            <Loader2 size={14} className="animate-spin" />
            <span className="mono text-xs">Loading trades…</span>
          </div>
        ) : trades.length === 0 ? (
          <div className="py-12 text-center">
            <p className="mono text-xs" style={{ color: 'var(--subtle)' }}>No closed trades yet.</p>
          </div>
        ) : (
          trades.map(t => <TradeRow key={`${t.orderId}-${t.txHash}`} t={t} />)
        )}
      </div>
    </div>
  )
}
