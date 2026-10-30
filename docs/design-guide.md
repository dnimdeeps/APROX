# APROX — UI/UX Design Guide

## The Design Premise

Aprox is a duel protocol. Two traders put real USDC against each other and price decides who wins. The visual language should make that feel like what it is: precise, tense, and consequential. Not a game. Not a trading terminal. A duel.

The one word that should describe every design decision: **stark**.

---

## Color System

One background. One surface. One accent. Two signal colors. Nothing else.

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#0a1628` | Page background |
| `--surface` | `rgba(255,255,255,0.05)` | Cards and panels |
| `--surface-strong` | `rgba(255,255,255,0.09)` | Elevated surfaces |
| `--surface-muted` | `#1a2a3e` | Input backgrounds |
| `--ink` | `#f0f4f8` | Primary text |
| `--ink-2` | `#d8e4f0` | Secondary text |
| `--subtle` | `#4a6080` | Metadata, labels |
| `--border` | `rgba(255,255,255,0.10)` | Borders |
| `--border-strong` | `rgba(200,216,240,0.45)` | Focused borders |
| `--accent` | `#c8d8f0` | Interactive, active states |
| `--accent-hover` | `#dce8f8` | Hover states |
| `--success` | `#00e676` | Winning, positive PnL |
| `--danger` | `#ff3d57` | Losing, liquidation risk |

**Rule:** Color is information. If something is colored and it is not green, red, or accent, it should not be colored. Every colored pixel answers the question: am I winning or losing?

---

## Typography

Three roles, three faces, used strictly.

| Role | Font | Usage |
|---|---|---|
| Display | Space Grotesk, bold, -0.04em | Wordmark, large PnL, match headlines, leaderboard ranks |
| Body | DM Sans, regular | Labels, instructions, UI copy — never for numbers |
| Data | JetBrains Mono | Every number: prices, balances, PnL, percentages, addresses |

**All numbers are monospace, always.** Proportional numbers shift width as they change and create visual noise in live data.

**Size scale:**
- `10px` — metadata, timestamps
- `12px` — secondary labels, card metadata
- `14px` — primary body text, inputs
- `20px` — card-level data (collateral, entry price)
- `32px` — live PnL on active match
- `48px+` — the liquidation moment only

---

## The Match Card

The most important component. Everything else is peripheral.

**Structure top to bottom:**

1. **Header** — `BTC/USD LONG 10×` in Display. Direction in signal color (green long, red short).
2. **Status chip** — `MATCHED` / `PENDING` / `CLOSED`. Monospace small caps, colored dot.
3. **The Bar** — vertical columns, central. Left = you, right = opponent. See Bar spec below.
4. **Live PnL** — `+$3.42` in Display 32px. Sign + value. Green or red. Updates in place — no animation on the number, just the value changing. Stillness makes change more visible.
5. **Secondary row** — entry price, liq price, age, matched amount. Monospace 12px.
6. **Action buttons** — Close, Cancel. Danger-colored on hover only. Right-aligned.

**Card border:** flat `rgba(255,255,255,0.05)` background. When winning: `2px solid rgba(0,230,118,0.4)` left border. When losing: `2px solid rgba(255,61,87,0.4)`. The border is the only card-level color signal — no background tints.

---

## The Bar Spec

**Orientation:** vertical. Two columns side by side, `4px` gap.

**Container height:** `160px`. Baseline at `80px` from bottom (exact midpoint = entry/50:50 state).

**Your bar (left):**
- Dark green `#1a6b3c` — original stake layer (fixed height = your initial collateral mapped to px scale)
- Bright green `#00c853` — live profit from current match PnL (grows in real time)
- Teal `#69f0ae` — re-match winnings carried from prior liquidations ("house money")

Layers stack bottom to top. Original stake is fixed; profit and re-match winnings add on top.

**Opponent bar (right):**
- Dark red `#8b1a2a` — their equity
- Horizontal tick at 20% of their starting height = liquidation threshold
- When near liquidation (< 25% remaining): opacity pulses `0.85 → 1.0` at 2s period

**The liquidation moment:**
1. Their bar collapses to `0px` over `400ms` ease-out
2. `200ms` white flash fills their column
3. Silence. Your bar holds.
4. Re-match: new opponent column materializes from `0` to their height over `300ms`. Teal layer visible on your bar.

**No grid lines. No axis labels on the bar.** Numbers live in the secondary data row.

---

## Motion Principles

1. **Motion communicates state change, never decoration.** The bar moves because PnL moved.
2. **Fast in, slow out.** `0ms` delay, `300–500ms` ease-out. Responsive but resolved.
3. **One thing moves at a time.** Bar updating = feed holds. Feed updating = bar holds.

Exception: opponent bar pulse near liquidation (ambient, 2s, does not compete with live updates).

---

## Navigation

**Header:** logo left, network badge, faucet (testnet only). Right: wallet state. No nav in header.

**Tab strip:** below header. Four items max: Trade, Leaderboard, Live Feed, Profile. Text only, no icons in tabs. Active: accent color + 2px bottom border. Inactive: subtle color.

**Page layout:** single column, max-width `600px`, centered. `16px` horizontal padding. Never two columns.

---

## Leaderboard

- Rank numbers in Display, large, left-aligned, zero-padded: `01`, `02`, `03`
- Win rate is headline stat — large percentage next to rank
- Streak shown as `12 streak` — hidden when 0 (silence > zero)
- Your row: accent left-border regardless of rank
- Click row → trader profile (full page, no modal)

---

## Live Feed

One line per event: `[time ago] · [event] · [amount] · [pair]`

Liquidations: slightly larger, red signal dot, `LIQUIDATED` in signal red monospace.

No entry animations. Quiet terminal feel, not slot machine.

---

## Trader Profile

**Hero:** truncated address or ENS. Below: three Display numbers — win rate, best streak, total volume.

**Survival chain:** horizontal node sequence. Won match = filled green circle. Survived re-match = green circle with teal ring. Loss = red circle. Nodes connected left to right by thin line.

**Match history table:** pair, direction, leverage, PnL, outcome. Monospace numbers. Sortable by PnL.

---

## Sound Design (Optional, off by default)

| Event | Sound |
|---|---|
| Price tick | Very quiet high-frequency click, 20ms, below conscious attention |
| Match opened | Clean two-tone chime, short, resolving |
| Near liquidation (yours) | Low pulse, accelerating as equity → 20% |
| Opponent liquidated | Single low-pitched tone, final |
| Your liquidation | 500ms silence, then single low tone — the pause is the design |

One toggle in settings. Users who enable it rarely disable it.

---

## What to Avoid

- Gradient text
- Overdone glassmorphism (one blur layer on header max)
- Neon colors
- Skeleton loaders that flash for < 100ms
- Confetti on win — the bar growing is the celebration

---

## The One Metric

If someone sees a screenshot of a match card with no context — no logo, no name — they should recognize it as Aprox. The vertical bars, stark contrast, large PnL number, opponent column collapsing. Visually distinctive enough to be recognizable. That is the standard.
