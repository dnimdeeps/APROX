# APROX

**Peer-to-peer leveraged perpetuals on Arc — no liquidity pool, no counterparty risk, just traders vs traders.**

Built with [Arc Studio](https://studio.arc.io)

---

## What it is

APROX matches Long traders directly against Short traders at the same leverage level. Your collateral and your opponent's are locked together. As price moves, equity transfers between you in real time. Every dollar you win came from the person on the other side — there is no pool, no funding rate, no hidden counterparty.

**Live app:** https://aprox.vercel.app

---

## How it works

### Matching

You pick a side (Long or Short), a leverage level (2x–100x), and a collateral amount in USDC. The contract scans the opposite queue at that exact leverage level.

- **Match found:** both sides lock in a pair. PnL accrues in real time against the live oracle price.
- **No match:** your order sits in a pending queue and auto-matches the moment a counterpart arrives. No action needed.

Matching is FIFO within each leverage bucket. A $50 Long at 10x only matches a $50 Short at 10x — leverage levels never mix.

### Live PnL

PnL is computed by the contract's `computeLivePnl` view function using the current oracle price. The number on screen is always exactly what you would receive if you closed right now.

At 10x leverage: a 2% BTC move = 20% of collateral gained or lost. At 50x: a 2% move = 100%.

### Closing

When you close, the contract settles atomically: your collateral ± PnL lands in your free balance immediately. Your counterpart is not closed — the contract finds a replacement on your side from the pending queue and pairs them at the current price. If no replacement exists, the counterpart converts back to pending at their current equity and auto-matches when the next order arrives.

### Liquidation

When equity falls below 20% of original collateral, any address can call `liquidate` and earn a 5% keeper reward. The winning counterpart auto-re-matches with full payout. The operator server runs a keeper loop continuously.

### Re-matching

After liquidation or a voluntary close by the counterpart, the surviving trader is instantly re-matched with a new opponent at the current price. Their accumulated equity — original stake plus winnings — carries forward. One position can survive multiple counterparts, compounding each time.

---

## Mechanics in plain numbers

| Scenario | Result |
|---|---|
| User A (Long 10x $100) matches User B (Short 10x $100) | $100 locked each side |
| BTC moves +2% | A up $20, B down $20 |
| A closes | A receives $120. Contract finds new Long for B |
| New Long found | B and new opponent pair at current price |
| No Long found | B goes pending at $80 equity, auto-matches on arrival |
| B's equity hits 20% threshold | B liquidated, keeper earns 5% reward, B's remainder goes to winner |

---

## Features

- **Passkey wallets** — register with Face ID or fingerprint. No seed phrase, no browser extension. Circle Modular Wallets create a gasless ERC-4337 smart account.
- **Gasless trading** — Circle Gas Station sponsors every transaction. Users only hold USDC.
- **Live match visualizer** — two vertical bars show each trader's equity in real time. A re-matched position shows layered bars: original stake vs accumulated winnings.
- **On-chain leaderboard** — win rate, streak, best streak, and volume written to contract storage on every close. Fully trustless, no backend database.
- **Live activity feed** — recent matches, liquidations, and re-matches from contract events with leverage, collateral, price, and trader addresses.
- **Market depth** — pending order volume by leverage tier via a single Multicall3 batch.
- **Dual network** — one toggle switches between Arc Testnet (Pyth oracle, test USDC) and Arc Mainnet (Chainlink, real USDC). Both live simultaneously.
- **Three trading pairs** — BTC/USD, ETH/USD, SOL/USD.

---

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Solidity 0.8.28, OpenZeppelin, Arc Testnet + Mainnet |
| Price feeds (mainnet) | Chainlink Data Feeds |
| Price feeds (testnet) | Pyth Network via operator server |
| Wallets | Circle Modular Wallets — ERC-4337 passkey smart accounts |
| Gas sponsorship | Circle Gas Station |
| Chain | Arc (USDC is the native gas token) |
| Frontend | React, TypeScript, Vite, Tailwind CSS, wagmi v2, viem |
| Onchain reads | Multicall3, publicClient |
| Operator server | Bun, deployed on Render |

---

## Deployed contracts

### Arc Mainnet

| Contract | Address |
|---|---|
| AproxPerpV7 | [0x29A608890589604909Cd79e517E6433Fd7aD0D0E](https://explorer.arc.io/address/0x29A608890589604909Cd79e517E6433Fd7aD0D0E) |
| Chainlink BTC/USD | [0xa109B535C70C8Be9995be64Bb6751AcDB27e03De](https://explorer.arc.io/address/0xa109B535C70C8Be9995be64Bb6751AcDB27e03De) |
| Chainlink ETH/USD | [0x50FCDD99D6762D1C170DC6A9111db944AEE6D364](https://explorer.arc.io/address/0x50FCDD99D6762D1C170DC6A9111db944AEE6D364) |
| Chainlink SOL/USD | [0x2d04D354f5fDaE3De723df475745B0a9B4edf90C](https://explorer.arc.io/address/0x2d04D354f5fDaE3De723df475745B0a9B4edf90C) |

Deploy tx: [explorer.arc.io](https://explorer.arc.io/tx/0xb0825ec265d7346e256e18f2aaea6c09ddf806c90c5fd8cb8583d16184d1678e)

Chain ID: 5042 — Arc Mainnet
USDC: `0x3600000000000000000000000000000000000000`

### Arc Testnet

| Contract | Address |
|---|---|
| AproxPerpV7 | [0xe64ff7b3c346bd727d5291cf3198c7e4c3a51c89](https://explorer.testnet.arc.io/address/0xe64ff7b3c346bd727d5291cf3198c7e4c3a51c89) |
| OperatorPriceFeed BTC/USD | [0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce](https://explorer.testnet.arc.io/address/0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce) |
| OperatorPriceFeed ETH/USD | [0x3ce2107b718aacc782ccd2b4296a39946db0d8ad](https://explorer.testnet.arc.io/address/0x3ce2107b718aacc782ccd2b4296a39946db0d8ad) |
| OperatorPriceFeed SOL/USD | [0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f](https://explorer.testnet.arc.io/address/0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f) |

Chain ID: 5042002 — Arc Testnet
USDC: `0x3600000000000000000000000000000000000000`

---

## Run locally

```bash
# Frontend
bun install
cp .env.example .env   # fill in values below
bun run dev

# Operator server (separate terminal — testnet only)
cd server
bun install
cp env-example.txt .env
bun run dev
```

### Frontend environment variables

| Variable | Description |
|---|---|
| `VITE_CLIENT_KEY_TESTNET` | Circle Console Client Key scoped to Arc Testnet |
| `VITE_CLIENT_KEY_MAINNET` | Circle Console Client Key scoped to Arc Mainnet |
| `VITE_CLIENT_URL` | `https://modular-sdk.circle.com` |
| `VITE_NETWORK` | `testnet` (default) or `mainnet` |
| `VITE_APROX_PERP_ADDRESS` | AproxPerpV7 testnet address |
| `VITE_MAINNET_APROX_PERP_ADDRESS` | AproxPerpV7 mainnet address |
| `VITE_OPERATOR_PRICE_FEED_ADDRESS` | OperatorPriceFeed BTC/USD testnet address |
| `VITE_ETH_PRICE_FEED_ADDRESS` | OperatorPriceFeed ETH/USD testnet address |
| `VITE_SOL_PRICE_FEED_ADDRESS` | OperatorPriceFeed SOL/USD testnet address |
| `VITE_MAINNET_BTC_FEED` | Chainlink BTC/USD mainnet address |
| `VITE_MAINNET_ETH_FEED` | Chainlink ETH/USD mainnet address |
| `VITE_MAINNET_SOL_FEED` | Chainlink SOL/USD mainnet address |

### Server environment variables (`server/.env`)

The operator server is testnet-only. On mainnet, Chainlink feeds update autonomously — no server needed.

| Variable | Description |
|---|---|
| `OPERATOR_PRIVATE_KEY` | Wallet that pushes Pyth prices to the testnet OperatorPriceFeed contracts |
| `OPERATOR_PRICE_FEED_ADDRESS` | OperatorPriceFeed BTC/USD address |
| `OPERATOR_ETH_PRICE_FEED_ADDRESS` | OperatorPriceFeed ETH/USD address |
| `OPERATOR_SOL_PRICE_FEED_ADDRESS` | OperatorPriceFeed SOL/USD address |
| `VITE_APROX_PERP_ADDRESS` | AproxPerpV7 testnet address (keeper loop) |
| `PYTH_API_KEY` | Pyth Hermes API key |
| `PORT` | `3001` |
| `NETWORK` | `testnet` |

The operator wallet needs a small USDC balance on Arc Testnet to pay gas on oracle push transactions.

---

## Circle products used

- **Circle Modular Wallets** — passkey smart accounts (ERC-4337). No seed phrase, no extension. Works on mobile.
- **Circle Gas Station** — all transaction fees sponsored. Users only ever hold USDC.
- **Arc** — USDC is the native gas token. No ETH, no switching between tokens.
