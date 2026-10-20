// DEMO ONLY: the stand-in chain behind the investor shell preview's demo wallet (?wallet=demo). Not the app and not a
// chain: never imported by product code, and nothing here reaches GIWA Sepolia or the deployed contracts.
//
// It answers the JSON-RPC calls the product pages make through the public client (balances, allowances, share supply,
// the price feed, simulations, transactions, receipts, blocks) and runs the demo wallet's transactions: ERC-20 approve
// and transfer, vault deposit, instant redemption, redemption request, the test-asset faucet and Get ArcoUSD's
// conversions. Contract addresses
// are the captured catalog's and share prices the captured NAV, so the amounts match what the pages quote.
// A transaction settles MINING_MS after it is sent; the block number moves on once a second.

import {
  BaseError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  maxUint256,
  numberToHex,
  parseAbi,
  parseUnits,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem"
import type { GiwaProduct, GiwaRedemption } from "../../types"

export const DEMO_CHAIN_ID = 91342
const CHAIN_HEX = numberToHex(DEMO_CHAIN_ID)
/** The price feeds' scale (8 decimals): an answer of DEMO_FEED_SCALE is one for one. */
export const DEMO_FEED_SCALE = 100_000_000n
const FEED_SCALE = DEMO_FEED_SCALE
const SHARE_DECIMALS = 18
const GENESIS_BLOCK = 31_000_000n
export const MINING_MS = 1_500
const GAS_PRICE = 1_000_000n
const GAS_USED = 120_000n
const GAS_LIMIT = 300_000n
const KEEP_TXS = 50
const ZERO_BLOOM = `0x${"00".repeat(256)}` as Hex
const ZERO_WORD = `0x${"00".repeat(32)}` as Hex
/** Holds the shares that were outstanding before the demo wallet arrived. */
const OTHER_HOLDERS = getAddress("0x000000000000000000000000000000000000ab0c")
/** Each vault starts about this large, a tenth of it in the instant reserve (the Backing card's 10%). */
const STARTING_TVL_USD = 50_000
const RESERVE_SHARE = 0.1
/** What each Get ArcoUSD converter holds of its coin to pay conversions back, before any coin comes in. */
const CONVERTER_RESERVE = "1000000"
/** What the demo wallet starts with, and what one faucet drip gives, by the asset's on-chain symbol. */
const TEST_AMOUNTS: Readonly<Record<string, string>> = { tUSDC: "10000", tWETH: "5", tXRP: "10000", tBTC: "0.5" }
const TEST_AMOUNT_DEFAULT = "1000"
const NATIVE_START = parseUnits("0.05", 18)

const tokenAbi = [...erc20Abi, ...parseAbi(["function greenlistEnforced() view returns (bool)"])] as const
const depositVaultAbi = parseAbi([
  "function deposit(uint256 paymentAssets, uint256 minSharesOut, address recipient) returns (uint256)",
  "function requestDeposit(uint256 paymentAssets, uint256 minSharesOut, address recipient) returns (uint256)",
])
const redemptionVaultAbi = parseAbi([
  "function redeemInstant(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256)",
  "function requestRedeem(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256)",
  "function claimRedeem(uint256 requestId)",
])
const priceFeedAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function healthyDiff() view returns (uint256)",
  "function minExpectedAnswer() view returns (uint256)",
  "function maxExpectedAnswer() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function decimals() view returns (uint8)",
])
const faucetAbi = parseAbi(["function drip(address token)", "function dripAll()"])
const errorAbi = parseAbi(["error Error(string message)"])

// ── configuration ───────────────────────────────────────────────────────────────────────────────────

/** `start`: what the demo wallet starts with (TEST_AMOUNTS by symbol when not given). */
export type DemoAsset = Readonly<{ address: Address; symbol: string; decimals: number; faucet: Address | null; start?: string }>
export type DemoProduct = Readonly<{
  productId: string
  /** The share token's symbol ("arcoUSD"). */
  symbol: string
  token: Address
  depositVault: Address
  redemptionVault: Address
  priceFeed: Address
  payment: DemoAsset
  /** NAV per share in the payment asset, at the feed's 8 decimals (1.0002 → 100_020_000). */
  answer: bigint
  /** USD per unit of the payment asset; sizes the starting supply and reserve. */
  baseUsd: number
}>
/**
 * `routes`: how a Savings vault takes coins other than its own (./demo-routes.ts). Each is a product of its own coin and
 * deposit / redemption vaults that mints and burns its vault's shares at the vault's price (the share token and price
 * feed are the vault's, already on the chain), with an instant reserve of its coin.
 */
/**
 * `converters`: Get ArcoUSD's (./demo-routes.ts). Each is a product of its coin (the payment) and ArcoUSD (the token it
 * mints), whose deposit and redemption vault are one converter address, priced one for one by the peg feed: a deposit
 * mints ArcoUSD for the coin, an instant redemption pays the coin back, out of what the converter holds.
 */
export type DemoChainConfig = Readonly<{
  account: Address
  products: readonly DemoProduct[]
  routes?: readonly DemoProduct[]
  converters?: readonly DemoProduct[]
}>
type MarketRow = Readonly<{ productId: string; navBase: number | null; baseUsd: number | null }>

