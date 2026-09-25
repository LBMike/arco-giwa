// Informational reads only. This cannot authorize an order, token approval or faucet request.
import { erc20Abi, getAddress, hexToNumber, parseAbi, toFunctionSelector, type Address, type Hex } from "viem"
import { publicGiwaClient } from "../contracts"
import { address, ensure, integer, validateDeployment } from "../stocks-wallet/planner"
import { PLATFORM_TUSDC, type ReviewedDeployment } from "../stocks-wallet/types"

// Existing platform faucet from deployments/91342/arco-giwa-preprod.json. Never a new faucet.
export const PLATFORM_FAUCET = "0x785918816f5f5ed6a8c5edf5e223f14223bf41bc" as const
const faucetAbi = parseAbi([
  "function assetConfigs(address) view returns (uint256 dripAmount,uint256 dailyCap,uint256 globalCap,uint256 cooldown,bool enabled)",
  "function lastDripAt(address,address) view returns (uint256)",
  "function mintedByDay(address,uint256) view returns (uint256)",
  "function totalMintedByAsset(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function fnPaused(bytes4) view returns (bool)",
])
export type FundingBlock = { number: bigint; hash: Hex; timestamp: bigint }
export type FundingRpc = {
  chainId(): Promise<number>
  block(blockNumber?: bigint): Promise<FundingBlock>
  token(token: Address, owner: Address, blockNumber: bigint): Promise<{ balance: bigint; decimals: number; symbol: string }>
  gas(owner: Address, blockNumber: bigint): Promise<bigint>
  faucet(token: Address, owner: Address, block: FundingBlock): Promise<FaucetFacts>
}
export type FaucetFacts = { config: readonly [bigint, bigint, bigint, bigint, boolean]; lastDrip: bigint; today: bigint; total: bigint; paused: boolean; dripAllPaused: boolean }
export type FaucetRead = { status: "AVAILABLE" | "COOLDOWN" | "DAILY_CAP" | "TOTAL_CAP" | "PAUSED" | "DISABLED" | "UNAVAILABLE"; amount: string | null; remainingSeconds: string | null }
/** Addresses are the verified deployment's (lowercase): where a Buy's tUSDC and a Sell's NVDA go, and the NVDA token. */
export type FundingRead = { cashSymbol: "tUSDC"; balance: string; gas: string; blockNumber: string; faucet: FaucetRead; cashToken: string; fundingVault: string; redemptionEscrow: string; stockToken: string }
const unavailableFaucet = (): FaucetRead => ({ status: "UNAVAILABLE", amount: null, remainingSeconds: null })
const rawAmount = (value: bigint) => { ensure(typeof value === "bigint" && value >= 0n, "INVALID_FUNDING_READ"); return integer(value.toString(), true).toString() }

export function classifyFaucet(facts: FaucetFacts, block: FundingBlock): FaucetRead {
  const [drip, daily, cap, cooldown, enabled] = facts.config
  for (const value of [drip, daily, cap, cooldown, facts.lastDrip, facts.today, facts.total, block.timestamp]) rawAmount(value)
  ensure(typeof enabled === "boolean" && typeof facts.paused === "boolean" && typeof facts.dripAllPaused === "boolean", "INVALID_FUNDING_READ")
  const amount = drip.toString()
  const answer = (status: FaucetRead["status"], remainingSeconds: string | null = null): FaucetRead => ({ status, amount, remainingSeconds })
  if (facts.paused || facts.dripAllPaused) return answer("PAUSED")
  if (!enabled || drip === 0n) return answer("DISABLED")
  if (block.timestamp < facts.lastDrip || block.timestamp - facts.lastDrip < cooldown) {
    return answer("COOLDOWN", (facts.lastDrip + cooldown - block.timestamp).toString())
  }
  if (facts.today > daily || drip > daily - facts.today) return answer("DAILY_CAP")
  if (facts.total > cap || drip > cap - facts.total) return answer("TOTAL_CAP")
  return answer("AVAILABLE")
}

