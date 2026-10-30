/**
 * TraderProfile — per-wallet stats, match history, and survival chains.
 *
 * Shows:
 *  - Win rate, total matches, wins/losses, best streak, current streak, volume
 *  - Survival chain timeline: sequences of consecutive re-matched orders
 *  - Recent match history list (last 5000 blocks)
 *
 * Data from contract getStats() + event logs — fully on-chain, no backend.
 */

import { useTraderProfile } from '@/hooks/useTraderProfile'
import { ArrowLeft, TrendingUp, TrendingDown, Zap, Loader2, Shield, ArrowRight, AlertCircle } from 'lucide-react'
import type { Hex } from 'viem'

interface TraderProfileProps {
  address: Hex
  myAddress?: Hex | null
  onBack: () => void
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function StatCard({ label, value, sub, highlight }: {
  label: string; value: string; sub?: string; highlight?: 'green' | 'red' | 'yellow' | 'default'
}) {
  const color = highlight === 'green'  ? 'var(--success)'
              : highlight === 'red'    ? 'var(--danger)'
              : highlight === 'yellow' ? '#facc15'
              : 'var(--ink)'
  return (
    <div className="rounded-lg p-3 border border-[var(--border)]" style={{ background: 'rgba(255,255,255,0.04)' }}>
      <p className="text-[9px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--subtle)' }}>{label}</p>
      <p className="display font-bold tabular-nums text-xl" style={{ color, letterSpacing: '-0.04em' }}>{value}</p>
      {sub && <p className="mono text-[10px] mt-0.5" style={{ color: 'var(--subtle)' }}>{sub}</p>}
    </div>
  )
}

export function TraderProfile({ address, myAddress, onBack }: TraderProfileProps) {
  const { stats, matches, survivalChains, loading } = useTraderProfile(address)
  const isMe = myAddress && address.toLowerCase() === myAddress.toLowerCase()

  const closed = Number(stats.totalWins + stats.totalLosses)
  const winRate = closed > 0 ? (Number(stats.totalWins) / closed * 100) : null

  return (
    <div className="flex flex-col gap-4">
      {/* Back + hero */}
      <div className="rounded-xl border border-[var(--border)] p-4" style={{ background: 'var(--surface)' }}>
        <div className="flex items-start justify-between mb-4">
          <button onClick={onBack}
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: 'var(--subtle)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--ink)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--subtle)')}>
            <ArrowLeft size={13} />
            Back
          </button>
          <a href={`https://explorer.testnet.arc.io/address/${address}`}
            target="_blank" rel="noopener noreferrer"
            className="mono text-[10px] transition-colors"
            style={{ color: 'var(--subtle)' }}>
            explorer ↗
          </a>
        </div>
        {/* Address hero */}
        <p className="mono text-sm font-semibold mb-0.5" style={{ color: 'var(--ink-2)' }}>{shortAddr(address)}</p>
        {isMe && (
          <span className="mono text-[9px] font-semibold px-1.5 py-0.5 rounded"
            style={{ color: 'var(--accent)', background: 'rgba(200,216,240,0.12)' }}>YOU</span>
        )}
        {/* Three headline stats */}
        <div className="flex gap-6 mt-4">
          <div>
            <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--subtle)' }}>Win Rate</p>
            <p className="display font-bold text-3xl tabular-nums" style={{
              color: winRate === null ? 'var(--subtle)' : winRate >= 60 ? 'var(--success)' : winRate < 40 ? 'var(--danger)' : 'var(--ink)',
              letterSpacing: '-0.04em',
            }}>
              {winRate !== null ? `${winRate.toFixed(0)}%` : '—'}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--subtle)' }}>Best Streak</p>
            <p className="display font-bold text-3xl tabular-nums" style={{ color: 'var(--accent)', letterSpacing: '-0.04em' }}>
              {stats.bestStreak > 0n ? stats.bestStreak.toString() : '—'}
            </p>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider mb-1" style={{ color: 'var(--subtle)' }}>Volume</p>
            <p className="display font-bold text-3xl tabular-nums" style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>
              ${(Number(stats.totalVolume) / 1e6).toFixed(0)}
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[var(--subtle)]">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-sm">Loading profile…</span>
        </div>
      ) : (
        <>
          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-2">
            <StatCard
              label="Win Rate"
              value={winRate !== null ? `${winRate.toFixed(1)}%` : '—'}
              sub={`${closed} closed`}
              highlight={winRate === null ? 'default' : winRate >= 60 ? 'green' : winRate < 40 ? 'red' : 'default'}
            />
            <StatCard
              label="Wins / Losses"
              value={`${stats.totalWins.toString()} / ${stats.totalLosses.toString()}`}
              highlight="default"
            />
            <StatCard
              label="Best Streak"
              value={stats.bestStreak > 0n ? stats.bestStreak.toString() : '—'}
              sub={stats.winStreak > 0n ? `Current: ${stats.winStreak}` : undefined}
              highlight={stats.bestStreak >= 3n ? 'yellow' : 'default'}
            />
            <StatCard
              label="Total Matches"
              value={stats.totalMatches.toString()}
              highlight="default"
            />
            <StatCard
              label="Volume"
              value={`$${(Number(stats.totalVolume) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              sub="USDC"
              highlight="default"
            />
            <StatCard
              label="Current Streak"
              value={stats.winStreak > 0n ? `${stats.winStreak}W` : stats.winStreak === 0n && stats.totalLosses > 0n ? '—' : '—'}
              highlight={stats.winStreak >= 2n ? 'yellow' : 'default'}
            />
          </div>

          {/* Survival chains */}
          {survivalChains.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] p-4" style={{ background: 'rgba(255,255,255,0.04)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Zap size={12} className="text-yellow-400" />
                <h3 className="display text-xs font-semibold text-[var(--ink)]">
                  Survival Chains
                </h3>
                <span className="text-[9px] text-[var(--subtle)]">— re-matched after liquidating a counterpart</span>
              </div>
              <div className="flex flex-col gap-2">
                {survivalChains.map((chain, i) => (
                  <div key={chain.startOrderId.toString()} className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] text-[var(--subtle)] mr-1">#{i + 1}</span>
                    {chain.chain.map((id, j) => (
                      <span key={id.toString()} className="flex items-center gap-1">
                        <span className={`text-[10px] mono px-1.5 py-0.5 rounded ${
                          j === 0 ? 'bg-[var(--danger)]/15 text-[var(--danger)]'
                          : j === chain.chain.length - 1 ? 'bg-[var(--success)]/15 text-[var(--success)]'
                          : 'bg-[var(--accent)]/10 text-[var(--accent)]'
                        }`}>
                          #{id.toString()}
                        </span>
                        {j < chain.chain.length - 1 && (
                          <ArrowRight size={9} className="text-[var(--subtle)]" />
                        )}
                      </span>
                    ))}
                    <span className="text-[9px] text-[var(--subtle)] ml-1">
                      ({chain.length - 1} survival{chain.length - 1 !== 1 ? 's' : ''})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Match history */}
          <div className="rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <div className="px-4 py-3 border-b border-[var(--border)]">
              <h3 className="display text-xs font-semibold text-[var(--ink)]">
                Match History <span className="text-[var(--subtle)] font-normal">(last 5,000 blocks)</span>
              </h3>
            </div>
            {matches.length === 0 ? (
              <div className="py-8 text-center">
                <AlertCircle size={18} className="text-[var(--subtle)]/40 mx-auto mb-2" />
                <p className="text-xs text-[var(--subtle)]">No matches found in this window.</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border)]/50 max-h-60 overflow-y-auto">
                {matches.map(m => (
                  <a key={m.orderId.toString()}
                    href={`https://explorer.testnet.arc.io/tx/${m.txHash}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-white/5 transition-colors">
                    <div className="flex items-center gap-2">
                      {m.outcome === 'win' && <TrendingUp size={11} className="text-[var(--success)]" />}
                      {m.outcome === 'loss' && <TrendingDown size={11} className="text-[var(--danger)]" />}
                      {m.outcome === 'liquidated' && <AlertCircle size={11} className="text-yellow-400" />}
                      {m.outcome === 'open' && <Zap size={11} className="text-[var(--accent)]" />}
                      <span className="text-xs text-[var(--ink-2)] mono">Order #{m.orderId.toString()}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] font-semibold ${
                        m.outcome === 'win'        ? 'text-[var(--success)]'
                        : m.outcome === 'loss'     ? 'text-[var(--danger)]'
                        : m.outcome === 'liquidated'? 'text-yellow-400'
                        : 'text-[var(--accent)]'
                      }`}>
                        {m.outcome === 'win'        ? 'Win'
                        : m.outcome === 'loss'      ? 'Loss'
                        : m.outcome === 'liquidated'? 'Liquidated'
                        : 'Open'}
                      </span>
                      <span className="text-[9px] text-[var(--subtle)] mono">
                        #{m.blockNumber.toString()}
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