function addressOr(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null
}

/** Every catalog product with a full deployment (raw API rows, as captured), priced at its captured NAV. */
export function demoProducts(catalog: readonly GiwaProduct[], market: readonly MarketRow[]): DemoProduct[] {
  const products: DemoProduct[] = []
  for (const item of catalog) {
    const asset = item.paymentAsset
    const token = addressOr(item.productTokenAddress ?? item.productToken?.proxy)
    const depositVault = addressOr(item.depositVaultAddress ?? item.depositVault?.proxy)
    const redemptionVault = addressOr(item.redemptionVaultAddress ?? item.redemptionVault?.proxy)
    const priceFeed = addressOr(item.priceFeedAddress ?? item.priceFeed?.proxy)
    const payment = addressOr(item.paymentAssetAddress ?? asset?.tokenAddress ?? asset?.contract?.proxy)
    if (!asset || !token || !depositVault || !redemptionVault || !priceFeed || !payment) continue
    const row = market.find((entry) => entry.productId === item.productId)
    const navBase = row?.navBase != null && row.navBase > 0 ? row.navBase : 1
    products.push({
      productId: item.productId,
      symbol: item.symbol,
      token,
      depositVault,
      redemptionVault,
      priceFeed,
      payment: { address: payment, symbol: asset.symbol, decimals: asset.decimals, faucet: addressOr(asset.faucetAddress ?? asset.faucet) },
      answer: BigInt(Math.round(navBase * Number(FEED_SCALE))),
      baseUsd: row?.baseUsd != null && row.baseUsd > 0 ? row.baseUsd : 1,
    })
  }
  return products
}

// ── errors ──────────────────────────────────────────────────────────────────────────────────────────

/** A JSON-RPC error: what a node (or a wallet) answers instead of a result. */
export class DemoRpcError extends Error {
  readonly code: number
  readonly data: Hex | undefined
  constructor(code: number, message: string, data?: Hex) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** A contract call that reverts, with its reason. */
class Revert extends Error {}

function revertError(reason: string): DemoRpcError {
  return new DemoRpcError(3, `execution reverted: ${reason}`, encodeErrorResult({ abi: errorAbi, errorName: "Error", args: [reason] }))
}

// ── ledger ──────────────────────────────────────────────────────────────────────────────────────────

const key = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join("|")

class Ledger {
  balances = new Map<string, bigint>()
  allowances = new Map<string, bigint>()
  supply = new Map<string, bigint>()
  native = 0n
  redemptions: GiwaRedemption[] = []
  nextRequestId = 1

  clone(): Ledger {
    const copy = new Ledger()
    copy.balances = new Map(this.balances)
    copy.allowances = new Map(this.allowances)
    copy.supply = new Map(this.supply)
    copy.native = this.native
    copy.redemptions = this.redemptions.map((row) => ({ ...row }))
    copy.nextRequestId = this.nextRequestId
    return copy
  }
  balance(token: Address, owner: Address): bigint {
    return this.balances.get(key(token, owner)) ?? 0n
  }
  allowance(token: Address, owner: Address, spender: Address): bigint {
    return this.allowances.get(key(token, owner, spender)) ?? 0n
  }
  totalSupply(token: Address): bigint {
    return this.supply.get(key(token)) ?? 0n
  }
}

type DemoLog = Readonly<{ address: Address; topics: readonly Hex[]; data: Hex }>

function transferLog(token: Address, from: Address, to: Address, value: bigint): DemoLog {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  }
}
function approvalLog(token: Address, owner: Address, spender: Address, value: bigint): DemoLog {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Approval", args: { owner, spender } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  }
}

/** Moves `amount` of `token`; from/to the zero address mints/burns. Reverts on a short balance. */
function move(ledger: Ledger, token: Address, symbol: string, from: Address, to: Address, amount: bigint, logs: DemoLog[]) {
  if (from === zeroAddress) {
    ledger.supply.set(key(token), ledger.totalSupply(token) + amount)
  } else {
    const have = ledger.balance(token, from)
    if (have < amount) throw new Revert(`${symbol}: transfer amount exceeds balance`)
    ledger.balances.set(key(token, from), have - amount)
  }
  if (to === zeroAddress) {
    ledger.supply.set(key(token), ledger.totalSupply(token) - amount)
  } else {
    ledger.balances.set(key(token, to), ledger.balance(token, to) + amount)
  }
  logs.push(transferLog(token, from, to, amount))
}

function spendAllowance(ledger: Ledger, token: Address, symbol: string, owner: Address, spender: Address, amount: bigint) {
  const allowed = ledger.allowance(token, owner, spender)
  if (allowed < amount) throw new Revert(`${symbol}: insufficient allowance`)
  if (allowed !== maxUint256) ledger.allowances.set(key(token, owner, spender), allowed - amount)
}

// ── contracts ───────────────────────────────────────────────────────────────────────────────────────

type Contract =
  | Readonly<{ kind: "token"; address: Address; symbol: string; decimals: number }>
  | Readonly<{ kind: "deposit-vault"; product: DemoProduct }>
  | Readonly<{ kind: "redemption-vault"; product: DemoProduct }>
  | Readonly<{ kind: "price-feed"; product: DemoProduct }>
  | Readonly<{ kind: "faucet"; assets: readonly DemoAsset[] }>
  | Readonly<{ kind: "converter"; product: DemoProduct }>

