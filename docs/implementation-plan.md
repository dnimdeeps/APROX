Let me read the exact settlement logic in the contract. Now I have everything. Here's exactly what the contract does in each scenario.

---

**Scenario: Alice (Long $20) vs Bob (Short $20) at 100x. Alice wins and closes.**

**When Alice calls `closeOrder`:**

1. PnL is computed at the current oracle price. Say BTC moved +0.42%, Alice is up $8.42, Bob is down $8.42.
2. Alice receives her $20 matched collateral + $8.42 PnL = **$28.42 into her free balance**. Order closed.
3. The contract now looks at Bob's side. It calls `_transferCounterpartyPosition` — it searches the pending queue for another Long at the same leverage (100x) and same pair (BTC/USD).

**Two outcomes for Bob:**

**If a new Long (Carol) is waiting in the queue:**
- Bob is immediately re-matched with Carol at the current price. Bob's locked collateral becomes `$20 - $8.42 = $11.58` (his remaining equity after the loss).
- Bob's new entry price is the current oracle price. He keeps playing. Carol is matched against Bob's $11.58 of equity.
- Bob never has to do anything. His position just continues with a new counterpart.

**If nobody is waiting in the queue:**
- Bob's remaining equity ($11.58) moves from `matchedCollateral` to `pendingCollateral`.
- Bob's status becomes PENDING. He sits in the queue.
- The moment any new Long at 100x BTC/USD arrives, Bob auto-matches with them instantly.

---

**Scenario: Alice's position hits liquidation threshold (equity < 20% of collateral)**

- Anyone (including the Render keeper loop) calls `liquidate(aliceOrderId)`.
- Alice gets nothing (or a tiny residual if equity > 0).
- The keeper earns 5% of Alice's original matched collateral as a reward.
- Bob (the winner) gets `Alice's $20 + Alice's $20 = $40 minus the 5% keeper fee` → **~$39** credited to his position.
- Same re-match logic: contract looks for a new Short in the queue to pair against Bob's ~$39. If one exists, Bob re-matches immediately at current price. If not, Bob goes pending with $39 in his position waiting for a counterpart.

---

**Key point about the winner's position size**

The winner is **never matched for more than their original collateral**. When Bob re-matches after winning, his `lockedCollateral` in the new pair is his current equity (e.g. $11.58 or $39), not the original $20 or the combined $40. The counterpart only needs to match that amount. So the pool grows naturally with winnings but is always constrained to what's actually at stake.
