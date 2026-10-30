# Aprox — Project Memory

## What it is

Peer-to-peer BTC/USD leveraged perpetuals on Arc. Longs and Shorts match against each other — no reserve, no protocol capital. Circle Modular Wallets + Gas Station for gasless passkey trading.

## Deployed Contracts

### Arc Mainnet (ACTIVE — deployed 2026-10-30)
- **AproxPerpV7**: `0x29A608890589604909Cd79e517E6433Fd7aD0D0E`
  - Tx: `0xb0825ec265d7346e256e18f2aaea6c09ddf806c90c5fd8cb8583d16184d1678e`
  - Explorer: https://explorer.mainnet.arc.io/address/0x29A608890589604909Cd79e517E6433Fd7aD0D0E
  - Deployer/Owner/FeeRecipient: `0xEcfB692d593a349878ef50Df7Bbe3C69bceCeA62`
  - MAX_ORACLE_STALENESS: 86400s (24h — matches Chainlink heartbeat)
  - BTC/USD feed (Chainlink): `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De`
  - ETH/USD feed (Chainlink): `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364`
  - SOL/USD feed (Chainlink): `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C`
  - USDC: `0x3600000000000000000000000000000000000000`
  - No operator server — Chainlink updates autonomously
- **Mainnet legacy (superseded)**
  - MockPriceFeed: `0x86Af80cDAC58cfb7707B0d3c253eBF39168A2445`
  - AproxPerpV2: `0x8692b92b7cB46e1e86EC428A62EB803E4c1d2e48`

### Arc Testnet (ACTIVE — in use on Vercel)
- **AproxPerpV6**: `0xb420bc9a17ac2c3a0ec3383e8227f7253ba41f16` (superseded by V7 — still running, Chronicle oracle)

### Arc Testnet (ACTIVE — V7 redeployed 2026-10-28, with trustless leaderboard stats)
- **AproxPerpV7**: `0xe64ff7b3c346bd727d5291cf3198c7e4c3a51c89`
  - Explorer: https://explorer.testnet.arc.io/address/0xe64ff7b3c346bd727d5291cf3198c7e4c3a51c89
  - Oracle: OperatorPriceFeed per pair (AggregatorV3Interface, 8-dec)
  - MAX_ORACLE_STALENESS: 120s (immutable, set at deploy)
  - Stats mappings: totalMatches, totalWins, totalLosses, totalVolume, winStreak, bestStreak per wallet
  - getStats(address) view returns TraderStats struct
  - BTC pushed every 30s (Pyth/Coinbase fallback); ETH/SOL every 60s via sequential push queue
  - Owner/feeRecipient: `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` (Circle SCP deployer)
  - PAIR_BTC_USD: `0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489`
  - PAIR_ETH_USD: `0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45`
  - PAIR_SOL_USD: `0x2b1b43ec7f6691d6bf679978bab5c093fa45ee74c0baac6cc75649dc59cc21d3`
  - NOTE: pairId constants hardcoded in useAproxContract.ts — do NOT recompute with viem keccak256(toBytes(...))
  - **UPDATE REQUIRED: set VITE_APROX_PERP_ADDRESS=0xe64ff7b3c346bd727d5291cf3198c7e4c3a51c89 on Vercel + Render**
- **OperatorPriceFeed (BTC/USD)**: `0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce`
  - operator: `0xEcfB692d593a349878ef50Df7Bbe3C69bceCeA62` (Render server wallet)
  - Server env: `OPERATOR_PRICE_FEED_ADDRESS=0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce`
- **OperatorPriceFeedETH (ETH/USD)**: `0x3ce2107b718aacc782ccd2b4296a39946db0d8ad`
  - Server env: `OPERATOR_ETH_PRICE_FEED_ADDRESS=0x3ce2107b718aacc782ccd2b4296a39946db0d8ad`
- **OperatorPriceFeedSOL (SOL/USD)**: `0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f`
  - Server env: `OPERATOR_SOL_PRICE_FEED_ADDRESS=0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f`
- USDC: `0x3600000000000000000000000000000000000000`
- Operator server: Render — sequential push queue (one tx at a time, 10s gap). REQUIRED for trades (120s staleness).