type Call = Readonly<{ from: Address | null; to: Address; data: Hex; value: bigint }>
type Context = Readonly<{ hash: Hex | null; nowMs: number }>

function sharesFor(product: DemoProduct, assets: bigint): bigint {
  return (assets * 10n ** BigInt(SHARE_DECIMALS - product.payment.decimals) * FEED_SCALE) / product.answer
}
function assetsFor(product: DemoProduct, shares: bigint): bigint {
  return (shares * product.answer) / FEED_SCALE / 10n ** BigInt(SHARE_DECIMALS - product.payment.decimals)
}
function testAmount(asset: DemoAsset): bigint {
  return parseUnits(asset.start ?? TEST_AMOUNTS[asset.symbol] ?? TEST_AMOUNT_DEFAULT, asset.decimals)
}
/** A vault's instant reserve when it starts: a tenth of the starting backing, in its coin. */
function startingReserve(product: DemoProduct): bigint {
  const { payment } = product
  return parseUnits(((STARTING_TVL_USD * RESERVE_SHARE) / product.baseUsd).toFixed(Math.min(payment.decimals, 6)), payment.decimals)
}
function sender(call: Call): Address {
  if (call.from === null) throw new Revert("This call needs a sender")
  return call.from
}

// ── the chain ───────────────────────────────────────────────────────────────────────────────────────

type Tx = Readonly<{ hash: Hex; from: Address; to: Address; input: Hex; nonce: number; sentAt: number; blockNumber: string; logs: readonly DemoLog[] }>

export type DemoChainSave = Readonly<{
  v: 1
  genesisMs: number
  nonce: number
  native: string
  balances: readonly (readonly [string, string])[]
  allowances: readonly (readonly [string, string])[]
  supply: readonly (readonly [string, string])[]
  redemptions: readonly GiwaRedemption[]
  nextRequestId: number
  txs: readonly Tx[]
}>

export type DemoTxDescription = Readonly<{ title: string; detail: string | null; rows: readonly (readonly [string, string])[] }>
export type DemoAmount = Readonly<{ symbol: string; amount: string }>
export type DemoChainView = Readonly<{ native: string; assets: readonly DemoAmount[]; shares: readonly DemoAmount[]; pendingWithdrawals: number }>

const toEntries = (map: Map<string, bigint>) => Array.from(map, ([name, value]) => [name, value.toString()] as const)
const fromEntries = (entries: readonly (readonly [string, string])[]) => new Map(entries.map(([name, value]) => [name, BigInt(value)]))

