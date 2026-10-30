/**
 * useAproxContract — typed interactions with AproxPerpV2.sol
 *
 * V2: peer-to-peer order book, partial fills, no reserve.
 * All writes fire as gasless user operations via useModularWallet().sendOp().
 * All reads use the public viem client directly.
 * Amounts parsed/formatted via @/onchain-money.
 */

import { useCallback, useMemo } from 'react'
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { publicClient, ACTIVE_CHAIN } from './useModularWallet'
import { parseUsdc, formatUsdc } from '@/onchain-money'
import { getUsdc } from '@/onchain-facts'
import type { UseModularWalletReturn } from './useModularWallet'

const PERP_ADDRESS = (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '') as Hex
// USDC address is the same on Arc Mainnet and Testnet (0x3600…0000) — resolved from chain facts
const USDC_ADDRESS = getUsdc(ACTIVE_CHAIN.id)?.address as Hex

// Trading pair IDs — read directly from the live contract's public constants
// (0x86d7e2b9777af45397112c361cbb8bc1dd45cc5c on Arc Testnet).
// Solidity keccak256("string literal") produces a different hash than
// viem keccak256(toBytes('...')) because Solidity hashes the ABI-packed
// encoding (no length prefix), while viem's toBytes adds a UTF-8 byte array
// that can differ. Hardcoding the on-chain values avoids any mismatch.
export const PAIR_BTC_USD: Hex = '0xee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489'
export const PAIR_ETH_USD: Hex = '0x0b43555ace6b39aae1b894097d0a9fc17f504c62fea598fa206cc6f5088e6e45'
export const PAIR_SOL_USD: Hex = '0x2b1b43ec7f6691d6bf679978bab5c093fa45ee74c0baac6cc75649dc59cc21d3'

export const TRADING_PAIRS = [
  { id: PAIR_BTC_USD, label: 'BTC/USD', symbol: 'BTC' },
  { id: PAIR_ETH_USD, label: 'ETH/USD', symbol: 'ETH' },
  { id: PAIR_SOL_USD, label: 'SOL/USD', symbol: 'SOL' },
] as const

// ── ABI ──────────────────────────────────────────────────────────────────────

// ABI matches the deployed AproxPerpV2 on Arc Mainnet (0x8692b92b7cB46e1e86EC428A62EB803E4c1d2e48).
// openOrder takes 3 args — no pairId. getPendingQueueLength / getPendingQueue / getMarketDepth
// also take 2 args — no pairId. The Order struct has no pairId field either.
const PERP_ABI = parseAbi([
  // Write
  'function deposit(uint256 amount) external',
  'function withdraw(uint256 amount) external',
  'function openOrder(bool isLong, uint8 leverage, uint256 collateral) external',
  'function closeOrder(uint256 orderId) external',
  'function cancelOrder(uint256 orderId) external',
  'function liquidate(uint256 orderId) external',
  // Read
  'function getOrder(uint256 orderId) external view returns ((address trader, bool isLong, uint8 leverage, uint256 collateral, uint256 matchedCollateral, uint256 pendingCollateral, int256 entryPrice, uint256 matchedAt, uint256 openedAt, uint8 status))',
  'function getFreeBalance(address trader) external view returns (uint256)',
  'function getPendingQueueLength(bool isLong, uint8 leverage) external view returns (uint256)',
  'function getPendingQueue(bool isLong, uint8 leverage) external view returns (uint256[])',
  'function getOrderPairs(uint256 orderId) external view returns (uint256[])',
  'function getPair(uint256 pairId) external view returns ((uint256 longOrderId, uint256 shortOrderId, uint256 lockedCollateral, int256 longEntryPrice, int256 shortEntryPrice, bool settled))',
  'function getMarketDepth(uint8 leverage) external view returns (uint256 pendingLong, uint256 pendingShort)',
  'function computeLivePnl(uint256 orderId) external view returns (int256 pnl)',
  'function nextOrderId() external view returns (uint256)',
])

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
])

// ── Types ─────────────────────────────────────────────────────────────────────

export enum OrderStatus {
  PENDING = 0,
  ACTIVE = 1,
  CLOSED = 2,
  CANCELLED = 3,
}

export interface Order {
  trader: string
  isLong: boolean
  leverage: number
  collateral: bigint
  matchedCollateral: bigint
  pendingCollateral: bigint
  entryPrice: bigint
  matchedAt: bigint
  openedAt: bigint
  status: OrderStatus
}

