# Aprox — Match Mechanics

This document is the canonical reference for how peer-to-peer matching, live PnL,
position transfer, and settlement work in Aprox. Every statement here maps directly
to contract code in `contracts/AproxPerpV6.sol`.

---

## 1. The core model

Aprox has **no liquidity pool and no protocol reserve**. The contract is pure escrow:
every dollar of profit paid to one trader comes from the collateral of their
counterpart. The protocol never takes a directional risk.

A trade requires two participants:
- A **Long** (profits when BTC/USD rises)
- A **Short** (profits when BTC/USD falls)

Both must have the **same leverage** and the **same trading pair**. The contract
matches them FIFO from a per-leverage, per-pair pending queue.

---

## 2. Order lifecycle

```
openOrder()
    │
    ├─ Collateral deducted from freeBalance
    ├─ Order created: status = PENDING
    │
    ├─ matchOrder() runs immediately ──────────────────────────────────────────┐
    │   Scans the opposite queue (same leverage, same pair) front-to-back      │
    │   For each counterpart found:                                             │
    │     fillAmount = min(my pending, their pending)                           │
    │     MatchedPair created: locks fillAmount on each side                    │
    │     Both orders updated: matchedCollateral += fillAmount                  │
    │                          pendingCollateral  -= fillAmount                 │
    │     If counterpart fully filled → status = ACTIVE, removed from queue    │
    │   Repeat until my pendingCollateral = 0 or queue is empty                │
    │                                                                           │
    │   After loop:                                                             │
    │     pendingCollateral = 0 → status = ACTIVE                              │
    │     pendingCollateral > 0 → status = PENDING, added to queue             │
    └───────────────────────────────────────────────────────────────────────────┘

closeOrder()      → settle all matched pairs, refund pending, transfer survivors
cancelOrder()     → refund pendingCollateral only (matched pairs still active)
liquidate()       → keeper-triggered forced close when health < 20%
```

---

## 3. Detailed walk-through: User A vs User B

### Setup

| | User A | User B |
|---|---|---|
| Direction | Long | Short |
| Leverage | 10x | 10x |
| Collateral | $20 USDC | $20 USDC |
| Entry price | $65,000 | $65,000 |

When User A opens a Long 10x $20, the contract scans the Short 10x queue and finds
User B's $20 Short. `fillAmount = min(20, 20) = 20`. A `MatchedPair` is created:

```
MatchedPair {
  longOrderId:      A
  shortOrderId:     B
  lockedCollateral: 20 USDC   ← each side locked
  longEntryPrice:   65000 * 1e18
  shortEntryPrice:  65000 * 1e18
  settled:          false
}
```

Both orders move to `ACTIVE`. Total locked in the pair: **$40 USDC** ($20 from A + $20 from B).

### Live PnL (while the position is open)

PnL is computed **client-side** every second from the live WebSocket price. The
formula (applied per `MatchedPair`):

```
pnl = lockedCollateral × leverage × (currentPrice - entryPrice) / entryPrice
    (flipped for the short side: delta = entryPrice - currentPrice)
```

Example — BTC moves from $65,000 to $66,300 (+2%):

```
User A (Long):  pnl = 20 × 10 × (+0.02) = +$4.00 USDC
User B (Short): pnl = 20 × 10 × (-0.02) = -$4.00 USDC
```

User B's remaining value = $20 − $4 = **$16 USDC** (80% of original → approaching liquidation threshold).

The contract's `computeLivePnl()` view function performs the same calculation
on-chain for accurate settlement at close time. The frontend uses the WebSocket
price for display only.

### Liquidation threshold

A position is eligible for liquidation when its remaining collateral drops below
**20% of the original locked amount**:

```
remaining < lockedCollateral × 20%
```

For User B: remaining < $20 × 20% = $4 USDC.  
That happens at an 8% adverse move at 10x leverage (10% would be full loss; 8% leaves
20% remaining).

