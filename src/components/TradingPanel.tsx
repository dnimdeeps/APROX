/**
 * TradingPanel — V2 Peer-to-Peer order book UI
 *
 * Multiple open orders per wallet are supported — the contract has no limit.
 * All active/pending orders are shown as cards; the open-new-order form is
 * always visible below them.
 *
 * Order lifecycle:
 *   PENDING  — collateral locked, waiting for counterpart
 *   ACTIVE   — matched, PnL accruing live
 *   CLOSED   — settled
 *   CANCELLED — pending remainder refunded
 *
 * All transactions are gasless (ERC-4337 via Gas Station paymaster).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  TrendingUp, TrendingDown, Clock, Zap, X, Loader2, CheckCircle2,
  AlertTriangle, ChevronUp, ChevronDown, BarChart2,
} from 'lucide-react'
import type { UseModularWalletReturn } from '@/hooks/useModularWallet'
import { IS_MAINNET } from '@/network'
import { useAproxContract, OrderStatus, TRADING_PAIRS } from '@/hooks/useAproxContract'
import type { Order, MarketDepth } from '@/hooks/useAproxContract'
import { encodeFunctionData as _efd, decodeFunctionResult as _dfr, parseAbi as _pa, type Hex } from 'viem'
import { publicClient } from '@/hooks/useModularWallet'
import type { UsePriceFeedReturn } from '@/hooks/usePriceFeed'
import type { OraclePriceState } from '@/hooks/useOraclePrice'
import { useLivePnl } from '@/hooks/useLivePnl'
import { MatchBar } from '@/components/MatchBar'
import { useQueuePosition } from '@/hooks/useQueuePosition'



interface TradingPanelProps {
  wallet: UseModularWalletReturn
  feed: UsePriceFeedReturn
  oracle: OraclePriceState
  selectedPair: Hex
  onPairChange: (pair: Hex) => void
  activeTab: 'deposit' | 'trade'
  onTabChange: (tab: 'deposit' | 'trade') => void
}

type TxState = 'idle' | 'pending' | 'confirmed' | 'error'

function formatUSD(n: number, decimals = 2) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n)
}

function formatAge(openedAt: bigint): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(openedAt) * 1000) / 1000))
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

const MIN_LEVERAGE = 1
const MAX_LEVERAGE = 100
const LEVERAGE_LABELS = [1, 25, 50, 75, 100]

// Valid leverage values 1-100
const ALL_LEVERAGES = Array.from({ length: 100 }, (_, i) => i + 1)

const STATUS_LABEL: Record<OrderStatus, string> = {
  [OrderStatus.PENDING]: 'Pending',
  [OrderStatus.ACTIVE]: 'Matched',
  [OrderStatus.CLOSED]: 'Closed',
  [OrderStatus.CANCELLED]: 'Cancelled',
}

const STATUS_COLOR: Record<OrderStatus, string> = {
  [OrderStatus.PENDING]: 'text-yellow-400',
  [OrderStatus.ACTIVE]: 'text-[var(--success)]',
  [OrderStatus.CLOSED]: 'text-[var(--subtle)]',
  [OrderStatus.CANCELLED]: 'text-[var(--danger)]',
}

// ── Collapsible error ────────────────────────────────────────────────────────

function CollapsibleError({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = message.length > 120
  const preview = isLong && !expanded ? message.slice(0, 120) + '…' : message
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-[var(--danger)]/10 border border-[var(--danger)]/30 text-sm text-[var(--danger)]">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="break-all whitespace-pre-wrap">{preview}</p>
        {isLong && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="mt-1 flex items-center gap-1 text-xs text-[var(--danger)]/70 hover:text-[var(--danger)] transition-colors"
          >
            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {expanded ? 'Show less' : 'Show full error'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Single order card ────────────────────────────────────────────────────────

interface OrderCardProps {
  id: bigint
  order: Order
  /** Exact PnL from contract's computeLivePnl — identical to settlement value */
  livePnlUsdc: number | null
  onClose: (id: bigint) => void
  onCancel: (id: bigint) => void
  txPending: boolean
}