// Every read here sends a params array. The local customer gateway (/__giwa/read-rpc) forwards only calls that carry
// one, and viem's getChainId/getBlockNumber omit params, so those were refused there before any balance was read.
const giwaRequest = publicGiwaClient.request as unknown as (args: { method: "eth_chainId"; params: [] }) => Promise<unknown>
export const platformFundingRpc: FundingRpc = {
  async chainId() {
    const value = await giwaRequest({ method: "eth_chainId", params: [] })
    ensure(typeof value === "string" && /^0x[\da-f]{1,13}$/i.test(value), "INVALID_FUNDING_READ")
    return hexToNumber(value as Hex)
  },
  async block(blockNumber) {
    // GIWA's head, like the wallet read: Stocks settles on GIWA confirmation, not on Ethereum finality.
    const block = await publicGiwaClient.getBlock(blockNumber === undefined ? { blockTag: "latest" } : { blockNumber })
    ensure(block.number !== null && block.hash !== null, "INVALID_FUNDING_READ")
    return { number: block.number, hash: block.hash, timestamp: block.timestamp }
  },
  async token(token, owner, blockNumber) {
    const [balance, decimals, symbol] = await Promise.all([
      publicGiwaClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber }),
      publicGiwaClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber }),
      publicGiwaClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol", blockNumber }),
    ])
    return { balance, decimals, symbol }
  },
  gas: (owner, blockNumber) => publicGiwaClient.getBalance({ address: owner, blockNumber }),
  async faucet(token, owner, block) {
    const request = { address: getAddress(PLATFORM_FAUCET), abi: faucetAbi, blockNumber: block.number }
    const [config, lastDrip, today, total, paused, dripAllPaused] = await Promise.all([
      publicGiwaClient.readContract({ ...request, functionName: "assetConfigs", args: [token] }),
      publicGiwaClient.readContract({ ...request, functionName: "lastDripAt", args: [token, owner] }),
      publicGiwaClient.readContract({ ...request, functionName: "mintedByDay", args: [token, block.timestamp / 86400n] }),
      publicGiwaClient.readContract({ ...request, functionName: "totalMintedByAsset", args: [token] }),
      publicGiwaClient.readContract({ ...request, functionName: "paused" }),
      publicGiwaClient.readContract({ ...request, functionName: "fnPaused", args: [toFunctionSelector("dripAll()")] }),
    ])
    return { config, lastDrip, today, total, paused, dripAllPaused }
  },
}

export async function readTusdcFunding(options: { deployment: ReviewedDeployment; wallet: string; rpc: FundingRpc; current(): boolean; now(): number }): Promise<FundingRead> {
  const { deployment, rpc } = options
  const check = () => { ensure(options.current(), "CONTEXT_CHANGED"); validateDeployment(deployment, options.now()) }
  check()
  const m = deployment.manifest
  ensure(m.schemaVersion === 3, "INVALID_DEPLOYMENT")
  const owner = address(options.wallet)
  ensure(await rpc.chainId() === 91342, "INVALID_FUNDING_NETWORK"); check()
  const checkpoint = await rpc.block(BigInt(m.checkpointNumber)); check()
  ensure(checkpoint.number.toString() === m.checkpointNumber && checkpoint.hash.toLowerCase() === m.checkpointHash.toLowerCase(), "INVALID_FUNDING_NETWORK")
  const block = await rpc.block(); check()
  ensure(block.number >= checkpoint.number, "INVALID_FUNDING_NETWORK")
  const [token, gas, faucet] = await Promise.all([
    rpc.token(address(m.cashToken), owner, block.number),
    rpc.gas(owner, block.number),
    rpc.faucet(address(m.cashToken), owner, block).then(facts => classifyFaucet(facts, block)).catch(unavailableFaucet),
  ])
  check()
  ensure(token.decimals === 6 && token.symbol === "tUSDC", "INVALID_FUNDING_TOKEN")
  ensure(await rpc.chainId() === 91342, "INVALID_FUNDING_NETWORK"); check()
  return {
    cashSymbol: "tUSDC", balance: rawAmount(token.balance), gas: rawAmount(gas), blockNumber: block.number.toString(), faucet,
    cashToken: address(m.cashToken).toLowerCase(), fundingVault: address(m.fundingVault).toLowerCase(), redemptionEscrow: address(m.redemptionEscrow).toLowerCase(), stockToken: address(m.stockToken).toLowerCase(),
  }
}