/** A display amount: up to 6 decimals, grouped ("10,000", "999.80004"). */
export function demoAmount(raw: bigint, decimals: number): string {
  return Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export class DemoChain {
  readonly account: Address
  private readonly products: readonly DemoProduct[]
  private readonly routes: readonly DemoProduct[]
  private readonly converters: readonly DemoProduct[]
  private readonly contracts = new Map<string, Contract>()
  private readonly assets: readonly DemoAsset[]
  private ledger: Ledger
  private genesisMs: number
  private nonce: number
  private txs: Tx[]

  constructor(config: DemoChainConfig, saved: DemoChainSave | null = null, nowMs = Date.now()) {
    this.account = getAddress(config.account)
    this.products = config.products
    this.routes = config.routes ?? []
    this.converters = config.converters ?? []
    const assets = new Map<string, DemoAsset>()
    const faucets = new Map<string, DemoAsset[]>()
    for (const product of config.products) {
      const { payment } = product
      assets.set(key(payment.address), payment)
      this.contracts.set(key(payment.address), { kind: "token", address: payment.address, symbol: payment.symbol, decimals: payment.decimals })
      this.contracts.set(key(product.token), { kind: "token", address: product.token, symbol: product.symbol, decimals: SHARE_DECIMALS })
      this.contracts.set(key(product.depositVault), { kind: "deposit-vault", product })
      this.contracts.set(key(product.redemptionVault), { kind: "redemption-vault", product })
      this.contracts.set(key(product.priceFeed), { kind: "price-feed", product })
    }
    // A route brings its coin and its two vaults; its share token and price feed are its vault's, registered above.
    for (const route of this.routes) {
      const { payment } = route
      assets.set(key(payment.address), payment)
      this.contracts.set(key(payment.address), { kind: "token", address: payment.address, symbol: payment.symbol, decimals: payment.decimals })
      this.contracts.set(key(route.depositVault), { kind: "deposit-vault", product: route })
      this.contracts.set(key(route.redemptionVault), { kind: "redemption-vault", product: route })
    }
    // A converter brings its one address and, the first time, ArcoUSD and the peg feed; its coin is a vault's or a
    // route's, registered above (else here).
    for (const converter of this.converters) {
      const { payment } = converter
      if (!this.contracts.has(key(payment.address))) {
        assets.set(key(payment.address), payment)
        this.contracts.set(key(payment.address), { kind: "token", address: payment.address, symbol: payment.symbol, decimals: payment.decimals })
      }
      if (!this.contracts.has(key(converter.token))) {
        this.contracts.set(key(converter.token), { kind: "token", address: converter.token, symbol: converter.symbol, decimals: SHARE_DECIMALS })
      }
      if (!this.contracts.has(key(converter.priceFeed))) this.contracts.set(key(converter.priceFeed), { kind: "price-feed", product: converter })
      this.contracts.set(key(converter.depositVault), { kind: "converter", product: converter })
    }
    this.assets = Array.from(assets.values())
    for (const asset of this.assets) {
      if (asset.faucet === null) continue
      const list = faucets.get(key(asset.faucet)) ?? []
      list.push(asset)
      faucets.set(key(asset.faucet), list)
    }
    for (const [address, list] of faucets) this.contracts.set(address, { kind: "faucet", assets: list })

    if (saved !== null && saved.v === 1) {
      this.ledger = new Ledger()
      this.ledger.balances = fromEntries(saved.balances)
      this.ledger.allowances = fromEntries(saved.allowances)
      this.ledger.supply = fromEntries(saved.supply)
      this.ledger.native = BigInt(saved.native)
      this.ledger.redemptions = saved.redemptions.map((row) => ({ ...row }))
      this.ledger.nextRequestId = saved.nextRequestId
      this.genesisMs = saved.genesisMs
      this.nonce = saved.nonce
      this.txs = [...saved.txs]
      // A chain saved before a route or a converter existed gets its coin now, and keeps everything else as it was.
      this.seedRoutes(this.ledger)
      this.seedConverters(this.ledger)
    } else {
      this.ledger = this.startingLedger()
      this.genesisMs = nowMs
      this.nonce = 0
      this.txs = []
    }
  }

  /** Each vault ~$50K: shares with other holders, 90% of the backing in the deposit vault, 10% as the instant reserve. */
  private startingLedger(): Ledger {
    const ledger = new Ledger()
    const logs: DemoLog[] = []
    ledger.native = NATIVE_START
    for (const product of this.products) {
      const { payment } = product
      const navUsd = (Number(product.answer) / Number(FEED_SCALE)) * product.baseUsd
      const shares = parseUnits((STARTING_TVL_USD / navUsd).toFixed(6), SHARE_DECIMALS)
      const backing = parseUnits((STARTING_TVL_USD / product.baseUsd).toFixed(Math.min(payment.decimals, 6)), payment.decimals)
      const reserve = startingReserve(product)
      move(ledger, product.token, product.symbol, zeroAddress, OTHER_HOLDERS, shares, logs)
      move(ledger, payment.address, payment.symbol, zeroAddress, product.depositVault, backing - reserve, logs)
      move(ledger, payment.address, payment.symbol, zeroAddress, product.redemptionVault, reserve, logs)
    }
    const routeCoins = new Set(this.routes.map((route) => key(route.payment.address)))
    for (const asset of this.assets) {
      if (!routeCoins.has(key(asset.address))) move(ledger, asset.address, asset.symbol, zeroAddress, this.account, testAmount(asset), logs)
    }
    this.seedRoutes(ledger)
    this.seedConverters(ledger)
    return ledger
  }

  /**
   * Issues each route's coin the first time: the demo wallet's starting amount, and the route's instant reserve (its
   * vault's tenth). A route whose coin is already out is left as it is.
   */
  private seedRoutes(ledger: Ledger) {
    const logs: DemoLog[] = []
    for (const route of this.routes) {
      const { payment } = route
      if (ledger.totalSupply(payment.address) > 0n) continue
      move(ledger, payment.address, payment.symbol, zeroAddress, this.account, testAmount(payment), logs)
      move(ledger, payment.address, payment.symbol, zeroAddress, route.redemptionVault, startingReserve(route), logs)
    }
  }

  /** Gives each converter its reserve of its coin while it holds none (the first time, or once paid out to the last). */
  private seedConverters(ledger: Ledger) {
    const logs: DemoLog[] = []
    for (const converter of this.converters) {
      const { payment } = converter
      if (ledger.balance(payment.address, converter.depositVault) > 0n) continue
      move(ledger, payment.address, payment.symbol, zeroAddress, converter.depositVault, parseUnits(CONVERTER_RESERVE, payment.decimals), logs)
    }
  }

  save(): DemoChainSave {
    return {
      v: 1,
      genesisMs: this.genesisMs,
      nonce: this.nonce,
      native: this.ledger.native.toString(),
      balances: toEntries(this.ledger.balances),
      allowances: toEntries(this.ledger.allowances),
      supply: toEntries(this.ledger.supply),
      redemptions: this.ledger.redemptions.map((row) => ({ ...row })),
      nextRequestId: this.ledger.nextRequestId,
      txs: [...this.txs],
    }
  }

  blockAt(nowMs: number): bigint {
    return GENESIS_BLOCK + BigInt(Math.max(0, Math.floor((nowMs - this.genesisMs) / 1000)))
  }

  // ── execution ──

  private execute(ledger: Ledger, call: Call, context: Context): { result: Hex; logs: DemoLog[] } {
    const contract = this.contracts.get(key(call.to))
    if (!contract) throw new Revert("No contract at this address in the demo")
    if (call.value > 0n) throw new Revert("The demo contracts take no ETH")
    const logs: DemoLog[] = []
    try {
      return { result: this.run(ledger, contract, call, context, logs), logs }
    } catch (err) {
      // viem's decoding errors: a function this contract does not have, or malformed arguments.
      if (err instanceof BaseError) throw new Revert("This call is not part of the demo")
      throw err
    }
  }

  private run(ledger: Ledger, contract: Contract, call: Call, context: Context, logs: DemoLog[]): Hex {
    switch (contract.kind) {
      case "token": {
        const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data })
        const { address, symbol } = contract
        switch (decoded.functionName) {
          case "balanceOf":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", result: ledger.balance(address, decoded.args[0]) })
          case "allowance":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "allowance", result: ledger.allowance(address, decoded.args[0], decoded.args[1]) })
          case "totalSupply":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "totalSupply", result: ledger.totalSupply(address) })
          case "decimals":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "decimals", result: contract.decimals })
          case "symbol":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "symbol", result: symbol })
          case "name":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "name", result: symbol })
          case "greenlistEnforced":
            return encodeFunctionResult({ abi: tokenAbi, functionName: "greenlistEnforced", result: false })
          case "approve": {
            const owner = sender(call)
            const [spender, value] = decoded.args
            ledger.allowances.set(key(address, owner, spender), value)
            logs.push(approvalLog(address, owner, spender, value))
            return encodeFunctionResult({ abi: tokenAbi, functionName: "approve", result: true })
          }
          case "transfer": {
            move(ledger, address, symbol, sender(call), decoded.args[0], decoded.args[1], logs)
            return encodeFunctionResult({ abi: tokenAbi, functionName: "transfer", result: true })
          }
          case "transferFrom": {
            const [from, to, value] = decoded.args
            spendAllowance(ledger, address, symbol, from, sender(call), value)
            move(ledger, address, symbol, from, to, value, logs)
            return encodeFunctionResult({ abi: tokenAbi, functionName: "transferFrom", result: true })
          }
        }
        throw new Revert("This call is not part of the demo")
      }
      case "deposit-vault": {
        const decoded = decodeFunctionData({ abi: depositVaultAbi, data: call.data })
        if (decoded.functionName !== "deposit") throw new Revert("Deposit requests are not part of the demo")
        const { product } = contract
        const [assets, minShares, recipient] = decoded.args
        const from = sender(call)
        if (assets <= 0n) throw new Revert("Amount must be greater than zero")
        const shares = sharesFor(product, assets)
        if (shares <= 0n) throw new Revert("Amount is too small")
        if (shares < minShares) throw new Revert("Fewer shares than the minimum")
        spendAllowance(ledger, product.payment.address, product.payment.symbol, from, product.depositVault, assets)
        move(ledger, product.payment.address, product.payment.symbol, from, product.depositVault, assets, logs)
        move(ledger, product.token, product.symbol, zeroAddress, recipient, shares, logs)
        return encodeFunctionResult({ abi: depositVaultAbi, functionName: "deposit", result: shares })
      }
      case "redemption-vault": {
        const decoded = decodeFunctionData({ abi: redemptionVaultAbi, data: call.data })
        const { product } = contract
        const from = sender(call)
        if (decoded.functionName === "claimRedeem") throw new Revert("Nothing to claim: demo withdrawal requests stay pending")
        const [shares, minAssets, recipient] = decoded.args
        if (shares <= 0n) throw new Revert("Amount must be greater than zero")
        const assets = assetsFor(product, shares)
        if (assets < minAssets) throw new Revert("Less than the minimum payout")
        if (decoded.functionName === "redeemInstant") {
          if (assets > ledger.balance(product.payment.address, product.redemptionVault)) throw new Revert("Not enough instant liquidity")
          move(ledger, product.token, product.symbol, from, zeroAddress, shares, logs)
          move(ledger, product.payment.address, product.payment.symbol, product.redemptionVault, recipient, assets, logs)
          return encodeFunctionResult({ abi: redemptionVaultAbi, functionName: "redeemInstant", result: assets })
        }
        move(ledger, product.token, product.symbol, from, product.redemptionVault, shares, logs)
        const requestId = ledger.nextRequestId
        ledger.nextRequestId += 1
        ledger.redemptions.push({
          requestId: String(requestId),
          productId: product.productId,
          walletAddress: from,
          redemptionVaultAddress: product.redemptionVault,
          sharesIn: shares.toString(),
          lockedAssetsOut: assets.toString(),
          status: "REQUESTED",
          ...(context.hash !== null ? { requestedTxHash: context.hash } : {}),
          createdAt: new Date(context.nowMs).toISOString(),
          fulfilledAt: null,
          settledAt: null,
        })
        return encodeFunctionResult({ abi: redemptionVaultAbi, functionName: "requestRedeem", result: BigInt(requestId) })
      }
      case "price-feed": {
        const decoded = decodeFunctionData({ abi: priceFeedAbi, data: call.data })
        const updatedAt = BigInt(Math.floor(context.nowMs / 1000) - 60)
        switch (decoded.functionName) {
          case "latestRoundData":
            return encodeFunctionResult({ abi: priceFeedAbi, functionName: "latestRoundData", result: [1n, contract.product.answer, updatedAt, updatedAt, 1n] })
          case "healthyDiff":
            return encodeFunctionResult({ abi: priceFeedAbi, functionName: "healthyDiff", result: 7n * 86_400n })
          case "minExpectedAnswer":
            return encodeFunctionResult({ abi: priceFeedAbi, functionName: "minExpectedAnswer", result: 1n })
          case "maxExpectedAnswer":
            return encodeFunctionResult({ abi: priceFeedAbi, functionName: "maxExpectedAnswer", result: 10n ** 18n })
          case "maxDeviationBps":
            return encodeFunctionResult({ abi: priceFeedAbi, functionName: "maxDeviationBps", result: 1_000n })
          case "decimals":
            return encodeFunctionResult({ abi: priceFeedAbi, functionName: "decimals", result: 8 })
        }
        throw new Revert("This call is not part of the demo")
      }
      case "converter": {
        // One address both ways: a deposit mints ArcoUSD for the coin, an instant redemption pays the coin back for it.
        const deposit = this.selects(depositVaultAbi, call.data)
        if (deposit !== null && deposit !== "deposit") throw new Revert("A conversion is instant")
        if (deposit === null && this.selects(redemptionVaultAbi, call.data) !== "redeemInstant") throw new Revert("A conversion is instant")
        const as: Contract = deposit !== null ? { kind: "deposit-vault", product: contract.product } : { kind: "redemption-vault", product: contract.product }
        return this.run(ledger, as, call, context, logs)
      }
      case "faucet": {
        const decoded = decodeFunctionData({ abi: faucetAbi, data: call.data })
        const to = sender(call)
        const minted =
          decoded.functionName === "dripAll" ? contract.assets : contract.assets.filter((asset) => key(asset.address) === key(decoded.args[0]))
        if (minted.length === 0) throw new Revert("This faucet does not give that asset")
        for (const asset of minted) move(ledger, asset.address, asset.symbol, zeroAddress, to, testAmount(asset), logs)
        return "0x"
      }
    }
  }

  /** The function `data` calls on a contract of `abi`, or null when it is none of its functions. */
  private selects(abi: typeof depositVaultAbi | typeof redemptionVaultAbi, data: Hex): string | null {
    try {
      return decodeFunctionData({ abi, data }).functionName
    } catch {
      return null
    }
  }

  /** eth_call / eth_estimateGas: run on a copy and keep nothing. */
  private dryRun(raw: unknown, nowMs: number): { result: Hex; logs: DemoLog[] } {
    const call = this.parseCall(raw)
    try {
      return this.execute(this.ledger.clone(), call, { hash: null, nowMs })
    } catch (err) {
      if (err instanceof Revert) throw revertError(err.message)
      throw err
    }
  }

  private parseCall(raw: unknown): Call {
    const value = (raw ?? {}) as Record<string, unknown>
    const to = addressOr(value.to)
    if (!to) throw new DemoRpcError(-32602, "The call needs a contract address")
    const data = typeof value.data === "string" ? value.data : typeof value.input === "string" ? value.input : "0x"
    return {
      from: addressOr(value.from),
      to,
      data: data as Hex,
      value: typeof value.value === "string" && value.value !== "0x" ? BigInt(value.value) : 0n,
    }
  }

  /** The wallet's eth_sendTransaction: run, keep the result, pay the fee, return the hash. */
  send(raw: unknown, nowMs = Date.now()): Hex {
    const call = this.parseCall(raw)
    if (call.from === null || key(call.from) !== key(this.account)) throw new DemoRpcError(4100, "The demo wallet only sends from its own account")
    const fee = GAS_USED * GAS_PRICE
    if (this.ledger.native < fee) throw new DemoRpcError(-32000, "insufficient funds for gas")
    const nonce = this.nonce
    const hash = keccak256(stringToHex(`demo:${this.genesisMs}:${nonce}:${call.to}:${call.data}:${nowMs}`))
    const working = this.ledger.clone()
    let logs: DemoLog[]
    try {
      logs = this.execute(working, call, { hash, nowMs }).logs
    } catch (err) {
      if (err instanceof Revert) throw revertError(err.message)
      throw err
    }
    working.native -= fee
    this.ledger = working
    this.nonce = nonce + 1
    const blockNumber = this.blockAt(nowMs + MINING_MS)
    this.txs = [...this.txs, { hash, from: call.from, to: call.to, input: call.data, nonce, sentAt: nowMs, blockNumber: blockNumber.toString(), logs }].slice(-KEEP_TXS)
    return hash
  }

  // ── JSON-RPC ──

  handle(method: string, params: readonly unknown[], nowMs = Date.now()): unknown {
    switch (method) {
      case "eth_chainId":
        return CHAIN_HEX
      case "net_version":
        return String(DEMO_CHAIN_ID)
      case "eth_blockNumber":
        return numberToHex(this.blockAt(nowMs))
      case "eth_gasPrice":
        return numberToHex(GAS_PRICE)
      case "eth_maxPriorityFeePerGas":
        return numberToHex(GAS_PRICE / 2n)
      case "eth_getBalance": {
        const address = addressOr(params[0])
        return numberToHex(address !== null && key(address) === key(this.account) ? this.ledger.native : 0n)
      }
      case "eth_getTransactionCount": {
        const address = addressOr(params[0])
        return numberToHex(address !== null && key(address) === key(this.account) ? this.nonce : 0)
      }
      case "eth_getCode": {
        const address = addressOr(params[0])
        return address !== null && this.contracts.has(key(address)) ? "0x6080604052" : "0x"
      }
      case "eth_call":
        return this.dryRun(params[0], nowMs).result
      case "eth_estimateGas":
        this.dryRun(params[0], nowMs)
        return numberToHex(GAS_USED)
      case "eth_getTransactionByHash": {
        const tx = this.txOf(params[0])
        return tx === null ? null : this.txView(tx, nowMs)
      }
      case "eth_getTransactionReceipt": {
        const tx = this.txOf(params[0])
        return tx === null || !this.mined(tx, nowMs) ? null : this.receiptView(tx)
      }
      case "eth_getBlockByNumber":
        return this.blockView(this.blockTag(params[0], nowMs), params[1] === true, nowMs)
      case "eth_getLogs":
        return []
      default:
        throw new DemoRpcError(-32601, `The demo chain does not answer ${method}`)
    }
  }

  /** A JSON-RPC request body (one call or a batch) in, the response body out. */
  respond(body: string, nowMs = Date.now()): string {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    }
    const one = (request: unknown) => {
      const { id = null, method, params } = (request ?? {}) as { id?: unknown; method?: unknown; params?: unknown }
      try {
        if (typeof method !== "string") throw new DemoRpcError(-32600, "Invalid request")
        return { jsonrpc: "2.0", id, result: this.handle(method, Array.isArray(params) ? params : [], nowMs) }
      } catch (err) {
        const error = err instanceof DemoRpcError ? err : new DemoRpcError(-32603, err instanceof Error ? err.message : String(err))
        return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } }
      }
    }
    return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed))
  }

  private txOf(hash: unknown): Tx | null {
    return typeof hash === "string" ? this.txs.find((tx) => tx.hash.toLowerCase() === hash.toLowerCase()) ?? null : null
  }
  private mined(tx: Tx, nowMs: number): boolean {
    return nowMs >= tx.sentAt + MINING_MS
  }
  private blockTag(tag: unknown, nowMs: number): bigint {
    if (typeof tag === "string" && tag.startsWith("0x")) return BigInt(tag)
    return tag === "earliest" ? GENESIS_BLOCK : this.blockAt(nowMs)
  }
  private blockHash(number: bigint): Hex {
    return keccak256(stringToHex(`demo-block:${this.genesisMs}:${number}`))
  }

  private txView(tx: Tx, nowMs: number) {
    const mined = this.mined(tx, nowMs)
    const blockNumber = BigInt(tx.blockNumber)
    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      input: tx.input,
      value: "0x0",
      nonce: numberToHex(tx.nonce),
      gas: numberToHex(GAS_LIMIT),
      gasPrice: numberToHex(GAS_PRICE),
      maxFeePerGas: numberToHex(GAS_PRICE),
      maxPriorityFeePerGas: numberToHex(GAS_PRICE / 2n),
      type: "0x2",
      chainId: CHAIN_HEX,
      accessList: [],
      blockHash: mined ? this.blockHash(blockNumber) : null,
      blockNumber: mined ? numberToHex(blockNumber) : null,
      transactionIndex: mined ? "0x0" : null,
      v: "0x0",
      yParity: "0x0",
      r: ZERO_WORD,
      s: ZERO_WORD,
    }
  }

  private receiptView(tx: Tx) {
    const blockNumber = numberToHex(BigInt(tx.blockNumber))
    const blockHash = this.blockHash(BigInt(tx.blockNumber))
    return {
      transactionHash: tx.hash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber,
      from: tx.from,
      to: tx.to,
      cumulativeGasUsed: numberToHex(GAS_USED),
      gasUsed: numberToHex(GAS_USED),
      effectiveGasPrice: numberToHex(GAS_PRICE),
      contractAddress: null,
      logs: tx.logs.map((log, index) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: numberToHex(index),
        blockHash,
        blockNumber,
        transactionHash: tx.hash,
        transactionIndex: "0x0",
        removed: false,
      })),
      logsBloom: ZERO_BLOOM,
      status: "0x1",
      type: "0x2",
    }
  }

  private blockView(number: bigint, full: boolean, nowMs: number) {
    const included = this.txs.filter((tx) => BigInt(tx.blockNumber) === number && this.mined(tx, nowMs))
    return {
      number: numberToHex(number),
      hash: this.blockHash(number),
      parentHash: this.blockHash(number - 1n),
      timestamp: numberToHex(BigInt(Math.floor(this.genesisMs / 1000)) + (number - GENESIS_BLOCK)),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      gasLimit: numberToHex(30_000_000n),
      gasUsed: numberToHex(GAS_USED * BigInt(included.length)),
      baseFeePerGas: numberToHex(GAS_PRICE / 2n),
      miner: zeroAddress,
      extraData: "0x",
      logsBloom: ZERO_BLOOM,
      sha3Uncles: ZERO_WORD,
      stateRoot: ZERO_WORD,
      receiptsRoot: ZERO_WORD,
      transactionsRoot: ZERO_WORD,
      mixHash: ZERO_WORD,
      size: "0x200",
      uncles: [],
      transactions: full ? included.map((tx) => this.txView(tx, nowMs)) : included.map((tx) => tx.hash),
    }
  }

  // ── what the demo wallet shows ──

  /** The wallet's confirmation text for a transaction it is asked to send. */
  describe(raw: unknown): DemoTxDescription {
    const fee: readonly [string, string] = ["Network fee", "< 0.0001 ETH"]
    let call: Call
    try {
      call = this.parseCall(raw)
    } catch {
      return { title: "Send a transaction", detail: null, rows: [fee] }
    }
    const contract = this.contracts.get(key(call.to))
    try {
      if (contract?.kind === "token") {
        const decoded = decodeFunctionData({ abi: tokenAbi, data: call.data })
        if (decoded.functionName === "approve") {
          const [spender, value] = decoded.args
          const vault = this.contracts.get(key(spender))
          const spenderName =
            vault?.kind === "deposit-vault"
              ? `the ${vault.product.symbol} deposit vault`
              : vault?.kind === "converter"
                ? "the ArcoUSD converter"
                : shortAddress(spender)
          const cap = value === maxUint256 ? "Unlimited" : `${demoAmount(value, contract.decimals)} ${contract.symbol}`
          return { title: `Approve ${contract.symbol}`, detail: `Lets ${spenderName} use your ${contract.symbol}.`, rows: [["Spending cap", cap], fee] }
        }
      }
      if (contract?.kind === "deposit-vault") {
        const decoded = decodeFunctionData({ abi: depositVaultAbi, data: call.data })
        const { product } = contract
        const assets = decoded.args[0]
        return {
          title: `Deposit ${demoAmount(assets, product.payment.decimals)} ${product.payment.symbol}`,
          detail: `Into ${product.symbol}`,
          rows: [["You receive", `≈ ${demoAmount(sharesFor(product, assets), SHARE_DECIMALS)} ${product.symbol}`], fee],
        }
      }
      if (contract?.kind === "redemption-vault") {
        const decoded = decodeFunctionData({ abi: redemptionVaultAbi, data: call.data })
        const { product } = contract
        if (decoded.functionName !== "claimRedeem") {
          const shares = decoded.args[0]
          const payout = `≈ ${demoAmount(assetsFor(product, shares), product.payment.decimals)} ${product.payment.symbol}`
          return decoded.functionName === "redeemInstant"
            ? { title: `Withdraw ${demoAmount(shares, SHARE_DECIMALS)} ${product.symbol}`, detail: null, rows: [["You receive", payout], fee] }
            : { title: `Request a withdrawal of ${demoAmount(shares, SHARE_DECIMALS)} ${product.symbol}`, detail: "Paid out later", rows: [["You receive", payout], fee] }
        }
      }
      if (contract?.kind === "converter") {
        const { product } = contract
        const deposit = this.selects(depositVaultAbi, call.data)
        if (deposit === "deposit") {
          const assets = decodeFunctionData({ abi: depositVaultAbi, data: call.data }).args[0]
          return {
            title: `Convert ${demoAmount(assets, product.payment.decimals)} ${product.payment.symbol}`,
            detail: `Into ${product.symbol}`,
            rows: [["You receive", `≈ ${demoAmount(sharesFor(product, assets), SHARE_DECIMALS)} ${product.symbol}`], fee],
          }
        }
        if (this.selects(redemptionVaultAbi, call.data) === "redeemInstant") {
          const shares = decodeFunctionData({ abi: redemptionVaultAbi, data: call.data }).args[0]
          return {
            title: `Convert ${demoAmount(shares, SHARE_DECIMALS)} ${product.symbol}`,
            detail: `Into ${product.payment.symbol}`,
            rows: [["You receive", `≈ ${demoAmount(assetsFor(product, shares), product.payment.decimals)} ${product.payment.symbol}`], fee],
          }
        }
      }
      if (contract?.kind === "faucet") return { title: "Mint test assets", detail: null, rows: [fee] }
    } catch {
      // Falls through to the generic text.
    }
    return { title: "Contract interaction", detail: shortAddress(call.to), rows: [fee] }
  }

  view(): DemoChainView {
    const account = this.account
    const pending = this.ledger.redemptions.filter((row) => key(row.walletAddress) === key(account) && row.status === "REQUESTED")
    return {
      native: demoAmount(this.ledger.native, 18),
      assets: this.assets.map((asset) => ({ symbol: asset.symbol, amount: demoAmount(this.ledger.balance(asset.address, account), asset.decimals) })),
      shares: this.products
        .map((product) => ({ product, balance: this.ledger.balance(product.token, account) }))
        .filter(({ balance }) => balance > 0n)
        .map(({ product, balance }) => ({ symbol: product.symbol, amount: demoAmount(balance, SHARE_DECIMALS) })),
      pendingWithdrawals: pending.length,
    }
  }

  /** The indexer's /api/v1/redemptions/<wallet> answer for the demo account; null for any other wallet. */
  redemptionsOf(wallet: string): GiwaRedemption[] | null {
    if (key(wallet) !== key(this.account)) return null
    return this.ledger.redemptions.filter((row) => key(row.walletAddress) === key(this.account)).map((row) => ({ ...row }))
  }
}
