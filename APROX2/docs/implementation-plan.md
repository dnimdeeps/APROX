Let me read the current file one more time before rewriting, so I don't lose anything important. Good. I have the full picture. Now rewriting to match the docs exactly — account passed per-call, `paymaster: true`, no interceptor, no overrides, everything as simple as the reference shows.We're in Plan mode — I can't write code here. Let me save the plan so you can approve it and switch to Build mode to apply it.

Here is exactly what will be done:

---

## Implementation Plan: Deposit fix — match Circle docs exactly

### Summary
Rewrite `useModularWallet.ts` to match the Circle reference implementation exactly. Remove all custom paymaster interceptor code. Use `paymaster: true` with no overrides, and pass `account` per-call inside `sendUserOperation` rather than attaching it to the bundler client at creation.

### The one file that changes

**`src/hooks/useModularWallet.ts`** — full rewrite to match docs pattern:

1. `createBundlerClient` — `chain` + `transport` only, **no `account`** attached
2. `sendUserOperation({ account: smartAccount, calls, paymaster: true })` — account passed per-call, exactly as docs show
3. Remove: paymaster interceptor, `rawBundlerClient`, `getPaymasterData`, `getPaymasterStubData`, `GetPaymasterDataReturnType`, `maxPriorityFeePerGas` override — all gone
4. Keep: `buildAccount` helper, `createAddressMapping` on register, username sessionStorage persistence, login never writes credential back to sessionStorage (that was the signature bug)
5. Keep: hardcoded `RPC_URL` for `publicClient` reads, `ACTIVE_CHAIN` unchanged

### Done When
- `src/hooks/useModularWallet.ts` has no paymaster interceptor code
- `sendUserOperation` uses `{ account, calls, paymaster: true }` exactly as shown in Circle docs
- `check.sh` passes zero errors
- Deposit works on `aprox-2.vercel.app` after pushing

--- Plan saved. Switch to **Build mode** using the mode selector (or approve the plan) and it will apply the rewrite immediately — one file, clean and simple, exactly as the docs show.
