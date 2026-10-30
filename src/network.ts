/**
 * network.ts — Runtime network selection.
 *
 * VITE_NETWORK is a build-time env var (baked in at compile time).
 * To allow switching without a new build, we overlay it with a localStorage key.
 *
 * Priority: localStorage('aprox_network') > VITE_NETWORK > 'testnet'
 *
 * Switching networks rewrites localStorage then reloads the page so that all
 * module-level constants (chain clients, contract addresses) reinitialize on
 * the new chain.
 */

const LS_KEY = 'aprox_network'

/** The active network, resolved at module load time (stable for the lifetime of the page). */
export const NETWORK: 'testnet' | 'mainnet' = (() => {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
  if (stored === 'mainnet' || stored === 'testnet') return stored
  return (import.meta.env.VITE_NETWORK === 'mainnet') ? 'mainnet' : 'testnet'
})()

export const IS_MAINNET = NETWORK === 'mainnet'

/** Switch to the given network. Writes localStorage and reloads the page. */
export function switchNetwork(to: 'testnet' | 'mainnet'): void {
  if (to === NETWORK) return
  localStorage.setItem(LS_KEY, to)
  window.location.reload()
}