Liquidation prices at entry $65,000 with 10x leverage:
```
Long  liq price = entry × (1 − 0.8/leverage) = 65000 × (1 − 0.08) = $59,800
Short liq price = entry × (1 + 0.8/leverage) = 65000 × (1 + 0.08) = $70,200
```

---

## 4. Close and position transfer

### User A closes (User B stays)

User A calls `closeOrder()`. The contract:

1. Reads the current oracle price (Chronicle 18-dec).
2. For the A-B `MatchedPair`, computes `pnl` using the formula above.
3. `closerPayout = lockedCollateral + pnl` (floored at 0, capped at 2× locked).
4. Marks the pair `settled = true`.
5. Calls `_transferCounterpartyPosition(B, neededIsLong=true, lockedCollateral=20, currentPrice)`:
   - Scans the **Long pending queue** at 10x BTC/USD for a User C.
   - User C must have `pendingCollateral >= 20` (needs to cover the full locked amount).
   - If found: creates a new `MatchedPair` between B and C at `currentPrice`. User B stays `ACTIVE` with a fresh entry at the close price. User C's pendingCollateral is reduced.
6. If no User C exists: User B's `matchedCollateral` is set to 0, the net remaining collateral (`2 × locked − closerPayout`) is added to User B's `pendingCollateral`, and User B goes back to `PENDING` in the queue to wait for the next Long.
7. User A's `freeBalance` increases by `closerPayout`.

### User B's surviving position after transfer

| Scenario | User B outcome |
|---|---|
| User C exists in queue | New `MatchedPair` B↔C created at close price. B is `ACTIVE` with a fresh entry. C fills from their pending queue. |
| No User C | B's remaining balance is re-queued as `pendingCollateral`. B is `PENDING`. Trades earn/lose nothing until matched again. |

**Important:** User B's PnL is NOT settled when A closes. B only realises a gain or
loss when B's OWN pairs are settled (i.e. when B calls `closeOrder()`, or is liquidated,
or a new counterpart matches with B and that new pair is eventually settled).

---

## 5. Partial fills

If User A opens a Long for $50 USDC but only $30 of Short liquidity exists at 10x:

- A `MatchedPair` is created for $30 (A↔B).
- User A has `matchedCollateral = $30` (ACTIVE) + `pendingCollateral = $20` (waiting).
- User A's status stays `PENDING` until the remaining $20 is matched.
- When User C arrives with a Short $20, a second `MatchedPair` (A↔C) is created.
- User A's `entryPrice` is updated to the weighted average of both fill prices.
- Closing User A settles both pairs independently.

---

## 6. Key invariants

| Invariant | Guarantee |
|---|---|
| Zero-sum PnL | `closerPayout + counterPayout = 2 × lockedCollateral` (or less if capped at 0) |
| No protocol reserve | Every USDC in and out is a trader's |
| Max loss = collateral | `closerPayout` is floored at 0 — traders can never go negative |
| Collateral isolated | Each `MatchedPair` is settled independently — a loss in one pair doesn't drain collateral from another |
| FIFO queue | Pending orders at the same leverage are matched oldest-first |
| Same leverage required | A 5x Long cannot match a 10x Short — the notional exposure must be symmetric |

---

## 7. Fee structure

Currently **no protocol fee** is charged on open/close. The `feeRecipient` address is
stored for a future fee mechanism. Keeper rewards (liquidations) are 5% of the
liquidated collateral, paid from the liquidated trader's locked amount.

---

## 8. Oracle

AproxPerpV6 uses **Chronicle Protocol** BTC/USD feeds on Arc Testnet. Chronicle
publishes 18-decimal prices with a ~1 hour heartbeat and a 1% deviation trigger.
The staleness window is set to 2 hours (one full heartbeat + margin). No operator
server is required for trades — the server only provides the WebSocket price stream
for frontend display and the x402 price-feed service.