### Arc Testnet (superseded)
- AproxPerpV5: `0x86d7e2b9777af45397112c361cbb8bc1dd45cc5c` — MockPriceFeed oracle, required server push, stale since Oct 16
- New MockPriceFeed (unused): `0xf94a5f16ad9ee57dc5ba42a6ddb65ea621e6059c` — operator=0xEcfB...

### Arc Testnet (legacy)
- MockPriceFeed: `0xBbd5ac2614A8bF88308B2Ee880D671766bC524F8`
- AproxPerpV2: `0x8450963e3fc84433d1EFffdBf33691246fD41a4e`
- AproxPerpV4: `0xad627b0eb92a0b6c3a11de6ce90b9b9a38b49392`

## Environment Variables

### Frontend (`.env` / Vercel env vars)
- `VITE_CLIENT_KEY_TESTNET` — Circle Client Key for Arc Testnet (Network: arcTestnet in Console)
- `VITE_CLIENT_KEY_MAINNET` — Circle Client Key for Arc Mainnet (Network: arc in Console)
- `VITE_CLIENT_KEY` — legacy fallback (still works if the two above are absent)
- `VITE_CLIENT_URL` — `https://modular-sdk.circle.com`
- `VITE_NETWORK` — `testnet` (default) or `mainnet`
- **Testnet feeds (Pyth/Coinbase via Render operator server)**
  - `VITE_APROX_PERP_ADDRESS` — AproxPerpV7 testnet: `0x4c107d236f7607c47f15f08b63b6cec263951564`
  - `VITE_OPERATOR_PRICE_FEED_ADDRESS` — BTC testnet feed: `0x0d73f81fc983bf44ed6a65a57e9818ecf57d9cce`
  - `VITE_ETH_PRICE_FEED_ADDRESS` — ETH testnet feed: `0x3ce2107b718aacc782ccd2b4296a39946db0d8ad`
  - `VITE_SOL_PRICE_FEED_ADDRESS` — SOL testnet feed: `0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f`
- **Mainnet feeds (Chainlink Data Feeds, verified live on-chain 2026-10-28)**
  - `VITE_MAINNET_APROX_PERP_ADDRESS` — AproxPerpV7 mainnet: set after `forge create` deploy
  - `VITE_MAINNET_BTC_FEED` — Chainlink BTC/USD: `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De` (heartbeat 24h, 0.5%)
  - `VITE_MAINNET_ETH_FEED` — Chainlink ETH/USD: `0x50FCDD99D6762D1C170DC6A9111db944AEE6D364` (heartbeat 24h, 0.5%)
  - `VITE_MAINNET_SOL_FEED` — Chainlink SOL/USD: `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C` (heartbeat 24h, 0.5%)

### Operator Server (`server/.env`)
- `OPERATOR_PRIVATE_KEY` — operator wallet private key (pushes prices on-chain)
- `OPERATOR_GATEWAY_ADDRESS` — Gateway wallet address for x402
- `OPERATOR_PRICE_FEED_ADDRESS` — OperatorPriceFeed contract address (set after deploy)
- `VITE_APROX_PERP_ADDRESS` — AproxPerpV7 contract address (keeper loop needs this)
- `PORT` — `3001`
- `NETWORK` — `testnet` or `mainnet`

## Passkey Domain

Circle Console Client Key and Passkey Domain must match the deployed app's hostname exactly. Current sandbox hostname: `iohzkmin59sfn62004n4l.preview.studio.arc.io`

## Key Files

- `contracts/AproxPerpV5.sol` — current contract (liquidation re-matching, multi-pair BTC/ETH/SOL, leverage 1-100x, all V3/V4 fixes)
- `contracts/AproxPerpV4.sol` — multi-pair predecessor (do not modify)
- `contracts/AproxPerpV3.sol` — single-pair predecessor (do not modify)
- `contracts/AproxPerpV2.sol` — legacy (do not modify)
- `contracts/MockPriceFeed.sol` — BTC/USD price feed
- `server/index.ts` — operator server
- `src/hooks/useModularWallet.ts` — passkey wallet hook
- `src/hooks/useAproxContract.ts` — contract interactions
- `src/components/TradingPanel.tsx` — trading UI




## Lessons & Known Issues

Full debug lessons documented in `docs/arc-perpetuals-lessons.md` — covers RPC DNS, bundler gas overrides, Circle Console domain setup, transport split, polling storms, and deposit architecture.

