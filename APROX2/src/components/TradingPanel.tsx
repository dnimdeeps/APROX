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

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  TrendingUp, TrendingDown, Clock, Zap, X, Loader2, CheckCircle2,
  AlertTriangle, ChevronUp, ChevronDown, BarChart2,
} from 'lucide-react'
import type { UseModularWalletReturn } from '@/hooks/useModularWallet'
import { useAproxContract, OrderStatus, TRADING_PAIRS } from '@/hooks/useAproxContract'
import type { Order, MarketDepth } from '@/hooks/useAproxContract'
import type { Hex } from 'viem'
import type { UsePriceFeedReturn } from '@/hooks/usePriceFeed'

interface TradingPanelProps {
  wallet: UseModularWalletReturn
  feed: UsePriceFeedReturn
  selectedPair: Hex
  onPairChange: (pair: Hex) => void
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
  price8: number | null
  onClose: (id: bigint) => void
  onCancel: (id: bigint) => void
  txPending: boolean
}

function OrderCard({ id, order, price8, onClose, onCancel, txPending }: OrderCardProps) {
  const [age, setAge] = useState(() => formatAge(order.openedAt))

  useEffect(() => {
    const tick = () => setAge(formatAge(order.openedAt))
    tick()
    const i = setInterval(tick, 1000)
    return () => clearInterval(i)
  }, [order.openedAt])

  // Live PnL — computed from matched collateral and entry price
  let livePnl = 0
  if (order.matchedCollateral > 0n && price8 && order.entryPrice > 0n) {
    const entry = Number(order.entryPrice)
    const current = price8
    const collateral = Number(order.matchedCollateral) / 1e6
    const delta = (current - entry) / entry
    livePnl = (order.isLong ? 1 : -1) * delta * collateral * order.leverage
  }

  const pnlPositive = livePnl >= 0
  const matchedUsd = (Number(order.matchedCollateral) / 1e6).toFixed(2)
  const pendingUsd = (Number(order.pendingCollateral) / 1e6).toFixed(2)
  const entryUsd = order.entryPrice > 0n ? (Number(order.entryPrice) / 1e8).toFixed(2) : null

  const liqPrice = entryUsd && order.entryPrice > 0n
    ? (() => {
        const entry = Number(order.entryPrice) / 1e8
        const factor = 0.8 / order.leverage
        return order.isLong ? entry * (1 - factor) : entry * (1 + factor)
      })()
    : null

  // An order is effectively active (showing PnL) when it has matched collateral,
  // regardless of whether some pending remainder still exists.
  const hasActiveComponent = order.matchedCollateral > 0n
  const hasPendingComponent = order.pendingCollateral > 0n
  const displayStatus = hasActiveComponent ? OrderStatus.ACTIVE : order.status

  return (
    <div className={`p-4 rounded-xl border ${
      hasActiveComponent
        ? 'border-[var(--success)]/30 bg-[var(--success)]/5'
        : 'border-yellow-500/30 bg-yellow-500/5'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {order.isLong
            ? <TrendingUp size={14} className="text-[var(--success)]" />
            : <TrendingDown size={14} className="text-[var(--danger)]" />}
          <span className="text-sm font-semibold text-[var(--ink)]">
            BTC {order.isLong ? 'Long' : 'Short'} {order.leverage}x
          </span>
          <span className={`text-xs font-medium flex items-center gap-1 ${STATUS_COLOR[displayStatus]}`}>
            {hasActiveComponent ? <Zap size={10} /> : <Clock size={10} />}
            {STATUS_LABEL[displayStatus]}
            {hasActiveComponent && hasPendingComponent && (
              <span className="text-yellow-400 ml-1">+ pending</span>
            )}
          </span>
        </div>
        <span className="text-xs text-[var(--subtle)] mono">#{id.toString()}</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div>
          <p className="text-[var(--subtle)]">Matched</p>
          <p className="mono text-[var(--ink)]">${matchedUsd}</p>
        </div>
        {hasPendingComponent && (
          <div>
            <p className="text-[var(--subtle)]">Pending</p>
            <p className="mono text-yellow-400">${pendingUsd}</p>
          </div>
        )}
        {entryUsd && (
          <div>
            <p className="text-[var(--subtle)]">Entry</p>
            <p className="mono text-[var(--ink)]">${parseFloat(entryUsd).toLocaleString()}</p>
          </div>
        )}
        {liqPrice && (
          <div>
            <p className="text-[var(--subtle)]">Liq. Price</p>
            <p className="mono text-[var(--danger)]">${liqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
        )}
        <div>
          <p className="text-[var(--subtle)]">Age</p>
          <p className="mono text-[var(--ink)]">{age}</p>
        </div>
      </div>

      {/* Live PnL */}
      {hasActiveComponent && (
        <div className={`p-2 rounded-lg mb-3 text-center ${
          pnlPositive ? 'bg-[var(--success)]/10' : 'bg-[var(--danger)]/10'
        }`}>
          <p className="text-xs text-[var(--subtle)] mb-0.5">Live PnL</p>
          <p className={`display text-lg font-semibold tabular-nums ${
            pnlPositive ? 'text-[var(--success)]' : 'text-[var(--danger)]'
          }`}>
            {pnlPositive ? '+' : ''}{livePnl.toFixed(4)} USDC
          </p>
        </div>
      )}

      {/* Pending-only hint */}
      {!hasActiveComponent && hasPendingComponent && (
        <div className="flex items-start gap-2 p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 mb-3">
          <Clock size={12} className="text-yellow-400 mt-0.5 shrink-0" />
          <p className="text-xs text-yellow-300">
            Waiting for a counterpart {order.isLong ? 'Short' : 'Long'} order to match.
            Your collateral is locked and safe. Cancel to get it back.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {hasActiveComponent && (
          <button
            onClick={() => onClose(id)}
            disabled={txPending}
            className="flex-1 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-40 hover:bg-[var(--accent-hover)] transition-colors"
          >
            Close Position
          </button>
        )}
        {hasPendingComponent && (
          <button
            onClick={() => onCancel(id)}
            disabled={txPending}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-[var(--subtle)] text-sm font-medium disabled:opacity-40 hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors"
          >
            <X size={13} />
            Cancel Pending
          </button>
        )}
      </div>
    </div>
  )
}

// ── Market Depth Dashboard ───────────────────────────────────────────────────

interface DepthRow {
  leverage: number
  pendingLong: number
  pendingShort: number
}

interface MarketDepthDashboardProps {
  contract: ReturnType<typeof useAproxContract>
  selectedPair: Hex
}

function MarketDepthDashboard({ contract, selectedPair }: MarketDepthDashboardProps) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<DepthRow[]>([])
  const [loading, setLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState<Hex | null>(null)

  const fetchDepth = useCallback(async () => {
    setLoading(true)
    const found: DepthRow[] = []
    try {
      // Sequential scan with a small delay — 100 parallel calls will 429 the RPC.
      // Batching in groups of 5 with a 120ms pause between batches keeps well under
      // the rate limit while still completing the full scan in ~2-3 seconds.
      const BATCH = 5
      const PAUSE_MS = 120
      for (let start = 0; start < ALL_LEVERAGES.length; start += BATCH) {
        const batch = ALL_LEVERAGES.slice(start, start + BATCH)
        const results = await Promise.all(
          batch.map(async (lev) => {
            try {
              const d = await contract.getMarketDepth(lev)
              return {
                leverage: lev,
                pendingLong: parseFloat(d.pendingLong),
                pendingShort: parseFloat(d.pendingShort),
              }
            } catch {
              return { leverage: lev, pendingLong: 0, pendingShort: 0 }
            }
          })
        )
        for (const r of results) {
          if (r.pendingLong > 0 || r.pendingShort > 0) found.push(r)
        }
        // Update incrementally so the user sees results as they arrive
        setRows([...found])
        if (start + BATCH < ALL_LEVERAGES.length) {
          await new Promise(res => setTimeout(res, PAUSE_MS))
        }
      }
      setLastFetched(selectedPair)
    } finally {
      setLoading(false)
    }
  }, [contract, selectedPair])

  useEffect(() => {
    if (open && lastFetched !== selectedPair) void fetchDepth()
  }, [open, lastFetched, selectedPair, fetchDepth])

  const totalLong = rows.reduce((s, r) => s + r.pendingLong, 0)
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
            <p className="text-xs text-[var(--subtle)]">
              Only leverages with pending volume shown.
            </p>
            <button
              onClick={() => void fetchDepth()}
              disabled={loading}
              className="text-xs text-[var(--accent)] hover:underline disabled:opacity-40"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {loading && rows.length === 0 && (
            <div className="flex items-center gap-2 py-4 text-sm text-[var(--subtle)]">
              <Loader2 size={13} className="animate-spin" />
              Scanning all 100 leverage levels…
            </div>
          )}

          {!loading && rows.length === 0 && (
            <p className="text-xs text-[var(--subtle)] py-3">No pending orders at any leverage level.</p>
          )}

          {rows.length > 0 && (
            <>
              {/* Summary */}
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

              {/* Per-leverage breakdown */}
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

export function TradingPanel({ wallet, feed, selectedPair, onPairChange }: TradingPanelProps) {
  const contract = useAproxContract(wallet)
  const { address } = wallet
  const { price8 } = feed

  const [freeBalance, setFreeBalance] = useState<string>('0.00')
  const [walletBalance, setWalletBalance] = useState<string>('0.00')
  const [activeOrders, setActiveOrders] = useState<Array<{ id: bigint; order: Order }>>([])
  const [scanning, setScanning] = useState(false)
  const [currentDepth, setCurrentDepth] = useState<MarketDepth>({ pendingLong: '0.00', pendingShort: '0.00' })
  const scanAddressRef = useRef<string | null>(null)
  const hasOrdersRef = useRef(false)
  const initialLoadDoneRef = useRef(false)

  // Form state
  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [sendAmount, setSendAmount] = useState('')
  const [sendAddress, setSendAddress] = useState('')
  const [collateral, setCollateral] = useState('')
  const [leverage, setLeverage] = useState<number>(10)
  const [isLong, setIsLong] = useState(true)
  const [activeTab, setActiveTab] = useState<'deposit' | 'trade'>('deposit')

  // Tx state
  const [txState, setTxState] = useState<TxState>('idle')
  const [txLabel, setTxLabel] = useState('')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [txError, setTxError] = useState<string | null>(null)

  const leverageRef = useRef<number>(leverage)
  useEffect(() => { leverageRef.current = leverage }, [leverage])
  const selectedPairRef = useRef<Hex>(selectedPair)
  useEffect(() => { selectedPairRef.current = selectedPair }, [selectedPair])

  // ── Full state reset on account switch ──────────────────────────────────

  useEffect(() => {
    setFreeBalance('0.00')
    setWalletBalance('0.00')
    setActiveOrders([])
    setScanning(false)
    setCurrentDepth({ pendingLong: '0.00', pendingShort: '0.00' })
    setTxState('idle')
    setTxLabel('')
    setTxHash(null)
    setTxError(null)
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

    try {
      const bal = await contract.getFreeBalance(address as `0x${string}`)
      if (scanAddressRef.current !== thisAddress) return
      setFreeBalance(bal)
    } catch (err) {
      console.error('[TradingPanel] getFreeBalance failed:', err instanceof Error ? err.message : err)
    }

    try {
      const wbal = await contract.getWalletUsdcBalance(address as `0x${string}`)
      if (scanAddressRef.current !== thisAddress) return
      setWalletBalance(wbal)
    } catch {
      // Non-critical
    }

    try {
      const d = await contract.getMarketDepth(leverageRef.current)
      if (scanAddressRef.current !== thisAddress) return
      setCurrentDepth(d)
    } catch {
      // Non-critical
    }

    try {
      if (isFirstLoad && !initialLoadDoneRef.current) setScanning(true)
      const orders = await contract.getActiveOrders(address as `0x${string}`)
      if (scanAddressRef.current !== thisAddress) return
      hasOrdersRef.current = orders.length > 0
      initialLoadDoneRef.current = true
      setActiveOrders(orders)
    } catch (err) {
      console.error('[TradingPanel] getActiveOrders failed:', err instanceof Error ? err.message : err)
    } finally {
      if (scanAddressRef.current === address) setScanning(false)
    }
  }, [address, contract])

  useEffect(() => {
    if (!address) return
    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [address, refresh])

  useEffect(() => {
    if (!address) return
    const timer = setTimeout(() => {
      contract.getMarketDepth(leverage).then(setCurrentDepth).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [leverage, selectedPair, address, contract])

  // ── Tx helper ────────────────────────────────────────────────────────────

  const pollUntilBalanceChanges = useCallback(
    async (prevBalance: string, maxAttempts = 8, intervalMs = 1200) => {
      if (!address) return
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, intervalMs))
        try {
          const fresh = await contract.getFreeBalance(address as `0x${string}`)
          if (fresh !== prevBalance) {
            setFreeBalance(fresh)
            await refresh()
            return
          }
        } catch {
          // ignore transient errors, keep retrying
        }
      }
      await refresh()
    },
    [address, contract, refresh],
  )

  const runTx = useCallback(
    async (label: string, fn: () => Promise<`0x${string}`>) => {
      setTxState('pending')
      setTxLabel(label)
      setTxHash(null)
      setTxError(null)
      try {
        const snapBalance = freeBalance
        const hash = await fn()
        setTxHash(hash)
        setTxState('confirmed')
        await pollUntilBalanceChanges(snapBalance)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Transaction failed'
        setTxError(msg)
        setTxState('error')
      }
    },
    [refresh, freeBalance, pollUntilBalanceChanges],
  )

  const explorerBase = import.meta.env.VITE_NETWORK === 'mainnet'
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
            onClick={() => setActiveTab(tab)}
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
            <p className="text-xs text-[var(--subtle)] mb-2">Deposit USDC</p>
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
                onClick={() => { void runTx('Deposit', () => contract.deposit(depositAmount)) }}
                disabled={txState === 'pending' || !depositAmount || parseFloat(depositAmount) <= 0}
                className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-40 hover:bg-[var(--accent-hover)] transition-colors"
              >
                Deposit
              </button>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-[var(--surface)] border border-[var(--border)]">
            <p className="text-xs text-[var(--subtle)] mb-2">Withdraw to wallet</p>
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
                onClick={() => { void runTx('Withdraw', () => contract.withdraw(withdrawAmount)) }}
                disabled={txState === 'pending' || !withdrawAmount || parseFloat(withdrawAmount) <= 0}
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
                  void runTx('Send', () => contract.sendToAddress(sendAddress as `0x${string}`, sendAmount))
                }}
                disabled={
                  txState === 'pending' ||
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
          <MarketDepthDashboard contract={contract} selectedPair={selectedPair} />

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
              price8={price8}
              onClose={(oid) => void runTx(`Close #${oid}`, () => contract.closeOrder(oid))}
              onCancel={(oid) => void runTx(`Cancel #${oid}`, () => contract.cancelOrder(oid))}
              txPending={txState === 'pending'}
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
              onClick={() => { void runTx(
                `Open ${TRADING_PAIRS.find(p => p.id === selectedPair)?.symbol ?? ''} ${isLong ? 'Long' : 'Short'} ${leverage}x`,
                () => contract.openOrder(isLong, leverage, collateral),
              ) }}
              disabled={
                txState === 'pending' ||
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
              {txState === 'pending' && txLabel.startsWith('Open')
                ? 'Submitting…'
                : `Open ${TRADING_PAIRS.find(p => p.id === selectedPair)?.symbol ?? ''} ${isLong ? 'Long' : 'Short'} ${leverage}x`}
            </button>
          </div>
        </div>
      )}

      {/* ── Tx status ──────────────────────────────────────────────────────── */}
      {txState === 'pending' && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-muted)] border border-[var(--border)] text-sm text-[var(--muted)]">
          <Loader2 size={14} className="animate-spin" />
          {txLabel}… (gasless)
        </div>
      )}
      {txState === 'confirmed' && txHash && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/30 text-sm text-[var(--success)]">
          <CheckCircle2 size={14} />
          {txLabel} confirmed ·{' '}
          <a
            href={`${explorerBase}/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline truncate max-w-[160px]"
          >
            {txHash.slice(0, 10)}…
          </a>
        </div>
      )}
      {txState === 'error' && txError && (
        <CollapsibleError message={txError} />
      )}
    </div>
  )
}
