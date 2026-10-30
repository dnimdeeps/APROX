/**
 * Aprox — Peer-to-Peer BTC/USD Perpetuals on Arc
 * Gasless trading via Circle Modular Wallets (ERC-4337 passkeys + Gas Station)
 */

import { useState, useEffect, useRef } from 'react'
import { useModularWallet } from '@/hooks/useModularWallet'
import { usePriceFeed } from '@/hooks/usePriceFeed'
import { useOraclePrice } from '@/hooks/useOraclePrice'
import { WalletGate } from '@/components/WalletGate'
import { PriceBar } from '@/components/PriceBar'
import { TradingPanel } from '@/components/TradingPanel'
import { LiveFeed } from '@/components/LiveFeed'
import { Leaderboard } from '@/components/Leaderboard'
import { TraderProfile } from '@/components/TraderProfile'
import { MarketDepth } from '@/components/MarketDepth'
import { MyHistory } from '@/components/MyHistory'
import { PAIR_BTC_USD, TRADING_PAIRS } from '@/hooks/useAproxContract'
import { IS_MAINNET, NETWORK, switchNetwork } from '@/network'
import { publicClient } from '@/hooks/useModularWallet'
import type { Hex } from 'viem'
import { parseAbi } from 'viem'
import {
  ChevronDown, ChevronUp, AlertTriangle, KeyRound, Coins,
  TrendingUp, LogIn, Droplets, ArrowLeftRight,
} from 'lucide-react'

// ── Page type ─────────────────────────────────────────────────────────────────
type Page = 'trade' | 'feed' | 'leaderboard' | 'profile' | 'history'

// ── Perp address for stats polling ───────────────────────────────────────────
const PERP_ADDRESS = (IS_MAINNET
  ? (import.meta.env.VITE_MAINNET_APROX_PERP_ADDRESS ?? '')
  : (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '')) as Hex

const STATS_ABI = parseAbi([
  'function getStats(address trader) external view returns ((uint256 totalMatches, uint256 totalWins, uint256 totalLosses, uint256 totalVolume, uint256 winStreak, uint256 bestStreak))',
])

// ── How to Use panel ─────────────────────────────────────────────────────────

const STEPS = [
  {
    icon: AlertTriangle,
    color: 'text-yellow-400',
    title: 'Use Chrome, Firefox, or Safari',
    body: 'Brave and browsers with aggressive ad-blockers block the Circle wallet SDK. If the app feels unresponsive or the balance never loads, open it in a clean Chrome/Firefox window or in incognito mode (which disables most extensions).',
  },
  {
    icon: KeyRound,
    color: 'text-[var(--accent)]',
    title: 'Register a passkey wallet',
    body: 'Click "Register" in the top-right, enter any username, and approve the biometric prompt (Face ID, fingerprint, or security key). This creates a gasless ERC-4337 smart account — no seed phrase, no gas fees.',
  },
  {
    icon: Coins,
    color: 'text-[var(--success)]',
    title: 'Deposit USDC',
    body: 'Go to the Funds tab, enter an amount, and click Deposit. The transaction is gasless — Circle Gas Station pays the fee. Your Free Balance updates within a few seconds once the block is confirmed.',
  },
  {
    icon: TrendingUp,
    color: 'text-[var(--accent)]',
    title: 'Open a position',
    body: 'Switch to the Trade tab. Pick Long or Short, choose 2x / 5x / 10x leverage, enter collateral, and submit. Your order goes into a peer-to-peer queue and matches against the opposite side automatically.',
  },
  {
    icon: LogIn,
    color: 'text-[var(--subtle)]',
    title: 'Returning? Log in',
    body: 'Click "Login" and approve the biometric prompt. Your passkey is bound to this domain — if the URL changes your passkey won\'t work, so bookmark the exact address.',
  },
]

