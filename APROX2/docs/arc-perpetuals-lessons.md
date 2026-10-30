# Arc Perpetuals — Hard-Won Lessons

Lessons from building Aprox: a peer-to-peer BTC/USD leveraged perpetuals DEX on Arc Mainnet using Circle Modular Wallets, ERC-4337, and a custom Solidity matching engine. Every section below cost real debugging time.

---

## 1. Arc Testnet RPC — the silent fund-disappearing bug

### What happened

Viem's built-in `arcTestnet` chain definition lists `https://rpc.testnet.arc.network` as its primary RPC. That domain does not resolve. If you read the RPC from the chain definition (`arcTestnet.rpcUrls.default.http[0]`), every `readContract` call fails silently. The app looks broken — deposited funds appear to disappear, order lists are empty, balances stay at zero — but the contract state is completely fine.

### The symptom

```
ERR_NAME_NOT_RESOLVED
POST https://rpc.testnet.arc.network/ net::ERR_NAME_NOT_RESOLVED
[TradingPanel] getActiveOrders failed: HTTP request failed.
```

### The fix

Hardcode the working endpoint. Never read from the chain definition until `.arc.network` DNS is confirmed live:

```ts
const RPC_URL = IS_MAINNET
  ? 'https://rpc.arc.io'
  : 'https://rpc.testnet.arc.io'

export const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(RPC_URL),
})
```

### How to verify before switching

```bash
curl -s -X POST https://rpc.testnet.arc.network/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

A valid JSON response means DNS is live. Any network error means hardcode instead.

### Critical: do NOT spread ACTIVE_CHAIN

`ACTIVE_CHAIN` must be the exact `arc` or `arcTestnet` object from `viem/chains`. The Circle SDK matches it by identity. A spread copy (`{ ...arcTestnet, rpcUrls: ... }`) causes `sendUserOperation` to fail with "Missing or invalid parameters" (-32602). The correct fix for the DNS issue is hardcoding the transport URL — not touching the chain object.

---

## 2. Circle Bundler broken defaults — two required overrides

### What happened

The Arc Testnet Circle bundler returns wrong estimates for two parameters from `eth_estimateUserOperationGas`, then immediately rejects the UserOp with "Missing or invalid parameters" if you use those estimates.

| Parameter | Bundler estimates | Bundler requires |
|---|---|---|
| `paymasterPostOpGasLimit` | `3000` | `>= 100000` |
| `maxPriorityFeePerGas` | `0` | `>= 1 gwei (1000000000)` |

The error message gives no indication of which parameter is wrong or what the correct value should be.

### The fix — paymaster interceptor + maxPriorityFeePerGas override

Passing `paymasterPostOpGasLimit: 100000n` directly to `sendUserOperation` does NOT reliably work. Viem's `prepareUserOperation` calls `pm_getPaymasterData` last and **spreads its full response on top**, overwriting the override with `3000` again.

The only reliable fix is to intercept the paymaster response at the `createBundlerClient` level and clamp the value there:

```ts
const rawBundlerClient = createBundlerClient({
  account: smartAccount,
  chain: ACTIVE_CHAIN,
  transport: modularTransport,
})

const bundlerClient = createBundlerClient({
  account: smartAccount,
  chain: ACTIVE_CHAIN,
  transport: modularTransport,
  paymaster: {
    getPaymasterStubData: (parameters) =>
      getPaymasterStubData(rawBundlerClient as never, parameters),
    getPaymasterData: async (parameters): Promise<GetPaymasterDataReturnType> => {
      const data = await getPaymasterData(rawBundlerClient as never, parameters)
      if ('paymaster' in data && data.paymaster) {
        const raw = data.paymasterPostOpGasLimit ?? 0n
        return {
          ...data,
          paymasterPostOpGasLimit: raw < 100000n ? 100000n : raw,
        } as GetPaymasterDataReturnType
      }
      return data
    },
  },
})
```

`maxPriorityFeePerGas` is still passed directly to `sendUserOperation` — that one is a fee estimation issue (bundler returns 0, Arc requires ≥ 1 gwei), not a paymaster issue, and the spread does not affect it:

```ts
bundlerClient.sendUserOperation({
  calls,
  maxPriorityFeePerGas: 1000000000n, // Arc bundler minimum — do not remove
})
```

### Why `paymasterPostOpGasLimit` override doesn't survive `sendUserOperation`

`prepareUserOperation` spread order (viem source):
1. Gas estimation runs — preserves explicit `paymasterPostOpGasLimit` via `??`
2. `getPaymasterData` (pm_getPaymasterData) runs — **spreads full response last**, overwriting step 1
3. Result is sent to bundler with the paymaster's `3000`

The paymaster interceptor runs at step 2 and controls what gets spread. It is the only effective override point.

### Secondary symptom: "Max operations (4) reached"

Each failed `sendUserOperation` (rejected because `paymasterPostOpGasLimit: 3000`) leaves a UserOp stuck in the bundler mempool. ERC-4337 allows at most 4 pending ops per unstaked account. After 4 failed attempts, every subsequent attempt is rejected with:

> "Max operations (4) reached for account: 0x... due to being unstaked"

Wait ~5 minutes for the mempool to flush, then fix the root cause. Do not keep retrying — each attempt makes it worse.

Do not remove the paymaster interceptor "to clean up the code." The Circle bundler does not fix itself.

---

## 3. Circle Console — two separate domain fields, both required

### What happened

Circle Console has two distinct domain configuration fields. Setting only one looks correct but breaks half the flow with the same "Invalid credentials" error regardless of which one is missing.

| Field | Where in Console | What it gates |
|---|---|---|
| **Client Key Allowed Domain** | Testnet → Keys → Client Keys → Edit | `toPasskeyTransport` — register and login |
| **Passkey Domain Name** | Testnet → Wallets → Modular Wallets → Configurator → Passkey | `toModularTransport` — sendUserOperation, gas estimation, paymaster |

Both must be set to the **exact preview hostname** — no `https://`, no trailing slash.