function OrderCard({ id, order, livePnlUsdc, onClose, onCancel, txPending }: OrderCardProps) {
  const [age, setAge] = useState(() => formatAge(order.openedAt))
  const isPending = order.status === OrderStatus.PENDING && order.pendingCollateral > 0n && order.matchedCollateral === 0n
  const queuePosition = useQueuePosition(
    id,
    order.isLong,
    order.leverage,
    order.pairId as `0x${string}`,
    isPending,
  )

  useEffect(() => {
    const tick = () => setAge(formatAge(order.openedAt))
    tick()
    const i = setInterval(tick, 1000)
    return () => clearInterval(i)
  }, [order.openedAt])

  // OperatorPriceFeed (and Chainlink DS) use 8 decimals — divide by 1e8 to get USD.
  const entryPriceUsd = order.entryPrice > 0n ? Number(order.entryPrice) / 1e8 : null

  // PnL comes from computeLivePnl on the contract — exact same math as settlement.
  const livePnl = order.matchedCollateral > 0n ? livePnlUsdc : null

  const pnlPositive = (livePnl ?? 0) >= 0
  // PnL as a percentage of matched collateral (not notional) — shows return on capital
  const livePnlPct = livePnl !== null && order.matchedCollateral > 0n
    ? (livePnl / (Number(order.matchedCollateral) / 1e6)) * 100
    : null
  // Warn when position has hit max profit (counterpart effectively liquidatable)
  const atMaxProfit = livePnlPct !== null && livePnlPct >= 99.5
  const atMaxLoss   = livePnlPct !== null && livePnlPct <= -79.5  // near liquidation threshold
  const matchedUsd = (Number(order.matchedCollateral) / 1e6).toFixed(2)
  const pendingUsd = (Number(order.pendingCollateral) / 1e6).toFixed(2)

  const entryUsd = entryPriceUsd
    ? entryPriceUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : null

  const liqPrice = entryPriceUsd
    ? (() => {
        const factor = 0.8 / order.leverage
        return order.isLong ? entryPriceUsd * (1 - factor) : entryPriceUsd * (1 + factor)
      })()
    : null

  // An order is effectively active (showing PnL) when it has matched collateral,
  // regardless of whether some pending remainder still exists.
  const hasActiveComponent = order.matchedCollateral > 0n
  const hasPendingComponent = order.pendingCollateral > 0n
  const displayStatus = hasActiveComponent ? OrderStatus.ACTIVE : order.status

  // Card left-border signal color
  const cardBorder = hasActiveComponent
    ? pnlPositive
      ? 'border-l-[var(--success)]/40'
      : 'border-l-[var(--danger)]/40'
    : 'border-l-yellow-500/30'

  return (
    <div className={`rounded-xl border border-[var(--border)] border-l-2 ${cardBorder} overflow-hidden`}
      style={{ background: 'var(--surface)' }}>

      {/* ── Header ── */}
      <div className="flex items-start justify-between px-4 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex flex-col gap-1">
          {/* Pair + direction + leverage */}
          <span className={`display text-base font-bold tracking-tight ${
            order.isLong ? 'text-[var(--success)]' : 'text-[var(--danger)]'
          }`}>
            {TRADING_PAIRS.find(p => p.id === order.pairId)?.symbol ?? 'BTC'}/USD&nbsp;
            {order.isLong ? 'LONG' : 'SHORT'}&nbsp;{order.leverage}×
          </span>
          {/* Status chip */}
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full inline-block ${
              hasActiveComponent ? 'bg-[var(--success)]' : 'bg-yellow-400'
            }`} />
            <span className="mono text-[10px] tracking-widest uppercase text-[var(--subtle)]">
              {STATUS_LABEL[displayStatus]}
            </span>
            {hasActiveComponent && hasPendingComponent && (
              <span className="mono text-[10px] text-yellow-400 tracking-widest uppercase">+ pending</span>
            )}
          </div>
        </div>
        {/* Order ID + age */}
        <div className="flex flex-col items-end gap-0.5">
          <span className="mono text-[10px] text-[var(--subtle)]">#{id.toString()}</span>
          <span className="mono text-[10px] text-[var(--subtle)]">{age}</span>
        </div>
      </div>

      {/* ── Match bar (active orders) ── */}
      {hasActiveComponent && (
        <div className="px-4 pt-4">
          <MatchBar order={order} livePnlUsdc={livePnl} />
        </div>
      )}

      {/* ── Live PnL ── */}
      {hasActiveComponent && (
        <div className="px-4 pt-3 pb-1 text-center">
          {livePnl === null ? (
            <p className="text-sm text-[var(--subtle)]">Waiting for price…</p>
          ) : (
            <div className="flex items-baseline justify-center gap-2">
              <span className={`display font-bold tabular-nums text-3xl ${
                pnlPositive ? 'text-[var(--success)]' : 'text-[var(--danger)]'
              }`}>
                {pnlPositive ? '+' : ''}{livePnl.toFixed(2)}
              </span>
              <span className="mono text-sm text-[var(--subtle)]">USDC</span>
              {livePnlPct !== null && (
                <span className={`mono text-xs tabular-nums ${
                  pnlPositive ? 'text-[var(--success)]/70' : 'text-[var(--danger)]/70'
                }`}>
                  ({pnlPositive ? '+' : ''}{livePnlPct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Secondary data row ── */}
      <div className="px-4 py-3 flex flex-wrap gap-x-5 gap-y-1.5">
        <div>
          <p className="text-[9px] text-[var(--subtle)] uppercase tracking-wider mb-0.5">Matched</p>
          <p className="mono text-xs text-[var(--ink-2)]">${matchedUsd}</p>
        </div>
        {hasPendingComponent && (
          <div>
            <p className="text-[9px] text-[var(--subtle)] uppercase tracking-wider mb-0.5">Pending</p>
            <p className="mono text-xs text-yellow-400">${pendingUsd}</p>
          </div>
        )}
        {queuePosition !== null && (
          <div>
            <p className="text-[9px] text-[var(--subtle)] uppercase tracking-wider mb-0.5">Queue</p>
            <p className="mono text-xs text-yellow-400">#{queuePosition} in line</p>
          </div>
        )}
        {entryUsd && (
          <div>
            <p className="text-[9px] text-[var(--subtle)] uppercase tracking-wider mb-0.5">Entry</p>
            <p className="mono text-xs text-[var(--ink-2)]">${entryUsd}</p>
          </div>
        )}
        {liqPrice && (
          <div>
            <p className="text-[9px] text-[var(--subtle)] uppercase tracking-wider mb-0.5">Liq. Price</p>
            <p className="mono text-xs text-[var(--danger)]">
              ${liqPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </p>
          </div>
        )}
      </div>

      {/* ── Warnings ── */}
      {atMaxProfit && (
        <div className="mx-4 mb-3 flex items-start gap-2 p-2 rounded-lg border"
          style={{ background: 'rgba(0,230,118,0.06)', borderColor: 'rgba(0,230,118,0.25)' }}>
          <Zap size={11} className="mt-0.5 shrink-0" style={{ color: 'var(--success)' }} />
          <p className="text-xs leading-relaxed" style={{ color: 'var(--success)' }}>
            Max profit — counterpart is liquidatable. Close to lock in gains.
          </p>
        </div>
      )}
      {atMaxLoss && !atMaxProfit && (
        <div className="mx-4 mb-3 flex items-start gap-2 p-2 rounded-lg border"
          style={{ background: 'rgba(255,61,87,0.06)', borderColor: 'rgba(255,61,87,0.25)' }}>
          <AlertTriangle size={11} className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-xs leading-relaxed" style={{ color: 'var(--danger)' }}>
            Near liquidation — a keeper may close this position.
          </p>
        </div>
      )}
      {!hasActiveComponent && hasPendingComponent && (
        <div className="mx-4 mb-3 flex items-start gap-2 p-2 rounded-lg border border-yellow-500/20"
          style={{ background: 'rgba(234,179,8,0.06)' }}>
          <Clock size={11} className="text-yellow-400 mt-0.5 shrink-0" />
          <p className="text-xs text-yellow-300 leading-relaxed">
            Waiting for a {order.isLong ? 'Short' : 'Long'} counterpart. Collateral is safe. Cancel to withdraw.
          </p>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex gap-2 px-4 pb-4">
        {hasActiveComponent && (
          <button
            onClick={() => onClose(id)}
            disabled={txPending}
            className="flex-1 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-40"
            style={{ background: 'var(--accent)', color: '#0a1628' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
          >
            Close Position
          </button>
        )}
        {hasPendingComponent && (
          <button
            onClick={() => onCancel(id)}
            disabled={txPending}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-[var(--subtle)] text-sm font-medium disabled:opacity-40 transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)]"
          >
            <X size={13} />
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

// ── Market Depth multicall helpers ───────────────────────────────────────────
// All 100 getMarketDepth calls collapse into a single multicall RPC request.
const MULTICALL3_ADDRESS_FOR_DEPTH = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex
const PERP_ADDRESS_FOR_DEPTH = (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '') as Hex
const _DEPTH_ABI = _pa(['function getMarketDepth(uint8 leverage, bytes32 pairId) external view returns (uint256 pendingLong, uint256 pendingShort)'])
const MULTICALL3_ABI_FOR_DEPTH = _pa([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
])
const encodeFunctionDataForDepth = (lev: number, pairId: Hex) => _efd({ abi: _DEPTH_ABI, functionName: 'getMarketDepth', args: [lev, pairId] })
const decodeDepthResult = (data: Hex) => _dfr({ abi: _DEPTH_ABI, functionName: 'getMarketDepth', data }) as readonly [bigint, bigint]

// ── Market Depth Dashboard ───────────────────────────────────────────────────

interface DepthRow {
  leverage: number
  pendingLong: number
  pendingShort: number
}

interface MarketDepthDashboardProps {
  selectedPair: Hex
}

function MarketDepthDashboard({ selectedPair }: MarketDepthDashboardProps) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<DepthRow[]>([])
  const [loading, setLoading] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [lastFetched, setLastFetched] = useState<Hex | null>(null)

  const fetchDepth = useCallback(async () => {
    setLoading(true)
    setScanProgress(0)
    const found: DepthRow[] = []
    try {
      const calls = ALL_LEVERAGES.map(lev => ({
        target: PERP_ADDRESS_FOR_DEPTH,
        allowFailure: true,
        callData: encodeFunctionDataForDepth(lev, selectedPair),
      }))
      setScanProgress(50)
      const results = await publicClient.readContract({
        address: MULTICALL3_ADDRESS_FOR_DEPTH,
        abi: MULTICALL3_ABI_FOR_DEPTH,
        functionName: 'aggregate3',
        args: [calls],
      }) as Array<{ success: boolean; returnData: Hex }>
      setScanProgress(90)
      for (let i = 0; i < results.length; i++) {
        const { success, returnData } = results[i]
        if (!success || !returnData || returnData === '0x') continue
        try {
          const decoded = decodeDepthResult(returnData)
          const pendingLong  = Number(decoded[0]) / 1e6
          const pendingShort = Number(decoded[1]) / 1e6
          if (pendingLong > 0 || pendingShort > 0) {
            found.push({ leverage: ALL_LEVERAGES[i], pendingLong, pendingShort })
          }
        } catch { continue }
      }
      setRows([...found])
      setLastFetched(selectedPair)
      setScanProgress(100)
    } finally {
      setLoading(false)
      setScanProgress(0)
    }
  }, [selectedPair])

  useEffect(() => {
    if (open && lastFetched !== selectedPair) void fetchDepth()
  }, [open, lastFetched, selectedPair, fetchDepth])

  const totalLong  = rows.reduce((s, r) => s + r.pendingLong,  0)
  const totalShort = rows.reduce((s, r) => s + r.pendingShort, 0)

  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface)' }}>
      <button
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next && lastFetched !== selectedPair) void fetchDepth()
        }}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors"
      >
        <span className="flex items-center gap-2">
          <BarChart2 size={14} className="text-[var(--accent)]" />
          <span className="font-semibold">Market Depth — All Leverages</span>
        </span>
        <div className="flex items-center gap-2">
          {!open && (totalLong > 0 || totalShort > 0) && (
            <span className="text-xs text-[var(--subtle)]">
              <span className="text-[var(--success)]">${totalLong.toFixed(2)}L</span>
              {' · '}
              <span className="text-[var(--danger)]">${totalShort.toFixed(2)}S</span>
            </span>
          )}
          {open ? <ChevronUp size={15} className="text-[var(--subtle)]" /> : <ChevronDown size={15} className="text-[var(--subtle)]" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] px-4 pb-4">
          <div className="flex items-center justify-between pt-3 pb-2">
            <p className="text-xs text-[var(--subtle)]">Only leverages with pending volume shown.</p>
            <button onClick={() => void fetchDepth()} disabled={loading}
              className="text-xs text-[var(--accent)] hover:underline disabled:opacity-40">
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-2 text-xs text-[var(--subtle)]">
              <Loader2 size={12} className="animate-spin shrink-0" />
              <div className="flex-1">
                <div className="flex justify-between mb-1">
                  <span>Scanning leverage levels…</span>
                  <span>{scanProgress}%</span>
                </div>
                <div className="h-1 rounded-full bg-[var(--border)] overflow-hidden">
                  <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-200"
                    style={{ width: `${scanProgress}%` }} />
                </div>
              </div>
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="text-xs text-[var(--subtle)] py-3">No pending orders at any leverage level.</p>
          )}

          {rows.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="p-2 rounded-lg bg-[var(--success)]/5 border border-[var(--success)]/20 text-center">
                  <p className="text-xs text-[var(--subtle)] mb-0.5">Total Long Pending</p>
                  <p className="text-sm font-semibold mono text-[var(--success)]">${totalLong.toFixed(2)}</p>
                </div>
                <div className="p-2 rounded-lg bg-[var(--danger)]/5 border border-[var(--danger)]/20 text-center">
                  <p className="text-xs text-[var(--subtle)] mb-0.5">Total Short Pending</p>
                  <p className="text-sm font-semibold mono text-[var(--danger)]">${totalShort.toFixed(2)}</p>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="grid grid-cols-3 gap-2 px-1 mb-1">
                  <p className="text-[10px] text-[var(--subtle)] font-medium">Leverage</p>
                  <p className="text-[10px] text-[var(--success)] font-medium text-right">Long Pending</p>
                  <p className="text-[10px] text-[var(--danger)] font-medium text-right">Short Pending</p>
                </div>
                {rows.map(r => (
                  <div key={r.leverage} className="grid grid-cols-3 gap-2 px-1 py-1 rounded-lg hover:bg-[var(--surface-muted)] transition-colors">
                    <p className="text-xs mono font-semibold text-[var(--accent)]">{r.leverage}x</p>
                    <p className={`text-xs mono text-right ${r.pendingLong > 0 ? 'text-[var(--success)]' : 'text-[var(--subtle)]'}`}>
                      {r.pendingLong > 0 ? `$${r.pendingLong.toFixed(2)}` : '—'}
                    </p>
                    <p className={`text-xs mono text-right ${r.pendingShort > 0 ? 'text-[var(--danger)]' : 'text-[var(--subtle)]'}`}>
                      {r.pendingShort > 0 ? `$${r.pendingShort.toFixed(2)}` : '—'}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export function TradingPanel({ wallet, feed: _feed, oracle, selectedPair, onPairChange, activeTab, onTabChange }: TradingPanelProps) {
  const contract = useAproxContract(wallet)
  const { address } = wallet
  // Oracle price (OperatorPriceFeed, exact same as contract) — used for chart ticks.
  // Server WebSocket price (feed.price) is still used by PriceBar for visual animation
  // but is NOT used for PnL calculation anywhere in this panel.
  const oraclePrice = oracle.prices['BTC/USD'] ?? oracle.price ?? null

  const [freeBalance, setFreeBalance] = useState<string>('0.00')
  const [walletBalance, setWalletBalance] = useState<string>('0.00')
  const [activeOrders, setActiveOrders] = useState<Array<{ id: bigint; order: Order }>>([])
  const [scanning, setScanning] = useState(false)
  const [currentDepth, setCurrentDepth] = useState<MarketDepth>({ pendingLong: '0.00', pendingShort: '0.00' })
  const scanAddressRef = useRef<string | null>(null)
  const hasOrdersRef = useRef(false)
  const initialLoadDoneRef = useRef(false)
  // 429 backoff for the background refresh interval
  const refreshBackoffRef = useRef(60_000)
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Form state
  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sendAddress, setSendAddress] = useState('')
  const [collateral, setCollateral] = useState('')
  const [leverage, setLeverage] = useState<number>(10)
  const [isLong, setIsLong] = useState(true)
  // activeTab is controlled by App.tsx — no local state here

  // Tx state — split per tab so Funds errors never bleed into Trade and vice versa
  const [fundsTxState, setFundsTxState] = useState<TxState>('idle')
  const [fundsTxLabel, setFundsTxLabel] = useState('')
  const [fundsTxHash, setFundsTxHash] = useState<string | null>(null)
  const [fundsTxError, setFundsTxError] = useState<string | null>(null)

  const [tradeTxState, setTradeTxState] = useState<TxState>('idle')
  const [tradeTxLabel, setTradeTxLabel] = useState('')
  const [tradeTxHash, setTradeTxHash] = useState<string | null>(null)
  const [tradeTxError, setTradeTxError] = useState<string | null>(null)

  const leverageRef = useRef<number>(leverage)
  useEffect(() => { leverageRef.current = leverage }, [leverage])
  const selectedPairRef = useRef<Hex>(selectedPair)
  useEffect(() => { selectedPairRef.current = selectedPair }, [selectedPair])

  // Price ticks no longer needed — MatchBar replaced the chart

  // ── Live PnL from contract (exact settlement value, updates every 3s) ────
  // Stable dep: track order count + IDs as a string so useMemo only fires when
  // the actual order set changes, not on every render.
  const activeOrdersKey = activeOrders.map(({ id }) => id.toString()).join(',')
  const activeOrderIds = useMemo(
    () => activeOrders.filter(({ order }) => order.matchedCollateral > 0n).map(({ id }) => id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeOrdersKey]
  )
  const livePnlMap = useLivePnl(activeOrderIds)

  // ── Full state reset on account switch ──────────────────────────────────

  useEffect(() => {
    setFreeBalance('0.00')
    setWalletBalance('0.00')
    setActiveOrders([])
    setScanning(false)
    setCurrentDepth({ pendingLong: '0.00', pendingShort: '0.00' })
    setFundsTxState('idle')
    setFundsTxLabel('')
    setFundsTxHash(null)
    setFundsTxError(null)
    setTradeTxState('idle')
    setTradeTxLabel('')
    setTradeTxHash(null)
    setTradeTxError(null)
    // Reset form fields so account B doesn't see account A's inputs
    setDepositAmount('')
    setWithdrawAmount('')
    setSendAmount('')
    setSendAddress('')
    setCollateral('')
    setLeverage(10)
    setIsLong(true)
    hasOrdersRef.current = false
    initialLoadDoneRef.current = false
  }, [address])

  // ── Refresh ──────────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (!address) return
    const thisAddress = address
    scanAddressRef.current = thisAddress
    const isFirstLoad = !hasOrdersRef.current

    if (isFirstLoad && !initialLoadDoneRef.current) setScanning(true)
    try {
      // Single multicall: nextOrderId + freeBalance + all getOrder — one RPC call.
      const snap = await contract.refreshDashboard(address as `0x${string}`)
      if (scanAddressRef.current !== thisAddress) return
      setFreeBalance(snap.freeBalance)
      hasOrdersRef.current = snap.activeOrders.length > 0
      initialLoadDoneRef.current = true
      setActiveOrders(snap.activeOrders)
      // Success — reset backoff to base interval
      refreshBackoffRef.current = 60_000
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const is429 = msg.includes('rate limit') || msg.includes('429') || msg.includes('exceeds')
      if (is429) {
        // Back off: double up to 5 min, then reschedule the interval
        refreshBackoffRef.current = Math.min(refreshBackoffRef.current * 2, 300_000)
        if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current)
        refreshIntervalRef.current = setInterval(() => { void refresh() }, refreshBackoffRef.current)
      }
      // Only log non-429 errors — 429s are expected under rate limiting
      if (!is429) console.error('[TradingPanel] refresh failed:', msg.slice(0, 120))
    } finally {
      if (scanAddressRef.current === address) setScanning(false)
    }
  }, [address, contract])

  // Wallet USDC balance (raw smart-account balance before deposit).
  // Only changes on deposit/withdraw — fetched once on login and explicitly
  // after those actions. No background interval.
  const refreshWalletBalance = useCallback(async () => {
    if (!address) return
    try {
      const wbal = await contract.getWalletUsdcBalance(address as `0x${string}`)
      setWalletBalance(wbal)
    } catch { /* non-critical */ }
  }, [address, contract])

  // Current leverage depth — fetched on login and on leverage/pair change
  // (debounced below). No background interval needed.
  const refreshDepth = useCallback(async () => {
    if (!address) return
    try {
      const d = await contract.getMarketDepth(leverageRef.current, selectedPairRef.current)
      setCurrentDepth(d)
    } catch { /* non-critical */ }
  }, [address, contract])

  useEffect(() => {
    if (!address) return
    // On login: fire all three reads, staggered by 1s each to avoid bursting
    // the RPC endpoint on mount.
    void refresh()
    const walletDelay = setTimeout(() => void refreshWalletBalance(), 1_000)
    const depthDelay  = setTimeout(() => void refreshDepth(), 2_000)
    // Safety-net background refresh: every 60s (backoff-aware — see refresh()).
    refreshBackoffRef.current = 60_000
    refreshIntervalRef.current = setInterval(() => void refresh(), 60_000)
    return () => {
      clearTimeout(walletDelay)
      clearTimeout(depthDelay)
      if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current)
    }
  }, [address, refresh, refreshWalletBalance, refreshDepth])

  // Re-fetch current leverage depth when leverage or pair changes (debounced 600ms)
  useEffect(() => {
    if (!address) return
    const timer = setTimeout(() => {
      contract.getMarketDepth(leverage, selectedPair).then(setCurrentDepth).catch(() => {})
    }, 600)
    return () => clearTimeout(timer)
  }, [leverage, selectedPair, address, contract])

  // ── Tx helpers ───────────────────────────────────────────────────────────
  //
  // Event-driven approach: once the tx hash comes back (meaning the UserOp is
  // included on-chain), we do ONE immediate refresh, then retry up to 4 more
  // times at 2s intervals if the balance/orders haven't updated yet (the RPC
  // node may lag the chain tip by 1-2 blocks). This is much faster than the
  // old polling approach (which waited 4s before even the first read) and does
  // not loop forever. The 30s background interval is a safety net only.

  const refreshUntilChanged = useCallback(
    async (_prevBalance: string, maxRetries = 5, retryMs = 2000) => {
      if (!address) return
      // Arc Testnet block time is ~1s but RPC nodes can lag the tip by 2-4 blocks.
      // Wait a fixed 1.5s before the first read so the settlement tx has time to
      // be indexed — avoids the "stale read returns old balance" false-negative that
      // caused the UI to show $20 after a profitable close.
      await new Promise((r) => setTimeout(r, 1500))

      for (let i = 0; i < maxRetries; i++) {
        try {
          // refreshDashboard: one multicall for balance + orders together
          const snap = await contract.refreshDashboard(address as `0x${string}`)
          setFreeBalance(snap.freeBalance)
          setActiveOrders(snap.activeOrders)
          return
        } catch {
          if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, retryMs))
        }
      }
    },
    [address, contract],
  )

  const runFundsTx = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>) => {
      setFundsTxState('pending')
      setFundsTxLabel(label)
      setFundsTxHash(null)
      setFundsTxError(null)
      try {
        const snapBalance = freeBalance
        const hash = await fn()
        setFundsTxHash(hash)
        setFundsTxState('confirmed')
        // Refresh the wallet USDC balance immediately — deposit/withdraw is
        // the only action that changes it, so we do it here rather than on a loop.
        void refreshWalletBalance()
        await refreshUntilChanged(snapBalance)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transaction failed'
        setFundsTxError(msg)
        setFundsTxState('error')
      }
    },
    [freeBalance, refreshUntilChanged, refreshWalletBalance],
  )

  const runTradeTx = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>) => {
      setTradeTxState('pending')
      setTradeTxLabel(label)
      setTradeTxHash(null)
      setTradeTxError(null)
      try {
        const snapBalance = freeBalance
        const hash = await fn()
        setTradeTxHash(hash)
        setTradeTxState('confirmed')
        // Refresh depth immediately after any trade action — the pending queue
        // changes when an order opens, closes, or cancels.
        void refreshDepth()
        await refreshUntilChanged(snapBalance)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transaction failed'
        setTradeTxError(msg)
        setTradeTxState('error')
      }
    },
    [freeBalance, refreshUntilChanged, refreshDepth],
  )

  const explorerBase = IS_MAINNET
    ? 'https://explorer.arc.io'
    : 'https://explorer.testnet.arc.io'

  if (!address) {
    return (
      <div className="flex items-center justify-center h-40 text-[var(--subtle)] text-sm">
        Register a passkey wallet to start trading
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Balance */}
      <div className="p-3 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)]">
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-xs text-[var(--subtle)] mb-0.5">Free Balance</p>
            <p className="display text-xl font-semibold tabular-nums">${freeBalance}</p>
          </div>
          <p className="text-xs text-[var(--subtle)]">Wallet: ${walletBalance}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border border-[var(--border)] rounded-xl overflow-hidden">
        {(['deposit', 'trade'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`flex-1 py-2 text-sm font-medium transition-colors capitalize ${
              activeTab === tab
                ? 'bg-[var(--surface-strong)] text-[var(--ink)]'
                : 'text-[var(--subtle)] hover:text-[var(--ink-2)]'
            }`}
          >
            {tab === 'deposit' ? 'Funds' : `Trade${activeOrders.length > 0 ? ` (${activeOrders.length})` : ''}`}
          </button>
        ))}
      </div>

      {/* ── Funds tab ──────────────────────────────────────────────────────── */}
      {activeTab === 'deposit' && (
        <div className="flex flex-col gap-3">
          <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-[var(--subtle)]">Deposit USDC</p>
              <button
                onClick={() => setDepositAmount(walletBalance)}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Max ${walletBalance}
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                className="flex-1 bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] mono focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => { void runFundsTx('Deposit', () => contract.deposit(depositAmount)) }}
                disabled={fundsTxState === 'pending' || !depositAmount || parseFloat(depositAmount) <= 0}
                className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-40 hover:bg-[var(--accent-hover)] transition-colors"
              >
                Deposit
              </button>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-[var(--subtle)]">Withdraw to wallet</p>
              <button
                onClick={() => setWithdrawAmount(freeBalance)}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                Max ${freeBalance}
              </button>
            </div>
            <p className="text-xs text-[var(--subtle)] mb-2 leading-relaxed">Moves USDC from your Free Balance back to your smart account wallet.</p>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                className="flex-1 bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] mono focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => { void runFundsTx('Withdraw', () => contract.withdraw(withdrawAmount)) }}
                disabled={fundsTxState === 'pending' || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
                className="px-4 py-2 rounded-lg bg-[var(--surface-strong)] border border-[var(--border)] text-[var(--ink-2)] text-sm font-medium disabled:opacity-40 hover:border-[var(--accent)] transition-colors"
              >
                Withdraw
              </button>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
            <p className="text-xs text-[var(--subtle)] mb-2">Send to external wallet</p>
            <p className="text-xs text-[var(--subtle)] mb-2 leading-relaxed">Send USDC from your smart account directly to MetaMask or any other address.</p>
            <input
              type="text"
              placeholder="Destination address (0x...)"
              value={sendAddress}
              onChange={(e) => setSendAddress(e.target.value)}
              className="w-full bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] mono focus:outline-none focus:border-[var(--accent)] mb-2"
            />
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                className="flex-1 bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] mono focus:outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => {
                  if (!sendAddress.startsWith('0x') || sendAddress.length !== 42) return
                  void runFundsTx('Send', () => contract.sendToAddress(sendAddress as `0x${string}`, sendAmount))
                }}
                disabled={
                  fundsTxState === 'pending' ||
                  !sendAmount || parseFloat(sendAmount) <= 0 ||
                  !sendAddress.startsWith('0x') || sendAddress.length !== 42
                }
                className="px-4 py-2 rounded-lg bg-[var(--surface-strong)] border border-[var(--border)] text-[var(--ink-2)] text-sm font-medium disabled:opacity-40 hover:border-[var(--accent)] transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Trade tab ──────────────────────────────────────────────────────── */}
      {activeTab === 'trade' && (
        <div className="flex flex-col gap-3">

          {/* Pair selector */}
          <div className="flex gap-2">
            {TRADING_PAIRS.map((pair) => (
              <button
                key={pair.id}
                onClick={() => onPairChange(pair.id)}
                className={`flex-1 py-2 rounded-xl border text-sm font-semibold mono transition-colors ${
                  selectedPair === pair.id
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--subtle)] hover:border-[var(--accent)]/50 hover:text-[var(--ink-2)]'
                }`}
              >
                {pair.symbol}
              </button>
            ))}
          </div>

          {/* Current leverage depth */}
          <div className="p-3 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)]">
            <p className="text-xs text-[var(--subtle)] mb-2 font-medium">
              {TRADING_PAIRS.find(p => p.id === selectedPair)?.label ?? 'Market'} — {leverage}x Depth
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 rounded-lg bg-[var(--success)]/5 border border-[var(--success)]/20 text-center">
                <p className="text-xs text-[var(--subtle)] mb-0.5">Long pending</p>
                <p className={`text-sm font-semibold mono tabular-nums ${parseFloat(currentDepth.pendingLong) > 0 ? 'text-[var(--success)]' : 'text-[var(--subtle)]'}`}>
                  {parseFloat(currentDepth.pendingLong) > 0 ? `$${currentDepth.pendingLong}` : '—'}
                </p>
              </div>
              <div className="p-2 rounded-lg bg-[var(--danger)]/5 border border-[var(--danger)]/20 text-center">
                <p className="text-xs text-[var(--subtle)] mb-0.5">Short pending</p>
                <p className={`text-sm font-semibold mono tabular-nums ${parseFloat(currentDepth.pendingShort) > 0 ? 'text-[var(--danger)]' : 'text-[var(--subtle)]'}`}>
                  {parseFloat(currentDepth.pendingShort) > 0 ? `$${currentDepth.pendingShort}` : '—'}
                </p>
              </div>
            </div>
          </div>

          {/* Market depth dashboard — all leverages */}
          <MarketDepthDashboard selectedPair={selectedPair} />

          {scanning && activeOrders.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-3 rounded-xl bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--subtle)]">
              <Loader2 size={13} className="animate-spin shrink-0" />
              Scanning orders…
            </div>
          )}

          {activeOrders.map(({ id, order }) => (
            <OrderCard
              key={id.toString()}
              id={id}
              order={order}
              livePnlUsdc={livePnlMap.get(id.toString()) ?? null}
              onClose={(oid) => void runTradeTx(`Close #${oid}`, () => contract.closeOrder(oid))}
              onCancel={(oid) => void runTradeTx(`Cancel #${oid}`, () => contract.cancelOrder(oid))}
              txPending={tradeTxState === 'pending'}
            />
          ))}

          {activeOrders.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-[var(--border)]" />
              <span className="text-xs text-[var(--subtle)]">Open another position</span>
              <div className="flex-1 h-px bg-[var(--border)]" />
            </div>
          )}

          {/* Open order form */}
          <div className="flex flex-col gap-3">
            {/* Direction */}
            <div className="flex gap-2">
              <button
                onClick={() => setIsLong(true)}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                  isLong
                    ? 'border-[var(--success)] bg-[var(--success)]/10 text-[var(--success)]'
                    : 'border-[var(--border)] text-[var(--subtle)] hover:border-[var(--success)]/50'
                }`}
              >
                <TrendingUp size={14} /> Long
              </button>
              <button
                onClick={() => setIsLong(false)}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                  !isLong
                    ? 'border-[var(--danger)] bg-[var(--danger)]/10 text-[var(--danger)]'
                    : 'border-[var(--border)] text-[var(--subtle)] hover:border-[var(--danger)]/50'
                }`}
              >
                <TrendingDown size={14} /> Short
              </button>
            </div>

            {/* Leverage slider */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-[var(--subtle)]">Leverage</p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setLeverage(l => Math.max(MIN_LEVERAGE, l - 1))}
                    className="w-6 h-6 flex items-center justify-center rounded border border-[var(--border)] text-[var(--subtle)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
                  ><ChevronDown size={12} /></button>
                  <input
                    type="number"
                    min={MIN_LEVERAGE}
                    max={MAX_LEVERAGE}
                    step={1}
                    value={leverage}
                    onChange={(e) => {
                      const v = Math.round(Number(e.target.value))
                      if (!isNaN(v)) setLeverage(Math.min(MAX_LEVERAGE, Math.max(MIN_LEVERAGE, v)))
                    }}
                    className="mono text-sm font-bold text-[var(--accent)] w-14 text-center tabular-nums bg-[var(--surface-muted)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span className="mono text-sm font-bold text-[var(--accent)]">x</span>
                  <button
                    onClick={() => setLeverage(l => Math.min(MAX_LEVERAGE, l + 1))}
                    className="w-6 h-6 flex items-center justify-center rounded border border-[var(--border)] text-[var(--subtle)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
                  ><ChevronUp size={12} /></button>
                </div>
              </div>
              <input
                type="range"
                min={MIN_LEVERAGE}
                max={MAX_LEVERAGE}
                step={1}
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--accent)] bg-[var(--border)]"
              />
              <div className="flex justify-between mt-1">
                {LEVERAGE_LABELS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setLeverage(p)}
                    className={`text-xs mono transition-colors ${
                      leverage === p ? 'text-[var(--accent)] font-semibold' : 'text-[var(--subtle)] hover:text-[var(--ink-2)]'
                    }`}
                  >
                    {p}x
                  </button>
                ))}
              </div>
            </div>

            {/* Collateral */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <p className="text-xs text-[var(--subtle)]">Collateral (USDC)</p>
                <button
                  onClick={() => setCollateral(freeBalance)}
                  className="text-xs text-[var(--accent)] hover:underline"
                >
                  Max ${freeBalance}
                </button>
              </div>
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={collateral}
                onChange={(e) => setCollateral(e.target.value)}
                className="w-full bg-[var(--surface-muted)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] mono focus:outline-none focus:border-[var(--accent)]"
              />
              {collateral && parseFloat(collateral) > 0 && (
                <p className="text-xs text-[var(--subtle)] mt-1">
                  Notional: {formatUSD(parseFloat(collateral) * leverage)} ·{' '}
                  <span className="text-yellow-400">
                    Will match against up to {formatUSD(parseFloat(collateral))} of {isLong ? 'Short' : 'Long'} orders
                  </span>
                </p>
              )}
            </div>

            {/* Market depth hint */}
            <div className="p-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-xs text-[var(--subtle)]">
              <span className="text-[var(--success)]">{currentDepth.pendingLong} USDC Long</span>
              {' '}·{' '}
              <span className="text-[var(--danger)]">{currentDepth.pendingShort} USDC Short</span>
              {' '}pending at {leverage}x —{' '}
              {isLong
                ? parseFloat(currentDepth.pendingShort) >= parseFloat(collateral || '0')
                  ? 'fills immediately'
                  : 'partially fills, remainder stays pending'
                : parseFloat(currentDepth.pendingLong) >= parseFloat(collateral || '0')
                  ? 'fills immediately'
                  : 'partially fills, remainder stays pending'}
            </div>

            <button
              onClick={() => { void runTradeTx(
                `Open ${TRADING_PAIRS.find(p => p.id === selectedPair)?.symbol ?? ''} ${isLong ? 'Long' : 'Short'} ${leverage}x`,
                () => contract.openOrder(isLong, leverage, collateral, selectedPair),
              ) }}
              disabled={
                tradeTxState === 'pending' ||
                !collateral ||
                parseFloat(collateral) <= 0 ||
                parseFloat(collateral) > parseFloat(freeBalance)
              }
              className={`w-full py-3 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 ${
                isLong
                  ? 'bg-[var(--success)] hover:bg-[var(--success)]/90 text-white'
                  : 'bg-[var(--danger)] hover:bg-[var(--danger)]/90 text-white'
              }`}
            >
              {tradeTxState === 'pending' && tradeTxLabel.startsWith('Open')
                ? 'Submitting…'
                : `Open ${TRADING_PAIRS.find(p => p.id === selectedPair)?.symbol ?? ''} ${isLong ? 'Long' : 'Short'} ${leverage}x`}
            </button>
          </div>
        </div>
      )}

      {/* ── Funds tx status (only visible on Funds tab) ─────────────────── */}
      {activeTab === 'deposit' && (
        <>
          {fundsTxState === 'pending' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--muted)]">
              <Loader2 size={14} className="animate-spin" />
              {fundsTxLabel}… (gasless)
            </div>
          )}
          {fundsTxState === 'confirmed' && fundsTxHash && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-sm text-[var(--success)]">
              <CheckCircle2 size={14} />
              {fundsTxLabel} confirmed ·{' '}
              <a
                href={`${explorerBase}/tx/${fundsTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline truncate max-w-[160px]"
              >
                {fundsTxHash.slice(0, 10)}…
              </a>
            </div>
          )}
          {fundsTxState === 'error' && fundsTxError && (
            <CollapsibleError message={fundsTxError} />
          )}
        </>
      )}

      {/* ── Trade tx status (only visible on Trade tab) ──────────────────── */}
      {activeTab === 'trade' && (
        <>
          {tradeTxState === 'pending' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--muted)]">
              <Loader2 size={14} className="animate-spin" />
              {tradeTxLabel}… (gasless)
            </div>
          )}
          {tradeTxState === 'confirmed' && tradeTxHash && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-sm text-[var(--success)]">
              <CheckCircle2 size={14} />
              {tradeTxLabel} confirmed ·{' '}
              <a
                href={`${explorerBase}/tx/${tradeTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline truncate max-w-[160px]"
              >
                {tradeTxHash.slice(0, 10)}…
              </a>
            </div>
          )}
          {tradeTxState === 'error' && tradeTxError && (
            <CollapsibleError message={tradeTxError} />
          )}
        </>
      )}
    </div>
  )
}
