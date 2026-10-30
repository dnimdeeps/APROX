/**
 * useAproxContract — typed interactions with AproxPerpV2.sol
 *
 * V2: peer-to-peer order book, partial fills, no reserve.
 * All writes fire as gasless user operations via useModularWallet().sendOp().
 * All reads use the public viem client directly.
 * Amounts parsed/formatted via @/onchain-money.
 */

import { useCallback, useMemo } from 'react'
import { encodeFunctionData, parseAbi, decodeFunctionResult, type Hex } from 'viem'
import { publicClient, ACTIVE_CHAIN } from './useModularWallet'
import { parseUsdc, formatUsdc } from '@/onchain-money'
import { getUsdc } from '@/onchain-facts'
import type { UseModularWalletReturn } from './useModularWallet'
import { IS_MAINNET } from '@/network'

// ── Multicall3 ────────────────────────────────────────────────────────────────
// Collapses N individual eth_call requests into a single RPC call.
// Multicall3 is deployed at the same canonical address on every EVM chain.
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex
const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
])

// Mainnet uses a separate contract deployment wired to Chainlink feeds.
const PERP_ADDRESS = (IS_MAINNET
  ? (import.meta.env.VITE_MAINNET_APROX_PERP_ADDRESS ?? '')
  : (import.meta.env.VITE_APROX_PERP_ADDRESS ?? '')) as Hex
// USDC address is the same on Arc Mainnet and Testnet (0x3600…0000) — resolved from chain facts
const USDC_ADDRESS = getUsdc(ACTIVE_CHAIN.id)?.address as Hex

// Trading pair IDs — read directly from AproxPerpV6's public constants
// (0xb420bc9a17ac2c3a0ec3383e8227f7253ba41f16 on Arc Testnet).
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