/**
 * The connected wallet's tUSDC at the chain head: what it can pay with now, and what its wallet app shows. With a
 * spender (the verified deployment's funding vault) also the allowance it has already given that vault; with the
 * verified NVDA token and redemption escrow also its NVDA and the allowance given to that escrow (for Sell).
 */
export type WalletCashRead = {
  cashSymbol: "tUSDC"; balance: string; blockNumber: string; spender: string | null; allowance: string | null
  stockBalance: string | null; stockSpender: string | null; stockAllowance: string | null
  /** The wallet's GIWA test ETH (wei) at the same block, when asked for: a trade needs gas. */
  gas?: string
}
export type WalletStockScope = { token: string; spender: string }
export type WalletCashRpc = Pick<FundingRpc, "chainId" | "token"> & Partial<Pick<FundingRpc, "gas">> & {
  latestBlock(): Promise<bigint>
  allowance?(token: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<bigint>
}

export const platformWalletCashRpc: WalletCashRpc = {
  chainId: platformFundingRpc.chainId,
  token: platformFundingRpc.token,
  async latestBlock() {
    const block = await publicGiwaClient.getBlock({ blockTag: "latest" })
    ensure(block.number !== null, "INVALID_FUNDING_READ")
    return block.number
  },
  allowance: (token, owner, spender, blockNumber) => publicGiwaClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender], blockNumber }),
  gas: platformFundingRpc.gas,
}

/**
 * Public and read-only, like the Funds panel's balance: the registry tUSDC (PLATFORM_TUSDC, the only cash a v3 deployment
 * accepts) held by one wallet on chain 91342, read at one head block. It needs no Stocks session and authorizes nothing.
 */
export async function readWalletTusdc(options: { wallet: string; rpc: WalletCashRpc; current(): boolean; spender?: string | null; stock?: WalletStockScope | null; gas?: boolean }): Promise<WalletCashRead> {
  const { rpc } = options
  const check = () => ensure(options.current(), "CONTEXT_CHANGED")
  const owner = address(options.wallet)
  const spender = options.spender ? address(options.spender) : null
  const stock = options.stock ? { token: address(options.stock.token), spender: address(options.stock.spender) } : null
  ensure(await rpc.chainId() === 91342, "INVALID_FUNDING_NETWORK"); check()
  const head = await rpc.latestBlock(); check()
  ensure(typeof head === "bigint" && head > 0n, "INVALID_FUNDING_READ")
  const [token, allowance, units, stockAllowance, gas] = await Promise.all([
    rpc.token(address(PLATFORM_TUSDC), owner, head),
    spender && rpc.allowance ? rpc.allowance(address(PLATFORM_TUSDC), owner, spender, head) : Promise.resolve(null),
    stock ? rpc.token(stock.token, owner, head) : Promise.resolve(null),
    stock && rpc.allowance ? rpc.allowance(stock.token, owner, stock.spender, head) : Promise.resolve(null),
    // Gas is advice only: a failed read leaves it out instead of failing the balance.
    options.gas && rpc.gas ? rpc.gas(owner, head).catch(() => null) : Promise.resolve(null),
  ])
  check()
  ensure(token.decimals === 6 && token.symbol === "tUSDC", "INVALID_FUNDING_TOKEN")
  if (units !== null) ensure(units.decimals === 9, "INVALID_FUNDING_TOKEN")
  return {
    cashSymbol: "tUSDC", balance: rawAmount(token.balance), blockNumber: head.toString(),
    spender: spender && allowance !== null ? spender.toLowerCase() : null, allowance: allowance === null ? null : rawAmount(allowance),
    stockBalance: units === null ? null : rawAmount(units.balance),
    stockSpender: stock && stockAllowance !== null ? stock.spender.toLowerCase() : null,
    stockAllowance: stockAllowance === null ? null : rawAmount(stockAllowance),
    ...(gas === null ? {} : { gas: rawAmount(gas) }),
  }
}
