# Aprox

**PvP leveraged perpetuals on Arc — no liquidity pool, no counterparty risk, just traders vs traders.**

Built with [Arc Studio](https://studio.arc.io)

Aprox matches Long traders directly against Short traders at the same leverage level. The protocol holds collateral and settles PnL — it never risks its own capital. Every action is gasless: register with a fingerprint or Face ID, trade with USDC, no seed phrase or gas token ever needed.

**Live app (testnet):** https://aprox.vercel.app  
**Operator server:** Render

---

## How it works

### Matching

When you open a position, you pick a side (Long or Short), a leverage level (2x–100x), and a collateral amount. The contract immediately scans the opposite queue at that exact leverage level for a counterpart.

- **Match found:** both sides are locked in a pair. PnL starts accruing in real time against the live BTC/USD oracle price. No waiting.
- **No match:** your collateral sits in a pending queue. The moment a counterpart arrives at your leverage level, you match automatically — no action needed.

Matching is FIFO within each leverage bucket. A $50 Long at 10x only matches against a $50 Short at 10x — leverage levels never mix.

### Live PnL

PnL is computed from the on-chain oracle price pushed every 5 seconds by the operator server (sourced from Pyth Network). The contract's `computeLivePnl` view function runs the exact same math as settlement, so the number on screen is always what you would receive if you closed right now.

At 10x leverage: a 2% BTC move = 20% of your collateral gained or lost. At 50x: a 2% move = 100%.

### Closing a position

When you click Close, the contract reads the current oracle price, computes PnL, and settles atomically:

- Your collateral ± PnL lands in your Free Balance immediately.
- Your counterpart's position does not end — instead, the contract automatically searches the pending queue for a replacement on your side. If User A (Long) closes, the contract finds the next pending Long and pairs them with User B (Short) at the current price. User B keeps playing without lifting a finger.
- If no replacement exists, User B's matched collateral converts back to pending at their current equity value. They stay in the queue and auto-match the next Long that arrives.

### Liquidation

If a position's remaining equity falls below 20% of the original collateral (at current oracle price), any address can call `liquidate` and earn a 5% keeper reward from the losing side's remaining collateral. The winning counterpart auto-re-matches into the queue with their full payout. The operator server runs a keeper loop every 30 seconds.

---

## The mechanics in plain numbers

| Scenario | What happens |
|---|---|
| User A (Long 10x, $100) matches User B (Short 10x, $100) | $100 locked on each side |
| BTC moves +2% | User A up +$20, User B down -$20 |
| User A closes | A receives $120. B's position searches for a new Long to replace A |
| New Long (User C) found in queue | B and C are paired at the current price. B keeps playing |
| No Long found | B goes back to pending queue at current equity ($80). Auto-matches when C arrives |
| BTC moves -80% against B (still matched) | B's equity hits 20% threshold — liquidated. Keeper earns 5% reward |

---

## What makes this different

Most perp protocols run against a liquidity pool. This creates structural imbalances: the pool needs to manage risk, charge funding rates, and cap open interest. Aprox has none of that. Longs and Shorts always net to zero — every dollar one side gains, the other side loses. The protocol is pure escrow.

The trade-off: if nobody is on the other side at your leverage level, you wait. There is no AMM to fill against. This is honest — there is no hidden counterparty taking the other side of every trade with a funding rate markup.

---

## Tech stack

- **Smart contract:** `AproxPerpV7.sol` — Solidity, Arc Testnet
- **Oracle (testnet):** `OperatorPriceFeed.sol` — server pushes Pyth Hermes BTC/USD on-chain every 5s
- **Oracle (mainnet path):** Chainlink Data Streams — same `AggregatorV3Interface`, swap the address
- **Wallets:** Circle Modular Wallets (ERC-4337 passkey smart accounts)
- **Gas:** Circle Gas Station — all fees sponsored, users only hold USDC
- **Chain:** Arc Testnet (Arc Mainnet when ready) — USDC is the native gas token
- **Frontend:** React + TypeScript + Vite + Tailwind + wagmi v2
- **Operator server:** Bun + Express + WebSocket, deployed on Render
- **x402 nanopayments:** Circle Gateway — `/price` endpoint gated at $0.0001 USDC per call

---

## Deployed contracts (Arc Testnet)

| Contract | Address |
|---|---|
| AproxPerpV7 | [0x4c107d236f7607c47f15f08b63b6cec263951564](https://explorer.testnet.arc.io/address/0x4c107d236f7607c47f15f08b63b6cec263951564) |
| OperatorPriceFeed (BTC/USD) | [0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce](https://explorer.testnet.arc.io/address/0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce) |
| OperatorPriceFeedETH (ETH/USD) | [0x3ce2107b718aacc782ccd2b4296a39946db0d8ad](https://explorer.testnet.arc.io/address/0x3ce2107b718aacc782ccd2b4296a39946db0d8ad) |
| OperatorPriceFeedSOL (SOL/USD) | [0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f](https://explorer.testnet.arc.io/address/0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f) |

Chain ID: 5042002 — Arc Testnet  
USDC: `0x3600000000000000000000000000000000000000`

---

## Run locally

```bash
# Frontend
bun install
cp .env.example .env   # fill in values below
bun run dev

# Operator server (separate terminal)
cd server
bun install
cp env-example.txt .env
bun run dev
```

### Frontend environment variables (`.env`)

| Variable | Description |
|---|---|
| `VITE_CLIENT_KEY` | Circle Console Client Key (Modular Wallets) |
| `VITE_CLIENT_URL` | `https://modular-sdk.circle.com` |
| `VITE_APROX_PERP_ADDRESS` | AproxPerpV7 contract address |
| `VITE_OPERATOR_PRICE_FEED_ADDRESS` | OperatorPriceFeed contract address |
| `VITE_SERVER_URL` | Operator server WebSocket base URL |
| `VITE_NETWORK` | `testnet` (default) or `mainnet` |

### Server environment variables (`server/.env`)

| Variable | Description |
|---|---|
| `OPERATOR_PRIVATE_KEY` | Wallet that pushes prices on-chain (must be the `operator` set on OperatorPriceFeed) |
| `OPERATOR_GATEWAY_ADDRESS` | Circle Gateway wallet address for x402 revenue |
| `OPERATOR_PRICE_FEED_ADDRESS` | OperatorPriceFeed contract address |
| `VITE_APROX_PERP_ADDRESS` | AproxPerpV7 address (keeper loop) |
| `PORT` | `3001` |
| `NETWORK` | `testnet` or `mainnet` |

The operator wallet needs a small USDC balance on Arc Testnet for gas on the `updateAnswer` calls (a few cents per push at 5s intervals).

---

## Mainnet upgrade path

1. Deploy a Chainlink Data Streams adapter implementing `AggregatorV3Interface` on Arc Mainnet.
2. Deploy `AproxPerpV7` pointing at that adapter — no contract code changes.
3. Update `VITE_APROX_PERP_ADDRESS` and `VITE_OPERATOR_PRICE_FEED_ADDRESS` on Vercel.
4. Update `OPERATOR_PRICE_FEED_ADDRESS` on Render (server switches to calling the Chainlink DS verifier instead of pushing on-chain).

---

## Circle products used

- **Circle Modular Wallets** — passkey smart accounts (ERC-4337). No seed phrase, no extension. Works on mobile.
- **Circle Gas Station** — all transaction fees sponsored. Users only ever hold USDC.
- **Arc** — USDC is the native gas token. No ETH, no MATIC, no token switching.
- **Circle Gateway (x402)** — the `/price` endpoint charges $0.0001 USDC per API call via HTTP 402 nanopayments.