const PERP_ABI = parseAbi([
  // Write
  'function deposit(uint256 amount) external',
  'function withdraw(uint256 amount) external',
  'function openOrder(bool isLong, uint8 leverage, uint256 collateral, bytes32 pairId) external',
  'function closeOrder(uint256 orderId) external',
  'function cancelOrder(uint256 orderId) external',
  'function liquidate(uint256 orderId) external',
  // Read
  'function getOrder(uint256 orderId) external view returns ((address trader, bool isLong, uint8 leverage, uint256 collateral, uint256 matchedCollateral, uint256 pendingCollateral, int256 entryPrice, uint256 matchedAt, uint256 openedAt, bytes32 pairId, uint8 status))',
  'function getFreeBalance(address trader) external view returns (uint256)',
  'function getPendingQueueLength(bool isLong, uint8 leverage, bytes32 pairId) external view returns (uint256)',
  'function getPendingQueue(bool isLong, uint8 leverage, bytes32 pairId) external view returns (uint256[])',
  'function getOrderPairs(uint256 orderId) external view returns (uint256[])',
  'function getPair(uint256 pairId) external view returns ((uint256 longOrderId, uint256 shortOrderId, uint256 lockedCollateral, int256 longEntryPrice, int256 shortEntryPrice, bool settled))',
  'function getMarketDepth(uint8 leverage, bytes32 pairId) external view returns (uint256 pendingLong, uint256 pendingShort)',
  'function computeLivePnl(uint256 orderId) external view returns (int256 pnl)',
  'function nextOrderId() external view returns (uint256)',
  'function getStats(address trader) external view returns ((uint256 totalMatches, uint256 totalWins, uint256 totalLosses, uint256 totalVolume, uint256 winStreak, uint256 bestStreak))',
  'function totalMatches(address) external view returns (uint256)',
  'function totalWins(address) external view returns (uint256)',
  'function totalLosses(address) external view returns (uint256)',
  'function totalVolume(address) external view returns (uint256)',
  'function winStreak(address) external view returns (uint256)',
  'function bestStreak(address) external view returns (uint256)',
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
  pairId: Hex
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

export interface TraderStats {
  totalMatches: bigint
  totalWins: bigint
  totalLosses: bigint
  totalVolume: bigint
  winStreak: bigint
  bestStreak: bigint
}

export interface MarketDepth {
  pendingLong: string   // formatted USDC
  pendingShort: string  // formatted USDC
}

export interface DashboardSnapshot {
  freeBalance: string                           // formatted USDC
  activeOrders: Array<{ id: bigint; order: Order }>
}

export interface UseAproxContractReturn {
  deposit: (amountUsd: string) => Promise<Hex>
  withdraw: (amountUsd: string) => Promise<Hex>
  sendToAddress: (toAddress: Hex, amountUsd: string) => Promise<Hex>
  openOrder: (isLong: boolean, leverage: number, collateralUsd: string, pairId: Hex) => Promise<Hex>
  closeOrder: (orderId: bigint) => Promise<Hex>
  cancelOrder: (orderId: bigint) => Promise<Hex>
  liquidate: (orderId: bigint) => Promise<Hex>
  getOrder: (orderId: bigint) => Promise<Order>
  getActiveOrders: (trader: Hex) => Promise<Array<{ id: bigint; order: Order }>>
  /** Single multicall: nextOrderId + freeBalance + all getOrder — ONE RPC call. */
  refreshDashboard: (trader: Hex) => Promise<DashboardSnapshot>
  getFreeBalance: (trader: Hex) => Promise<string>
  getWalletUsdcBalance: (account: Hex) => Promise<string>
  getMarketDepth: (leverage: number, pairId: Hex) => Promise<MarketDepth>
  getOrderPairs: (orderId: bigint) => Promise<bigint[]>
  getPair: (pairId: bigint) => Promise<MatchedPair>
  computeLivePnl: (orderId: bigint) => Promise<string>
  getNextOrderId: () => Promise<bigint>
  getPendingQueue: (isLong: boolean, leverage: number, pairId: Hex) => Promise<bigint[]>
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
    async (isLong: boolean, leverage: number, collateralUsd: string, pairId: Hex): Promise<Hex> => {
      if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
      const collateral = parseUsdc(collateralUsd)
      return wallet.sendOp([
        {
          to: PERP_ADDRESS,
          data: encodeFunctionData({
            abi: PERP_ABI,
            functionName: 'openOrder',
            args: [isLong, leverage, collateral, pairId],
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
      pairId: (r.pairId ?? '0x') as Hex,
      status: r.status as OrderStatus,
    }
  }, [])

  // ── refreshDashboard ────────────────────────────────────────────────────────
  // Fetches nextOrderId + freeBalance + all getOrder calls in ONE multicall.
  // TradingPanel.refresh() calls this instead of separate getFreeBalance +
  // getActiveOrders — halves the number of RPC round-trips on every poll tick.
  const refreshDashboard = useCallback(async (trader: Hex): Promise<DashboardSnapshot> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')

    // 1. Get nextOrderId + freeBalance in one multicall
    const initCalls = [
      {
        target: PERP_ADDRESS,
        allowFailure: false as const,
        callData: encodeFunctionData({ abi: PERP_ABI, functionName: 'nextOrderId', args: [] }),
      },
      {
        target: PERP_ADDRESS,
        allowFailure: false as const,
        callData: encodeFunctionData({ abi: PERP_ABI, functionName: 'getFreeBalance', args: [trader] }),
      },
    ]
    const initResults = await publicClient.readContract({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [initCalls],
    }) as Array<{ success: boolean; returnData: Hex }>

    const nextId      = decodeFunctionResult({ abi: PERP_ABI, functionName: 'nextOrderId',   data: initResults[0].returnData }) as bigint
    const rawBalance  = decodeFunctionResult({ abi: PERP_ABI, functionName: 'getFreeBalance', data: initResults[1].returnData }) as bigint
    const freeBalance = formatUsdc(rawBalance)

    if (nextId <= 1n) return { freeBalance, activeOrders: [] }

    // 2. Scan last 50 order IDs in a second multicall
    const scanFrom = nextId > 50n ? nextId - 50n : 1n
    const ids: bigint[] = []
    for (let id = scanFrom; id < nextId; id++) ids.push(id)

    const orderCalls = ids.map(id => ({
      target: PERP_ADDRESS,
      allowFailure: true as const,
      callData: encodeFunctionData({ abi: PERP_ABI, functionName: 'getOrder', args: [id] }),
    }))
    const orderResults = await publicClient.readContract({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [orderCalls],
    }) as Array<{ success: boolean; returnData: Hex }>

    const activeOrders: Array<{ id: bigint; order: Order }> = []
    for (let i = 0; i < orderResults.length; i++) {
      const { success, returnData } = orderResults[i]
      if (!success || !returnData || returnData === '0x') continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = decodeFunctionResult({ abi: PERP_ABI, functionName: 'getOrder', data: returnData }) as any
        if (r.trader.toLowerCase() !== trader.toLowerCase()) continue
        if (r.status === OrderStatus.CLOSED || r.status === OrderStatus.CANCELLED) continue
        activeOrders.push({
          id: ids[i],
          order: {
            trader: r.trader, isLong: r.isLong, leverage: Number(r.leverage),
            collateral: r.collateral, matchedCollateral: r.matchedCollateral,
            pendingCollateral: r.pendingCollateral, entryPrice: BigInt(r.entryPrice),
            matchedAt: r.matchedAt, openedAt: r.openedAt,
            pairId: (r.pairId ?? '0x') as Hex, status: r.status as OrderStatus,
          },
        })
      } catch { continue }
    }
    return { freeBalance, activeOrders }
  }, [])

  const getActiveOrders = useCallback(async (trader: Hex): Promise<Array<{ id: bigint; order: Order }>> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')

    // Step 1: one call to get nextOrderId
    const nextId = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'nextOrderId', args: [],
    })
    if (nextId === 0n) return []

    // Step 2: build a single multicall that fetches all orders in one RPC round-trip.
    // Cap scan window at 50 — the public Arc Testnet RPC rejects payloads that are
    // too large (seen as "Request exceeds defined limit"). Active orders are always
    // near the top of the ID sequence, so scanning the last 50 is sufficient.
    const scanFrom = nextId > 50n ? nextId - 50n : 1n
    const ids: bigint[] = []
    for (let id = scanFrom; id < nextId; id++) ids.push(id)
    if (ids.length === 0) return []

    const calls = ids.map(id => ({
      target: PERP_ADDRESS,
      allowFailure: true,
      callData: encodeFunctionData({ abi: PERP_ABI, functionName: 'getOrder', args: [id] }),
    }))

    const results = await publicClient.readContract({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [calls],
    }) as Array<{ success: boolean; returnData: Hex }>

    // Step 3: decode and filter to this trader's active/pending orders
    const active: Array<{ id: bigint; order: Order }> = []
    for (let i = 0; i < results.length; i++) {
      const { success, returnData } = results[i]
      if (!success || !returnData || returnData === '0x') continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = decodeFunctionResult({ abi: PERP_ABI, functionName: 'getOrder', data: returnData }) as any
        if (r.trader.toLowerCase() !== trader.toLowerCase()) continue
        if (r.status === OrderStatus.CLOSED || r.status === OrderStatus.CANCELLED) continue
        active.push({
          id: ids[i],
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
            pairId: (r.pairId ?? '0x') as Hex,
            status: r.status as OrderStatus,
          },
        })
      } catch { continue }
    }
    return active
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

  const getMarketDepth = useCallback(async (leverage: number, pairId: Hex): Promise<MarketDepth> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    const r = await publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getMarketDepth', args: [leverage, pairId],
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

  const getPendingQueue = useCallback(async (isLong: boolean, leverage: number, pairId: Hex): Promise<bigint[]> => {
    if (!PERP_ADDRESS) throw new Error('VITE_APROX_PERP_ADDRESS not set')
    return publicClient.readContract({
      address: PERP_ADDRESS, abi: PERP_ABI, functionName: 'getPendingQueue', args: [isLong, leverage, pairId],
    }) as Promise<bigint[]>
  }, [])

  // Memoize the returned object so its reference is stable across renders.
  // Without this, TradingPanel re-creates `contract` on every render, which
  // destabilises the `refresh` useCallback dep and causes a polling storm.
  return useMemo(() => ({
    deposit, withdraw, sendToAddress, openOrder, closeOrder, cancelOrder, liquidate,
    getOrder, getActiveOrders, refreshDashboard, getFreeBalance, getWalletUsdcBalance,
    getMarketDepth, getOrderPairs, getPair, computeLivePnl, getNextOrderId, getPendingQueue,
  }), [
    deposit, withdraw, sendToAddress, openOrder, closeOrder, cancelOrder, liquidate,
    getOrder, getActiveOrders, refreshDashboard, getFreeBalance, getWalletUsdcBalance,
    getMarketDepth, getOrderPairs, getPair, computeLivePnl, getNextOrderId, getPendingQueue,
  ])
}
