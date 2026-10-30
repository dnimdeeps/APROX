#!/usr/bin/env bash
# register-price-feeds.sh
# Calls setPriceFeed on AproxPerpV5 for BTC/USD, ETH/USD, SOL/USD.
# Run this once with the operator/owner private key.
#
# Usage:
#   OPERATOR_PRIVATE_KEY=0x... bash scripts/register-price-feeds.sh
#
# Or set the key in server/.env and run:
#   source server/.env && bash scripts/register-price-feeds.sh

set -euo pipefail

PERP=0x2e16cf06ea8505e450972dacf4a73f5f10c8b46f
FEED_BTC=0x67001b88d40354de65185397b763d2c8e2d5146d
FEED_ETH=0x100761b064ccef934ed3b3effbed3f9a08bd747b
FEED_SOL=0xb8ada5ae28eee0507430c33bb7c077b9849ba7bc
RPC=https://rpc.testnet.arc.io

# Pair IDs — keccak256 of raw UTF-8 bytes (matches Solidity keccak256("BTC/USD"))
PAIR_BTC=0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489
PAIR_ETH=0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45
PAIR_SOL=0x2b1b43ec7f6691d6bf679978bab5c093fa45ee74c0baac6cc75649dc59cc21d3

if [ -z "${OPERATOR_PRIVATE_KEY:-}" ]; then
  echo "ERROR: OPERATOR_PRIVATE_KEY is not set."
  echo "Run: OPERATOR_PRIVATE_KEY=0x... bash scripts/register-price-feeds.sh"
  exit 1
fi

echo "Contract:  $PERP"
echo "RPC:       $RPC"
echo "Operator:  $(cast wallet address "$OPERATOR_PRIVATE_KEY")"
echo ""

# Check current state first
echo "=== Current price feed state ==="
BTC_FEED=$(cast call "$PERP" "getPriceFeed(bytes32)(address)" "$PAIR_BTC" --rpc-url "$RPC")
ETH_FEED=$(cast call "$PERP" "getPriceFeed(bytes32)(address)" "$PAIR_ETH" --rpc-url "$RPC")
SOL_FEED=$(cast call "$PERP" "getPriceFeed(bytes32)(address)" "$PAIR_SOL" --rpc-url "$RPC")
echo "BTC/USD feed: $BTC_FEED"
echo "ETH/USD feed: $ETH_FEED"
echo "SOL/USD feed: $SOL_FEED"
echo ""

ZERO=0x0000000000000000000000000000000000000000

# Register BTC/USD
if [ "$BTC_FEED" = "$ZERO" ]; then
  echo "Registering BTC/USD feed ($FEED_BTC)..."
  cast send "$PERP" "setPriceFeed(bytes32,address)" "$PAIR_BTC" "$FEED_BTC" \
    --private-key "$OPERATOR_PRIVATE_KEY" --rpc-url "$RPC"
  echo "BTC/USD registered."
else
  echo "BTC/USD already set: $BTC_FEED (skipping)"
fi

# Register ETH/USD
if [ "$ETH_FEED" = "$ZERO" ]; then
  echo "Registering ETH/USD feed ($FEED_ETH)..."
  cast send "$PERP" "setPriceFeed(bytes32,address)" "$PAIR_ETH" "$FEED_ETH" \
    --private-key "$OPERATOR_PRIVATE_KEY" --rpc-url "$RPC"
  echo "ETH/USD registered."
else
  echo "ETH/USD already set: $ETH_FEED (skipping)"
fi

# Register SOL/USD
if [ "$SOL_FEED" = "$ZERO" ]; then
  echo "Registering SOL/USD feed ($FEED_SOL)..."
  cast send "$PERP" "setPriceFeed(bytes32,address)" "$PAIR_SOL" "$FEED_SOL" \
    --private-key "$OPERATOR_PRIVATE_KEY" --rpc-url "$RPC"
  echo "SOL/USD registered."
else
  echo "SOL/USD already set: $SOL_FEED (skipping)"
fi

echo ""
echo "=== Final price feed state ==="
cast call "$PERP" "getPriceFeed(bytes32)(address)" "$PAIR_BTC" --rpc-url "$RPC"
cast call "$PERP" "getPriceFeed(bytes32)(address)" "$PAIR_ETH" --rpc-url "$RPC"
cast call "$PERP" "getPriceFeed(bytes32)(address)" "$PAIR_SOL" --rpc-url "$RPC"
echo "Done."
