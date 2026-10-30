# APROX — Mainnet Deployment Guide

This guide covers deploying AproxPerpV7 to Arc Mainnet and wiring it into the frontend.
Everything here runs from your own machine with your own wallet — not from Arc Studio.

---

## Prerequisites

- Foundry installed (`forge --version`)
- Arc Mainnet USDC in your wallet for gas (USDC is the native gas token on Arc)
- Your deployer private key in `$PRIVATE_KEY`
- The repo cloned and `forge build` passing

---

## Step 1 — Deploy AproxPerpV7

```bash
forge create contracts/AproxPerpV7.sol:AproxPerpV7 \
  --rpc-url https://rpc.mainnet.arc.io \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --constructor-args \
    0x3600000000000000000000000000000000000000 \
    <YOUR_OWNER_ADDRESS> \
    <YOUR_FEE_RECIPIENT_ADDRESS> \
    0xa109B535C70C8Be9995be64Bb6751AcDB27e03De \
    0x50FCDD99D6762D1C170DC6A9111db944AEE6D364 \
    0x2d04D354f5fDaE3De723df475745B0a9B4edf90C \
    86400
```

**Constructor args explained:**
| Position | Value | Description |
|---|---|---|
| 1 | `0x3600000000000000000000000000000000000000` | USDC on Arc (same on mainnet and testnet) |
| 2 | `<YOUR_OWNER_ADDRESS>` | Your wallet — can call setPriceFeed, transferOwnership |
| 3 | `<YOUR_FEE_RECIPIENT_ADDRESS>` | Receives protocol fees (can be same as owner) |
| 4 | `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De` | Chainlink BTC/USD on Arc Mainnet |
| 5 | `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364` | Chainlink ETH/USD on Arc Mainnet |
| 6 | `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C` | Chainlink SOL/USD on Arc Mainnet |
| 7 | `86400` | MAX_ORACLE_STALENESS — 24h matches Chainlink's heartbeat |

Save the deployed contract address from the output.

---

## Step 2 — Verify Chainlink feeds are live

After deploy, confirm the feeds return valid prices (optional but recommended):

```bash
# BTC/USD
cast call 0xa109B535C70C8Be9995be64Bb6751AcDB27e03De \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url https://rpc.mainnet.arc.io

# ETH/USD
cast call 0x50FCDD99D6762D1C170DC6A9111db944AEE6D364 \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url https://rpc.mainnet.arc.io

# SOL/USD
cast call 0x2d04D354f5fDaE3De723df475745B0a9B4edf90C \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url https://rpc.mainnet.arc.io
```

The second value (`int256`) is the price in 8-decimal format. BTC at $80,000 returns `8000000000000`.

---

## Step 3 — Add env vars to Vercel

In the Vercel dashboard for the APROX frontend, add these environment variables:

```
VITE_MAINNET_APROX_PERP_ADDRESS=<deployed address from Step 1>
VITE_MAINNET_BTC_FEED=0xa109B535C70C8Be9995be64Bb6751AcDB27e03De
VITE_MAINNET_ETH_FEED=0x50FCDD99D6762D1C170DC6A9111db944AEE6D364
VITE_MAINNET_SOL_FEED=0x2d04D354f5fDaE3De723df475745B0a9B4edf90C
```

Redeploy on Vercel after adding the vars.

---

## Step 4 — No operator server needed on mainnet

The Render operator server (which pushes Pyth prices to OperatorPriceFeed) is **testnet only**.
On mainnet, Chainlink updates the price feeds autonomously — your contract reads them directly.
Do not point the Render server at mainnet or change any Render env vars.

---

## Step 5 — Verify the frontend works on mainnet

1. Open the app and click the network badge (top-left) to switch to Arc Mainnet.
2. Register or log in with a passkey.
3. The price bar should show live BTC/USD from Chainlink (updates on 0.5% move or every 24h).
4. Deposit USDC and open a test position to confirm the contract is wired correctly.

---

## What stays the same on mainnet vs testnet

| Item | Testnet | Mainnet |
|---|---|---|
| USDC address | `0x3600...0000` | `0x3600...0000` (same) |
| Pair IDs (keccak256) | same | same |
| Contract logic | identical | identical |
| MAX_ORACLE_STALENESS | 120s | 86400s |
| Oracle | OperatorPriceFeed (Pyth) | Chainlink Data Feeds |
| Operator server | Render (pushes prices) | None (Chainlink autonomous) |
| Gas | Gasless (Circle Gas Station) | Gasless if Gas Station supports mainnet, else user pays USDC gas |

---

## Leaderboard and Live Feed on mainnet

The Leaderboard, Live Feed, and Trader Profile pages all read from on-chain events and `getStats()`.
They work identically on mainnet — no backend changes needed.
The event lookback is 5,000 blocks. On Arc Mainnet (sub-second blocks) this is a shorter time window
than testnet; increase `LOOKBACK_BLOCKS` in `useMatchFeed.ts`, `useLeaderboard.ts`, and
`useTraderProfile.ts` if you want longer history (e.g. `50_000n` for roughly 14 hours at 1-second blocks).

---

## Quick reference — contract addresses

| Network | Contract | Address |
|---|---|---|
| Arc Testnet | AproxPerpV7 (current) | `0xe64ff7b3c346bd727d5291cf3198c7e4c3a51c89` |
| Arc Testnet | OperatorPriceFeed BTC | `0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce` |
| Arc Testnet | OperatorPriceFeed ETH | `0x3ce2107b718aacc782ccd2b4296a39946db0d8ad` |
| Arc Testnet | OperatorPriceFeed SOL | `0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f` |
| Arc Mainnet | AproxPerpV7 | `0x29A608890589604909Cd79e517E6433Fd7aD0D0E` |
| Arc Mainnet | Chainlink BTC/USD | `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De` |
| Arc Mainnet | Chainlink ETH/USD | `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364` |
| Arc Mainnet | Chainlink SOL/USD | `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C` |