function HowToUse() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mx-4 mt-3 rounded-xl border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface)' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors"
      >
        <span className="display font-semibold">How to use Aprox</span>
        {open ? <ChevronUp size={15} className="text-[var(--subtle)]" /> : <ChevronDown size={15} className="text-[var(--subtle)]" />}
      </button>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--subtle)] pt-3">
            {IS_MAINNET
              ? 'Aprox runs on Arc Mainnet — real USDC, real money.'
              : 'Aprox runs on Arc Testnet — all funds are test USDC, nothing is real money.'}
          </p>
          {STEPS.map(({ icon: Icon, color, title, body }) => (
            <div key={title} className="flex gap-3">
              <div className={`mt-0.5 shrink-0 ${color}`}>
                <Icon size={15} />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--ink)] mb-0.5">{title}</p>
                <p className="text-xs text-[var(--subtle)] leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Nav tab ───────────────────────────────────────────────────────────────────
function NavTab({ page, current, label, onClick }: {
  page: Page; current: Page; label: string; onClick: () => void
}) {
  const active = page === current
  return (
    <button
      onClick={onClick}
      className="relative px-3 py-2 text-xs font-medium transition-colors"
      style={{ color: active ? 'var(--accent)' : 'var(--subtle)' }}
    >
      {label}
      {active && (
        <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
          style={{ background: 'var(--accent)' }} />
      )}
    </button>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const wallet = useModularWallet()
  const feed = usePriceFeed()
  const oracle = useOraclePrice()
  const [selectedPair, setSelectedPair] = useState<Hex>(PAIR_BTC_USD)
  const activePairLabel = TRADING_PAIRS.find(p => p.id === selectedPair)?.label ?? 'BTC/USD'
  const [activeTab, setActiveTab] = useState<'deposit' | 'trade'>('deposit')
  const [page, setPage] = useState<Page>('trade')
  const [profileAddr, setProfileAddr] = useState<Hex | null>(null)
  const [winStreak, setWinStreak] = useState(0)
  const [lastTradePnl, setLastTradePnl] = useState<number | null>(null)
  const prevWinsRef = useRef<bigint | null>(null)
  const prevLossesRef = useRef<bigint | null>(null)

  // Poll getStats every 15s to get live win streak and detect last trade result
  useEffect(() => {
    if (!wallet.address || !PERP_ADDRESS) return
    let cancelled = false

    async function pollStats() {
      if (cancelled || !wallet.address) return
      try {
        const stats = await publicClient.readContract({
          address: PERP_ADDRESS,
          abi: STATS_ABI,
          functionName: 'getStats',
          args: [wallet.address as Hex],
        }) as { totalMatches: bigint; totalWins: bigint; totalLosses: bigint; totalVolume: bigint; winStreak: bigint; bestStreak: bigint }

        if (!cancelled) {
          setWinStreak(Number(stats.winStreak))

          // Detect a new closed trade and flash the result
          const wins = stats.totalWins
          const losses = stats.totalLosses
          if (prevWinsRef.current !== null && wins > prevWinsRef.current) {
            // A win happened — flash positive (we don't have the exact PnL here, show +)
            setLastTradePnl(0.01) // triggers flash as positive; actual PnL from history
          } else if (prevLossesRef.current !== null && losses > prevLossesRef.current) {
            setLastTradePnl(-0.01) // triggers flash as negative
          }
          prevWinsRef.current = wins
          prevLossesRef.current = losses
        }
      } catch { /* silent */ }
    }

    void pollStats()
    const timer = setInterval(() => { void pollStats() }, 15_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [wallet.address])

  function openProfile(addr: Hex) {
    setProfileAddr(addr)
    setPage('profile')
  }

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: 'var(--bg-gradient)' }}
    >
      {/* Header */}
      <header
        className="sticky top-0 z-20 px-4 py-3 border-b border-[var(--border)] flex items-center justify-between gap-2"
        style={{ background: 'rgba(10, 22, 40, 0.94)', backdropFilter: 'blur(14px)' }}
      >
        {/* Left: logo + network toggle */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="display text-lg font-bold tracking-tight" style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>APROX</span>

          {/* Network toggle */}
          <button
            onClick={() => switchNetwork(IS_MAINNET ? 'testnet' : 'mainnet')}
            title={`Switch to ${IS_MAINNET ? 'Arc Testnet' : 'Arc Mainnet'}`}
            className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors hover:opacity-80 ${
              IS_MAINNET
                ? 'border-[var(--success)]/40 text-[var(--success)] hover:bg-[var(--success)]/10'
                : 'border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/10'
            }`}
          >
            {NETWORK === 'mainnet' ? 'Arc Mainnet' : 'Arc Testnet'}
            <ArrowLeftRight size={10} className="opacity-60" />
          </button>

          {/* Faucet — testnet only */}
          {!IS_MAINNET && wallet.address && (
            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noopener noreferrer"
              title="Get test USDC from Circle Faucet"
              className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-[var(--success)]/30 text-[var(--success)] hover:bg-[var(--success)]/10 transition-colors"
            >
              <Droplets size={10} />
              Faucet
            </a>
          )}
        </div>

        <WalletGate wallet={wallet} winStreak={winStreak} lastTradePnl={lastTradePnl} />
      </header>

      {/* Global nav */}
      <nav className="sticky top-[53px] z-10 px-4 py-2 flex items-center gap-1 border-b border-[var(--border)]"
        style={{ background: 'rgba(13, 27, 47, 0.88)', backdropFilter: 'blur(8px)' }}>
        <NavTab page="trade"       current={page} label="Trade"       onClick={() => setPage('trade')} />
        <NavTab page="leaderboard" current={page} label="Leaderboard" onClick={() => setPage('leaderboard')} />
        <NavTab page="feed"        current={page} label="Live Feed"   onClick={() => setPage('feed')} />
        {wallet.address && (
          <NavTab page="history" current={page} label="My History" onClick={() => setPage('history')} />
        )}
        {wallet.address && (
          <NavTab page="profile" current={page} label="My Profile"
            onClick={() => { setProfileAddr(wallet.address as Hex); setPage('profile') }} />
        )}
      </nav>

      {/* Price bar — only on trade page */}
      {wallet.address && page === 'trade' && (
        <div
          className="mx-4 mt-4 px-4 py-3 rounded-xl border border-[var(--border)]"
          style={{ background: 'var(--surface)' }}
        >
          <PriceBar feed={feed} oracle={oracle} pairLabel={activePairLabel} />
        </div>
      )}

      {/* How to use — only when not connected on trade page */}
      {!wallet.address && page === 'trade' && <HowToUse />}

      {/* Main content */}
      <main className="p-4 max-w-2xl mx-auto">
        {/* Trade page */}
        {page === 'trade' && (
          <div className="flex flex-col gap-4">
            <div
              className="rounded-xl border border-[var(--border)] p-4"
              style={{ background: 'var(--surface)' }}
            >
              <h2 className="display text-base font-semibold text-[var(--ink-2)] mb-4">
                {activePairLabel} Perpetuals
              </h2>
              <TradingPanel
                wallet={wallet}
                feed={feed}
                oracle={oracle}
                selectedPair={selectedPair}
                onPairChange={setSelectedPair}
                activeTab={activeTab}
                onTabChange={setActiveTab}
              />
            </div>
            <MarketDepth defaultPair={activePairLabel as 'BTC/USD' | 'ETH/USD' | 'SOL/USD'} />
          </div>
        )}

        {/* Leaderboard page */}
        {page === 'leaderboard' && (
          <Leaderboard
            onSelectTrader={openProfile}
            myAddress={wallet.address as Hex | null}
          />
        )}

        {/* Live feed page */}
        {page === 'feed' && <LiveFeed />}

        {/* My History page */}
        {page === 'history' && <MyHistory address={wallet.address} />}

        {/* Profile page */}
        {page === 'profile' && profileAddr && (
          <div
            className="rounded-xl border border-[var(--border)] p-4"
            style={{ background: 'var(--surface)' }}
          >
            <TraderProfile
              address={profileAddr}
              myAddress={wallet.address as Hex | null}
              onBack={() => setPage('leaderboard')}
            />
          </div>
        )}
        {page === 'profile' && !profileAddr && (
          <div className="py-12 text-center text-sm text-[var(--subtle)]">
            Connect a wallet to view your profile.
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="px-4 py-6 text-center text-xs text-[var(--subtle)]">
        Aprox · P2P Perpetuals · {IS_MAINNET ? 'Arc Mainnet' : 'Arc Testnet'} · Circle Modular Wallets
      </footer>
    </div>
  )
}
