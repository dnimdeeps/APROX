/**
 * useModularWallet — Circle Modular Wallets (ERC-4337) hook
 *
 * Follows the Circle docs reference exactly:
 * https://developers.circle.com/wallets/modular/transfer-tokens
 *
 * Key pattern:
 * - bundlerClient created with chain + transport only (no account attached)
 * - account passed per-call inside sendUserOperation({ account, calls, paymaster: true })
 * - paymaster: true with no overrides — exactly as shown in docs
 */

import { useState, useCallback, useRef } from 'react'
import { arc, arcTestnet } from 'viem/chains'
import { createPublicClient } from 'viem'
import { makeArcTransport } from '@/utils/retryTransport'
import { IS_MAINNET } from '@/network'
import { createBundlerClient, toWebAuthnAccount } from 'viem/account-abstraction'
import type { SmartAccount } from 'viem/account-abstraction'
import {
  WebAuthnMode,
  OwnerIdentifierType,
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  modularWalletActions,
  type WebAuthnCredential,
} from '@circle-fin/modular-wallets-core'
import { parsePublicKey } from 'webauthn-p256'

// Two separate Circle Client Keys — one per network.
// Testnet key: Modular Wallets → Client Keys → Network: arcTestnet.
// Mainnet key: Modular Wallets → Client Keys → Network: arc (Mainnet).
// Both keys must have the same Allowed Domain / Passkey Domain as the deployed app.
// VITE_CLIENT_KEY is kept as a fallback so existing Vercel/local setups don't break
// until both new vars are added.
const CLIENT_KEY = (IS_MAINNET
  ? (import.meta.env.VITE_CLIENT_KEY_MAINNET ?? import.meta.env.VITE_CLIENT_KEY)
  : (import.meta.env.VITE_CLIENT_KEY_TESTNET ?? import.meta.env.VITE_CLIENT_KEY)
) as string | undefined

const CLIENT_URL = import.meta.env.VITE_CLIENT_URL as string | undefined

// IS_MAINNET comes from @/network — resolved from localStorage override > VITE_NETWORK > testnet.
export const ACTIVE_CHAIN = IS_MAINNET ? arc : arcTestnet
const CHAIN_SLUG = IS_MAINNET ? 'arc' : 'arcTestnet'

// localStorage so credentials + username survive tab close and browser restart.
// sessionStorage is tab-scoped and is wiped on close — login would show no username.
const CREDENTIAL_STORAGE_KEY = 'aprox_passkey_credential'
const USERNAME_STORAGE_KEY = 'aprox_passkey_username'
const storage = typeof localStorage !== 'undefined' ? localStorage : sessionStorage

// Public client for all contract reads (balance, orders, market depth).
// makeArcTransport picks the RPC proxy when available (Vercel / Arc Studio
// environments set VITE_RPC_PROXY_BASE_URL + VITE_RPC_PROXY_TOKEN), and
// falls back to the public Arc endpoint with retry/backoff + JSON-RPC batching.
// This is the single source of truth for RPC — do NOT create additional
// createPublicClient instances elsewhere in the app.
export const publicClient = createPublicClient({
  chain: ACTIVE_CHAIN,
  transport: makeArcTransport(IS_MAINNET),
})

export type WalletStatus = 'idle' | 'registering' | 'logging-in' | 'ready' | 'error'

export interface UseModularWalletReturn {
  account: SmartAccount | null
  address: string | null
  username: string | null
  status: WalletStatus
  error: string | null
  register: (username: string) => Promise<void>
  login: () => Promise<void>
  logout: () => void
  sendOp: (calls: Array<{ to: `0x${string}`; data: `0x${string}`; value?: bigint }>) => Promise<`0x${string}`>
}

