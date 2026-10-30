/**
 * Registers ETH/USD and SOL/USD price feed addresses on AproxPerpV7.
 * Run with: bun scripts/register-feeds.ts
 * Requires OPERATOR_PRIVATE_KEY in .env (must be the contract owner = 0x5B12…)
 */
import { createWalletClient, createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
})

const PERP_ADDRESS  = '0x6bde88771951062eca0c66782880c5966951f72f' as `0x${string}`
const ETH_FEED      = '0x3ce2107b718aacc782ccd2b4296a39946db0d8ad' as `0x${string}`
const SOL_FEED      = '0x80a5efaf6ea0b85423019d0d0dc8de25347aac6f' as `0x${string}`

const ABI = parseAbi([
  'function setPriceFeed(bytes32 pairId, address feed) external',
  'function PAIR_ETH_USD() external view returns (bytes32)',
  'function PAIR_SOL_USD() external view returns (bytes32)',
])

const key = process.env.OPERATOR_PRIVATE_KEY as `0x${string}`
if (!key) throw new Error('OPERATOR_PRIVATE_KEY not set')

const account = privateKeyToAccount(key)
const client  = createWalletClient({ account, chain: arcTestnet, transport: http() })
const pub     = createPublicClient({ chain: arcTestnet, transport: http() })

const ethPairId = await pub.readContract({ address: PERP_ADDRESS, abi: ABI, functionName: 'PAIR_ETH_USD' })
const solPairId = await pub.readContract({ address: PERP_ADDRESS, abi: ABI, functionName: 'PAIR_SOL_USD' })

console.log('ETH pair ID:', ethPairId)
console.log('SOL pair ID:', solPairId)

const h1 = await client.writeContract({ address: PERP_ADDRESS, abi: ABI, functionName: 'setPriceFeed', args: [ethPairId, ETH_FEED] })
console.log('setPriceFeed(ETH/USD):', h1)

const h2 = await client.writeContract({ address: PERP_ADDRESS, abi: ABI, functionName: 'setPriceFeed', args: [solPairId, SOL_FEED] })
console.log('setPriceFeed(SOL/USD):', h2)

console.log('Done.')