Example: `i4puwc5z0wbxc00rpsxla.preview.studio.arc.io`

### The session hostname problem

Arc Studio assigns a new hostname every sandbox session. Passkeys are origin-bound — a passkey registered on session A's hostname is invalid on session B's hostname. This means:

- You must update both Console fields at the start of every new Arc Studio session.
- For production, deploy to a stable custom domain and set that as the Allowed Domain permanently. This is the only permanent fix.

### Debugging checklist

1. Open DevTools → Network → filter `modular-sdk`
   - `401` or `Invalid credentials` → Console domain not set
   - `CORS / no Access-Control-Allow-Origin` → same root cause
   - `Failed to fetch` → CORS preflight blocked

2. Test the key directly from the terminal:
   ```bash
   curl -s https://modular-sdk.circle.com/v1/rpc/w3s/buidl \
     -X POST -H "Content-Type: application/json" \
     -H "Authorization: Bearer $VITE_CLIENT_KEY" \
     -d '{"jsonrpc":"2.0","method":"rp_getRegistrationOptions","params":["test"],"id":1}'
   ```
   - `Invalid credentials` → key wrong or Passkey domain not saved
   - Valid JSON → key works, problem is domain or CORS elsewhere

---

## 4. Transport split — modular vs plain HTTP

### What happened

Using `toModularTransport` for the public client (contract reads) causes CORS errors on every page load and burns bundler quota on reads. Using plain `http` for the account creation client causes `circle_getUserOperationGasPrice` to fail ("method not supported"), which breaks gas estimation for every new wallet.

### The correct split

```ts
// CONTRACT READS — plain HTTP, fast, no quota
export const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: http(RPC_URL),  // hardcoded, not from chain definition
})

// ACCOUNT CREATION — must use modular transport
const modularPublicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: toModularTransport(`${CLIENT_URL}/${CHAIN_SLUG}`, CLIENT_KEY),
})
const smartAccount = await toCircleSmartAccount({
  client: modularPublicClient,  // NOT the plain publicClient
  owner,
})

// USER OPERATIONS — must use modular transport
const bundlerClient = createBundlerClient({
  account: smartAccount,
  chain: ACTIVE_CHAIN,
  transport: toModularTransport(`${CLIENT_URL}/${CHAIN_SLUG}`, CLIENT_KEY),
})
```

### Transport URL reference

| Transport | URL suffix | Used for |
|---|---|---|
| `toPasskeyTransport` | `${CLIENT_URL}` (no chain suffix) | register, login |
| `toModularTransport` | `${CLIENT_URL}/arcTestnet` or `/arc` | sendUserOperation, account creation |

### The VITE_CLIENT_URL env var

Must be the full URL, not a relative path:

```env
# CORRECT
VITE_CLIENT_URL=https://modular-sdk.circle.com/v1/rpc/w3s/buidl

# WRONG — SDK validateClientUrl rejects relative paths
VITE_CLIENT_URL=/circle-rpc
```

---

## 5. React hook reference stability — the RPC polling storm

### What happened

`useAproxContract(wallet)` returned a plain object literal. Its reference changed on every render. Any `useCallback` or `useEffect` listing `contract` as a dependency re-fired on every render, creating a tight polling loop that hit 429 rate limits on the Arc RPC within seconds of opening the app.

### The fix — memoize the returned object

```ts
// WRONG — new reference every render → polling storm → 429s
return { deposit, withdraw, openOrder, getFreeBalance, ... }

// CORRECT — stable reference, deps only change when functions actually change
return useMemo(() => ({
  deposit, withdraw, openOrder, getFreeBalance, ...
}), [deposit, withdraw, openOrder, getFreeBalance, ...])
```

### Corollary: post-transaction balance polling

After a confirmed UserOp receipt, Arc RPC nodes take up to ~10 seconds to propagate the new storage slot. If the UI immediately calls `getFreeBalance`, it reads the old value. Users see a successful transaction with no visible change, assume it failed, and try again. Fix: poll with a snapshot comparison, not a fixed delay.

