# Aprox — Project Memory

## What it is

Peer-to-peer BTC/USD leveraged perpetuals on Arc. Longs and Shorts match against each other — no reserve, no protocol capital. Circle Modular Wallets + Gas Station for gasless passkey trading.

## Deployed Contracts

### Arc Mainnet (active)
- MockPriceFeed: `0x86Af80cDAC58cfb7707B0d3c253eBF39168A2445`
- AproxPerpV2: `0x8692b92b7cB46e1e86EC428A62EB803E4c1d2e48`
- USDC: `0x3600000000000000000000000000000000000000`
- Operator/Owner: `0xEcfB692d593a349878ef50Df7Bbe3C69bceCeA62`

### Arc Testnet (ACTIVE — in use on Vercel)
- AproxPerpV5: `0x86d7e2b9777af45397112c361cbb8bc1dd45cc5c` (MAX_ORACLE_STALENESS=3600, owner=0xEcfB...)
  - Owner: `0xEcfB692d593a349878ef50Df7Bbe3C69bceCeA62`
  - BTC/USD feed: `0x100761B064Ccef934ed3b3efFBeD3F9a08bd747b`
  - PAIR_BTC_USD (on-chain): `0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489`
  - PAIR_ETH_USD (on-chain): `0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45`
  - PAIR_SOL_USD (on-chain): `0x2b1b43ec7f6691d6bf679978bab5c093fa45ee74c0baac6cc75649dc59cc21d3`
  - NOTE: pairId constants are hardcoded in useAproxContract.ts — do NOT recompute with viem keccak256(toBytes(...)), it produces a different hash than Solidity keccak256("string literal")
- USDC: `0x3600000000000000000000000000000000000000`
- Operator server: Railway (must be running — MAX_ORACLE_STALENESS is only 1h)

### Arc Testnet (legacy)
- MockPriceFeed: `0xBbd5ac2614A8bF88308B2Ee880D671766bC524F8`
- AproxPerpV2: `0x8450963e3fc84433d1EFffdBf33691246fD41a4e`
- AproxPerpV4: `0xad627b0eb92a0b6c3a11de6ce90b9b9a38b49392`

## Environment Variables

### Frontend (`.env`)
- `VITE_CLIENT_KEY` — Circle Client Key
- `VITE_CLIENT_URL` — `https://modular-sdk.circle.com`
- `VITE_APROX_PERP_ADDRESS` — AproxPerpV2 address
- `VITE_MOCK_PRICE_FEED_ADDRESS` — MockPriceFeed address
- `VITE_NETWORK` — `testnet` (default) or `mainnet`

### Operator Server (`server/.env`)
- `OPERATOR_PRIVATE_KEY` — oracle operator wallet key
- `MOCK_PRICE_FEED_ADDRESS` — MockPriceFeed address
- `APROX_PERP_ADDRESS` — AproxPerpV2 address
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

