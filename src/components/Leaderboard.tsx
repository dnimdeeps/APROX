/**
 * Leaderboard — ranked table of all traders discovered from on-chain events.
 *
 * Default sort: win rate (% of closed positions profitable).
 * Columns: rank, address, win rate, matches, wins, best streak, volume.
 * Clicking a row calls onSelectTrader to open the trader's profile.
 *
 * All data from contract getStats() — fully trustless, no backend.
 */

import { useState } from 'react'
import { useLeaderboard, type SortKey } from '@/hooks/useLeaderboard'
import { Trophy, TrendingUp, Zap, Loader2, ChevronUp, ChevronDown, Users } from 'lucide-react'
import type { Hex } from 'viem'

interface LeaderboardProps {
  onSelectTrader: (addr: Hex) => void
  myAddress?: Hex | null
}

const SORT_LABELS: Record<SortKey, string> = {
  winRate:      'Win Rate',
  totalWins:    'Wins',
  bestStreak:   'Best Streak',
  totalVolume:  'Volume',
  totalMatches: 'Matches',
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function rankBadge(rank: number) {
  const label = String(rank).padStart(2, '0')
  const color = rank === 1 ? 'var(--accent)'
              : rank === 2 ? 'var(--ink-2)'
              : rank === 3 ? 'var(--muted)'
              : 'var(--subtle)'
  return (
    <span className="display font-bold tabular-nums text-base w-8 shrink-0" style={{ color, letterSpacing: '-0.04em' }}>
      {label}
    </span>
  )
}

export function Leaderboard({ onSelectTrader, myAddress }: LeaderboardProps) {
  const { entries, loading } = useLeaderboard()
  const [sortKey, setSortKey] = useState<SortKey>('winRate')
  const [sortAsc, setSortAsc] = useState(false)

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(a => !a)
    else { setSortKey(key); setSortAsc(false) }
  }

  const sorted = [...entries].sort((a, b) => {
    let diff = 0
    if (sortKey === 'winRate')      diff = b.winRate - a.winRate
    if (sortKey === 'totalWins')    diff = Number(b.stats.totalWins    - a.stats.totalWins)
    if (sortKey === 'bestStreak')   diff = Number(b.stats.bestStreak   - a.stats.bestStreak)
    if (sortKey === 'totalVolume')  diff = Number(b.stats.totalVolume  - a.stats.totalVolume)
    if (sortKey === 'totalMatches') diff = Number(b.stats.totalMatches - a.stats.totalMatches)
    return sortAsc ? -diff : diff
  })

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronDown size={10} className="opacity-30" />
    return sortAsc
      ? <ChevronUp size={10} className="text-[var(--accent)]" />
      : <ChevronDown size={10} className="text-[var(--accent)]" />
  }

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-[var(--border)]">
        <div className="flex items-baseline gap-3">
          <h2 className="display text-xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>Leaderboard</h2>
          {entries.length > 0 && (
            <span className="mono text-[10px]" style={{ color: 'var(--subtle)' }}>{entries.length} traders</span>
          )}
        </div>
        <span className="mono text-[10px]" style={{ color: 'var(--subtle)' }}>on-chain · 30s</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[var(--subtle)]">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-sm">Reading chain…</span>
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-12 text-center">
          <Users size={24} className="text-[var(--subtle)]/40 mx-auto mb-2" />
          <p className="text-sm text-[var(--subtle)]">No traders found yet.</p>
          <p className="text-xs text-[var(--subtle)]/60 mt-1">Open a position to appear here.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-2 text-left text-[var(--subtle)] font-medium w-10">#</th>
                <th className="px-4 py-2 text-left text-[var(--subtle)] font-medium">Trader</th>
                {(['winRate', 'totalMatches', 'totalWins', 'bestStreak', 'totalVolume'] as SortKey[]).map(key => (
                  <th key={key}
                    className="px-3 py-2 text-right text-[var(--subtle)] font-medium cursor-pointer hover:text-[var(--ink)] select-none"
                    onClick={() => handleSort(key)}>
                    <span className="flex items-center justify-end gap-1">
                      {SORT_LABELS[key]}
                      <SortIcon col={key} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry, i) => {
                const isMe = myAddress && entry.address.toLowerCase() === myAddress.toLowerCase()
                const closed = Number(entry.stats.totalWins + entry.stats.totalLosses)
                return (
                  <tr key={entry.address}
                    onClick={() => onSelectTrader(entry.address)}
                    className="border-b border-[var(--border)]/50 cursor-pointer transition-colors hover:bg-white/[0.04]"
                    style={isMe ? { borderLeft: '2px solid var(--accent)', paddingLeft: 0 } : {}}>
                    <td className="pl-4 pr-2 py-3">{rankBadge(i + 1)}</td>
                    <td className="px-2 py-3">
                      <div className="flex items-center gap-2">
                        <span className="mono text-xs" style={{ color: 'var(--ink-2)' }}>{shortAddr(entry.address)}</span>
                        {isMe && (
                          <span className="mono text-[9px] font-semibold px-1.5 py-0.5 rounded"
                            style={{ color: 'var(--accent)', background: 'rgba(200,216,240,0.12)' }}>YOU</span>
                        )}
                      </div>
                    </td>
                    {/* Win rate — headline stat, large */}
                    <td className="px-3 py-3 text-right">
                      <span className={`display font-bold text-base tabular-nums`}
                        style={{
                          color: closed === 0 ? 'var(--subtle)'
                               : entry.winRate >= 60 ? 'var(--success)'
                               : entry.winRate >= 40 ? 'var(--ink)'
                               : 'var(--danger)',
                          letterSpacing: '-0.03em',
                        }}>
                        {closed === 0 ? '—' : `${entry.winRate.toFixed(0)}%`}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right mono text-xs" style={{ color: 'var(--subtle)' }}>
                      {entry.stats.totalMatches.toString()}
                    </td>
                    <td className="px-3 py-3 text-right mono text-xs" style={{ color: 'var(--success)' }}>
                      {entry.stats.totalWins.toString()}
                    </td>
                    {/* Streak — silent when 0 */}
                    <td className="px-3 py-3 text-right mono text-xs">
                      {entry.stats.bestStreak > 0n
                        ? <span style={{ color: 'var(--accent)' }}>{entry.stats.bestStreak.toString()} streak</span>
                        : <span style={{ color: 'var(--border)' }}>—</span>
                      }
                    </td>
                    <td className="px-3 py-3 text-right mono text-xs" style={{ color: 'var(--subtle)' }}>
                      ${(Number(entry.stats.totalVolume) / 1e6).toFixed(0)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