```ts
async function pollUntilBalanceChanges(prevBalance: string, maxAttempts = 8, intervalMs = 1200) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const fresh = await contract.getFreeBalance(address)
    if (fresh !== prevBalance) {
      setFreeBalance(fresh)
      await refresh()
      return
    }
  }
  await refresh() // final fallback
}
```

---

## 6. Deposit architecture — the design decision that made everything else work

### Why V1 was hard

The first contract (`AproxPerp.sol`) required a protocol-owned `liquidityReserve`. The deployer had to pre-fund it at constructor time via `safeTransferFrom`. Every `openPosition` checked `required > liquidityReserve` and reverted if the reserve was insufficient.

With Circle Modular Wallets (a smart account, not an EOA), approving and funding in the constructor was genuinely difficult — the smart account address is counterfactual until first use, and the constructor call had to happen from the deployer's context. The reserve also had to be manually topped up after every string of profitable user trades.

### Why V2 solved it

V2 eliminated the reserve entirely. Users deposit their own USDC, it stays in the contract as their personal `freeBalance`, and orders are matched peer-to-peer. The protocol never risks its own capital.

The deposit is two calls in one UserOperation:

```ts
wallet.sendOp([
  { to: USDC_ADDRESS, data: encodeFunctionData('approve', [PERP_ADDRESS, amount]) },
  { to: PERP_ADDRESS, data: encodeFunctionData('deposit', [amount]) },
])
```

**Why both must be in one UserOp:** two separate UserOps create a nonce race — the approve lands in block N, the deposit attempts block N+1, but if the approve UserOp is still in the mempool the nonces conflict and the deposit reverts. One atomic UserOp with both calls eliminates the race entirely.

**Why `openOrder` needs no approve:** `openOrder` deducts from `freeBalance` — a pure storage write. USDC is already inside the contract. No token transfer, no allowance, one biometric prompt per trade.

**Why `permit` doesn't work:** USDC on Arc is the standard Circle USDC contract. Its `permit` (EIP-2612) requires an ECDSA EOA signature. Circle smart accounts are WebAuthn-based — there is no ECDSA key to produce a valid `permit` signature.

---

## 7. Contract scan — reading back your own orders

### The problem

The contract stores orders by numeric ID, not by trader address. There is no `getOrdersByTrader(address)` function. The frontend must scan backwards from `nextOrderId` to find a user's open orders.

### The working approach

Scan the last 200 IDs (enough for any realistic usage), skip closed/cancelled, stop on any read error:

```ts
const nextId = await publicClient.readContract({ functionName: 'nextOrderId' })
const scanFrom = nextId > 200n ? nextId - 200n : 1n

for (let id = nextId - 1n; id >= scanFrom; id--) {
  try {
    const order = await publicClient.readContract({ functionName: 'getOrder', args: [id] })
    if (order.trader.toLowerCase() !== trader.toLowerCase()) continue
    if (order.status === CLOSED || order.status === CANCELLED) continue
    active.push({ id, order })
  } catch { break }
}
```

Scan newest-first and break on read error — once you're past the valid ID range, reads throw.

---

## 8. The `createAddressMapping` step after register

### What happened

After a new passkey wallet is registered, subsequent `sendUserOperation` calls fail with "Cannot find target wallet in the system" unless the wallet address is explicitly registered with Circle's backend.

### The fix — always call `createAddressMapping` after register

```ts
const pubKey = parsePublicKey(credential.publicKey as `0x${string}`)
const modularClient = bundlerClient.extend(modularWalletActions)
await modularClient.createAddressMapping({
  walletAddress: smartAccount.address,
  owners: [{
    type: OwnerIdentifierType.WebAuthn,
    identifier: {
      publicKeyX: pubKey.x.toString(),
      publicKeyY: pubKey.y.toString(),
    },
  }],
})
```

If the mapping already exists, Circle returns an error containing "already", "exists", or "duplicate" — catch and ignore those; they are not failures.

---

## 9. The four failure modes that all look identical

The hardest part of debugging this project was that four completely independent problems produced the same visible symptom: "deposit / trading doesn't work."

| Root cause | Visible symptom |
|---|---|
| Dead `rpc.testnet.arc.network` DNS | Balance shows 0 after confirmed deposit |
| Bundler wrong gas estimates | "Missing or invalid parameters" on every UserOp |
| Circle Console domain not set | "Invalid credentials" on sendUserOperation |
| V1 reserve architecture | openPosition reverts |

If you see the app appear broken after a deposit: check the RPC endpoint first, before debugging the contract or the wallet code. The contract is almost certainly fine.

---

## 10. Brave browser and ad blockers

The Circle Modular Wallets SDK makes requests to `modular-sdk.circle.com`. Brave's shields and most content blockers block these as "trackers." The failure mode is `ERR_BLOCKED_BY_CLIENT` in the console — the SDK appears to hang or return nothing.

The fix is to use Chrome, Firefox, or Safari in a clean profile (no extensions). There is no in-app workaround. Document this prominently in the README and the app's onboarding flow.