export interface MatchedPair {
  longOrderId: bigint
  shortOrderId: bigint
  lockedCollateral: bigint
  longEntryPrice: bigint
  shortEntryPrice: bigint
  settled: boolean
}

export interface MarketDepth {
  pendingLong: string   // formatted USDC
  pendingShort: string  // formatted USDC
}

export interface UseAproxContractReturn {
  deposit: (amountUsd: string) => Promise<Hex>
  withdraw: (amountUsd: string) => Promise<Hex>
  sendToAddress: (toAddress: Hex, amountUsd: string) => Promise<Hex>
  openOrder: (isLong: boolean, leverage: number, collateralUsd: string) => Promise<Hex>
  closeOrder: (orderId: bigint) => Promise<Hex>
  cancelOrder: (orderId: bigint) => Promise<Hex>
  liquidate: (orderId: bigint) => Promise<Hex>
  getOrder: (orderId: bigint) => Promise<Order>
  getActiveOrders: (trader: Hex) => Promise<Array<{ id: bigint; order: Order }>>
  getFreeBalance: (trader: Hex) => Promise<string>
  getWalletUsdcBalance: (account: Hex) => Promise<string>
  getMarketDepth: (leverage: number) => Promise<MarketDepth>
  getOrderPairs: (orderId: bigint) => Promise<bigint[]>
  getPair: (pairId: bigint) => Promise<MatchedPair>
  computeLivePnl: (orderId: bigint) => Promise<string>
  getNextOrderId: () => Promise<bigint>
  getPendingQueue: (isLong: boolean, leverage: number) => Promise<bigint[]>
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAproxContract(wallet: UseModularWalletReturn): UseAproxContractReturn {

  const deposit = useCallback(
    async (amountUsd: string): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      const amount = parseUsdc(amountUsd)
      return wallet.sendOp([
        {
          to: USDC_ADDRESS,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERP_ADDRESS, amount] }),
        },
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({ abi: PERP_ABI, functionName: 'deposit', args: [amount] }),
        },
      ])
    },
    [wallet],
  )

  const withdraw = useCallback(
    async (amountUsd: string): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      const amount = parseUsdc(amountUsd)
      return wallet.sendOp([
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({ abi: PERP_ABI, functionName: 'withdraw', args: [amount] }),
        },
      ])
    },
    [wallet],
  )

  // Send USDC directly from the smart account to any external address (e.g. MetaMask).
  // This is a plain ERC-20 transfer — no contract interaction, just moves USDC out.
  const sendToAddress = useCallback(
    async (toAddress: Hex, amountUsd: string): Promise<Hex> => {
      const amount = parseUsdc(amountUsd)
      return wallet.sendOp([
        {
          to: USDC_ADDRESS,
          data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [toAddress, amount] }),
        },
      ])
    },
    [wallet],
  )

  const openOrder = useCallback(
    async (isLong: boolean, leverage: number, collateralUsd: string): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      const collateral = parseUsdc(collateralUsd)
      return wallet.sendOp([
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({
            abi: PERP_ABI,
            functionName: 'openOrder',
            args: [isLong, leverage, collateral],
          }),
        },
      ])
    },
    [wallet],
  )

  const closeOrder = useCallback(
    async (orderId: bigint): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      return wallet.sendOp([
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({ abi: PERP_ABI, functionName: 'closeOrder', args: [orderId] }),
        },
      ])
    },
    [wallet],
  )

  const cancelOrder = useCallback(
    async (orderId: bigint): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      return wallet.sendOp([
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({ abi: PERP_ABI, functionName: 'cancelOrder', args: [orderId] }),
        },
      ])
    },
    [wallet],
  )

  const liquidate = useCallback(
    async (orderId: bigint): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      return wallet.sendOp([
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({ abi: PERP_ABI, functionName: 'liquidate', args: [orderId] }),
        },
      ])
    },
    [wallet],
  )

  const getOrder = useCallback(async (orderId: bigint): Promise<Order> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getOrder', args: [orderId],
    }) as any
    return {
      trader: r.trader,
      isLong: r.isLong,
      leverage: Number(r.leverage),
      collateral: r.collateral,
      matchedCollateral: r.matchedCollateral,
      pendingCollateral: r.pendingCollateral,
      entryPrice: BigInt(r.entryPrice),
      matchedAt: r.matchedAt,
      openedAt: r.openedAt,
      status: r.status as OrderStatus,
    }
  }, [])

  const getActiveOrders = useCallback(async (trader: Hex): Promise<Array<{ id: bigint; order: Order }>> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    const nextId = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'nextOrderId', args: [],
    })
    const scanFrom = nextId > 200n ? nextId - 200n : 1n
    const active: Array<{ id: bigint; order: Order }> = []
    for (let id = nextId - 1n; id >= scanFrom; id--) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await publicClient.readContract({
          address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getOrder', args: [id],
        }) as any
        if (r.trader.toLowerCase() !== trader.toLowerCase()) continue
        if (r.status === OrderStatus.CLOSED || r.status === OrderStatus.CANCELLED) continue
        active.push({
          id,
          order: {
            trader: r.trader,
            isLong: r.isLong,
            leverage: Number(r.leverage),
            collateral: r.collateral,
            matchedCollateral: r.matchedCollateral,
            pendingCollateral: r.pendingCollateral,
            entryPrice: BigInt(r.entryPrice),
            matchedAt: r.matchedAt,
            openedAt: r.openedAt,
            status: r.status as OrderStatus,
          },
        })
      } catch { break }
    }
    // Return oldest first so cards render in chronological order
    return active.reverse()
  }, [])

  const getFreeBalance = useCallback(async (trader: Hex): Promise<string> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    const raw = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getFreeBalance', args: [trader],
    })
    return formatUsdc(raw)
  }, [])

  // Raw USDC balance held directly by the smart account (before deposit into the contract)
  const getWalletUsdcBalance = useCallback(async (account: Hex): Promise<string> => {
    const raw = await publicClient.readContract({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [account],
    })
    return formatUsdc(raw)
  }, [])

  const getMarketDepth = useCallback(async (leverage: number): Promise<MarketDepth> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    const r = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getMarketDepth', args: [leverage],
    }) as [bigint, bigint]
    return {
      pendingLong: formatUsdc(r[0]),
      pendingShort: formatUsdc(r[1]),
    }
  }, [])

  const getOrderPairs = useCallback(async (orderId: bigint): Promise<bigint[]> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    return publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getOrderPairs', args: [orderId],
    }) as Promise<bigint[]>
  }, [])

  const getPair = useCallback(async (pairId: bigint): Promise<MatchedPair> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    const r = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getPair', args: [pairId],
    })
    return {
      longOrderId: r.longOrderId,
      shortOrderId: r.shortOrderId,
      lockedCollateral: r.lockedCollateral,
      longEntryPrice: BigInt(r.longEntryPrice),
      shortEntryPrice: BigInt(r.shortEntryPrice),
      settled: r.settled,
    }
  }, [])

  const computeLivePnl = useCallback(async (orderId: bigint): Promise<string> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    const raw = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'computeLivePnl', args: [orderId],
    })
    // raw is signed int256 in 6-decimal USDC
    const pnlUsdc = Number(raw) / 1e6
    return pnlUsdc.toFixed(4)
  }, [])

  const getNextOrderId = useCallback(async (): Promise<bigint> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    return publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'nextOrderId', args: [],
    })
  }, [])

  const getPendingQueue = useCallback(async (isLong: boolean, leverage: number): Promise<bigint[]> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    return publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getPendingQueue', args: [isLong, leverage],
    }) as Promise<bigint[]>
  }, [])

  // Memoize the returned object so its reference is stable across renders.
  // Without this, TradingPanel re-creates `contract` on every render, which
  // destabilises the `refresh` useCallback dep and causes a polling storm.
  return useMemo(() => ({
    deposit, withdraw, sendToAddress, openOrder, closeOrder, cancelOrder, liquidate,
    getOrder, getActiveOrders, getFreeBalance, getWalletUsdcBalance, getMarketDepth,
    getOrderPairs, getPair, computeLivePnl, getNextOrderId, getPendingQueue,
  }), [
    deposit, withdraw, sendToAddress, openOrder, closeOrder, cancelOrder, liquidate,
    getOrder, getActiveOrders, getFreeBalance, getWalletUsdcBalance, getMarketDepth,
    getOrderPairs, getPair, computeLivePnl, getNextOrderId, getPendingQueue,
  ])
}