export function useModularWallet(): UseModularWalletReturn {
  const [account, setAccount] = useState<SmartAccount | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  // Initialise from localStorage so username survives tab close and browser restart
  const [username, setUsername] = useState<string | null>(() => {
    const v = storage.getItem(USERNAME_STORAGE_KEY)
    return v && v !== 'null' && v !== 'undefined' ? v : null
  })
  const [status, setStatus] = useState<WalletStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  // Refs hold the live account and bundler client — rebuilt on every register/login
  const accountRef = useRef<SmartAccount | null>(null)
  const bundlerClientRef = useRef<ReturnType<typeof createBundlerClient> | null>(null)

  // buildAccount: creates the smart account and bundler client from a credential.
  // Docs pattern: bundlerClient has NO account attached at creation;
  // account is passed per-call inside sendUserOperation.
  const buildAccount = useCallback(async (credential: WebAuthnCredential) => {
    if (!CLIENT_KEY || !CLIENT_URL) throw new Error('VITE_CLIENT_KEY or VITE_CLIENT_URL is missing')

    const modularTransport = toModularTransport(`${CLIENT_URL}/${CHAIN_SLUG}`, CLIENT_KEY)

    // toCircleSmartAccount MUST use a client with modularTransport — it calls
    // circle_getUserOperationGasPrice internally. Using the plain http publicClient
    // causes that call to fail with "method not supported".
    const modularPublicClient = createPublicClient({
      chain: ACTIVE_CHAIN,
      transport: modularTransport,
    })

    const smartAccount = await toCircleSmartAccount({
      client: modularPublicClient,
      owner: toWebAuthnAccount({ credential }),
    })

    // Docs pattern: bundlerClient created with chain + transport ONLY.
    // No account attached here — account is passed per sendUserOperation call.
    const bundlerClient = createBundlerClient({
      chain: ACTIVE_CHAIN,
      transport: modularTransport,
    })

    accountRef.current = smartAccount
    bundlerClientRef.current = bundlerClient
    setAccount(smartAccount)
    setAddress(smartAccount.address)

    return { smartAccount, bundlerClient }
  }, [])

  const register = useCallback(
    async (usernameInput: string) => {
      setStatus('registering')
      setError(null)
      try {
        if (!CLIENT_KEY || !CLIENT_URL) throw new Error('VITE_CLIENT_KEY is missing — check .env')

        const passkeyTransport = toPasskeyTransport(CLIENT_URL, CLIENT_KEY)
        const credential: WebAuthnCredential = await toWebAuthnCredential({
          transport: passkeyTransport,
          mode: WebAuthnMode.Register,
          username: usernameInput,
        })

        storage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(credential))
        storage.setItem(USERNAME_STORAGE_KEY, usernameInput)
        setUsername(usernameInput)

        const { smartAccount, bundlerClient } = await buildAccount(credential)

        // Store address → username mapping so login can recover username by address
        storage.setItem(`aprox_username_${smartAccount.address.toLowerCase()}`, usernameInput)

        // Register the smart account address with Circle's backend so the
        // bundler can process user operations for it. Without this, subsequent
        // sendUserOperation calls fail with "Cannot find target wallet in the
        // system" for any account that hasn't previously been used.
        try {
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
        } catch (mappingErr) {
          // Circle returns an error if the mapping already exists — safe to ignore.
          const msg = mappingErr instanceof Error ? mappingErr.message : ''
          if (!msg.includes('already') && !msg.includes('exists') && !msg.includes('duplicate')) {
            console.warn('[useModularWallet] createAddressMapping failed (non-fatal):', msg)
          }
        }

        setStatus('ready')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Registration failed'
        setError(msg)
        setStatus('error')
        throw err
      }
    },
    [buildAccount],
  )

  const login = useCallback(async () => {
    setStatus('logging-in')
    setError(null)
    try {
      if (!CLIENT_KEY || !CLIENT_URL) throw new Error('VITE_CLIENT_KEY is missing — check .env')

      // Always prompt the biometric — never restore from sessionStorage.
      // Each login must produce a fresh credential from the browser.
      const passkeyTransport = toPasskeyTransport(CLIENT_URL, CLIENT_KEY)
      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode: WebAuthnMode.Login,
      })

      // NOTE: do NOT write credential back to storage here.
      // Overwriting with the login object caused "account signature check failed"
      // because the login credential can differ from the registered one.

      const { smartAccount } = await buildAccount(credential)

      // Restore username — three sources in order:
      // 1. USERNAME_STORAGE_KEY (set on register)
      // 2. address → username mapping (survives if #1 cleared)
      // 3. credential object (some Circle SDK versions return username on login)
      const addrKey = `aprox_username_${smartAccount.address.toLowerCase()}`
      const clean = (v: string | null | undefined) => (v && v !== 'null' && v !== 'undefined' ? v : null)
      const savedUsername = clean(storage.getItem(USERNAME_STORAGE_KEY))
        ?? clean(storage.getItem(addrKey))
        ?? clean((credential as { username?: string }).username)
      if (savedUsername) {
        setUsername(savedUsername)
        storage.setItem(USERNAME_STORAGE_KEY, savedUsername)
        storage.setItem(addrKey, savedUsername)
      }

      setStatus('ready')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed'
      setError(msg)
      setStatus('error')
      throw err
    }
  }, [buildAccount])

  const logout = useCallback(() => {
    storage.removeItem(CREDENTIAL_STORAGE_KEY)
    storage.removeItem(USERNAME_STORAGE_KEY)
    accountRef.current = null
    bundlerClientRef.current = null
    setAccount(null)
    setAddress(null)
    setUsername(null)
    setStatus('idle')
    setError(null)
  }, [])

  const sendOp = useCallback(
    async (calls: Array<{ to: `0x${string}`; data: `0x${string}`; value?: bigint }>): Promise<`0x${string}`> => {
      const bundlerClient = bundlerClientRef.current
      const smartAccount = accountRef.current
      if (!bundlerClient || !smartAccount) throw new Error('Wallet not connected — register or login first')

      // Circle docs pattern exactly:
      //   bundlerClient.sendUserOperation({ account, calls, paymaster: true })
      // account is passed here, not at bundlerClient creation time.
      // paymaster: true sponsors gas via Circle Gas Station — no overrides needed.
      const userOpHash = await bundlerClient.sendUserOperation({
        account: smartAccount,
        calls,
        paymaster: true,
      })

      const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash })
      return receipt.transactionHash
    },
    [],
  )

  return { account, address, username, status, error, register, login, logout, sendOp }
}
