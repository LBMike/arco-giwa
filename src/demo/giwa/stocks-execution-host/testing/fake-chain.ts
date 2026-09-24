// TEST FIXTURE ONLY. Never import this module from product code.
//
// An in-memory EVM-shaped chain for the Stocks test manifest (server/src/stocks/test-fixtures.ts testManifest()).
// It answers the JSON-RPC reads the server RPC port (server/src/stocks/rpc.ts), deployment evidence and receipt
// verification issue, holds ERC-20 state for the cash and stock tokens, and applies exactly three reviewed calls:
// approve on either token, depositForOrder on the funding vault and escrowForOrder on the redemption escrow.
// Anything else is mined as a revert (status 0x0, no logs). There is no signing, gas or mempool. eth_call reads
// current state whatever block tag is given. Network variants let a wallet view see another network.

import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, toHex, type Abi, type Address, type Hex } from "viem"

import type { ManifestV2 } from "../../stocks-wallet/types"

export type NetworkVariant = "reviewed" | "other-checkpoint" | "other-chain" | "missing-checkpoint"
export type RpcTransport = (method: string, params: unknown[]) => Promise<unknown>
export type ChainTransactionRequest = { from: string; to: string; data: string; value?: string }
export type AppliedTransaction = Readonly<{ hash: Hex; from: Address; to: Address; data: Hex; value: bigint; nonce: bigint; blockNumber: bigint; status: "success" | "reverted" }>
export type ForeignTransaction = Readonly<{ hash: Hex; network: NetworkVariant; request: ChainTransactionRequest }>

type Log = { address: Address; topics: Hex[]; data: Hex }
type Block = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint; transactions: Hex[] }
type Mined = { tx: AppliedTransaction; logs: Log[]; blockHash: Hex }

const REVIEWED_CHAIN_ID = 91342n
const CODE = "0x6000"
const CALLS_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function depositForOrder(bytes32 orderKey,uint256 amount)",
  "function escrowForOrder(bytes32 orderKey,address token,uint256 quantity)",
])
const READS_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
])
const EVENTS_ABI = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
  "event FundingReceived(bytes32 indexed orderKey,address indexed payer,address token,uint256 amount)",
  "event StockEscrowed(bytes32 indexed escrowId,bytes32 indexed orderKey,address indexed payer,address token,uint256 quantity)",
])
const SERVER_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getTransactionByHash", "eth_getTransactionReceipt"])

export function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code })
}

const quantity = (value: bigint): Hex => `0x${value.toString(16)}`
const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`
const lower = (value: string) => value.toLowerCase() as Address

function addressParam(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw rpcError(-32602, "invalid address")
  return lower(value)
}

function dataParam(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw rpcError(-32602, "invalid data")
  return value.toLowerCase() as Hex
}

function valueParam(value: unknown): bigint {
  if (value === undefined) return 0n
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw rpcError(-32602, "invalid value")
  return BigInt(value)
}

function eventLog(address: string, eventName: "Transfer" | "Approval" | "FundingReceived" | "StockEscrowed", args: Record<string, unknown>): Log {
  const inputs = EVENTS_ABI.find((entry) => entry.name === eventName)!.inputs as readonly { name: string; type: string; indexed?: boolean }[]
  const indexed = Object.fromEntries(inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name]]))
  const plain = inputs.filter((input) => !input.indexed)
  const topics = encodeEventTopics({ abi: EVENTS_ABI as Abi, eventName, args: indexed }) as Hex[]
  return { address: lower(address), topics: topics.map((topic) => topic.toLowerCase() as Hex), data: encodeAbiParameters(plain, plain.map((input) => args[input.name]) as never) }
}

export type FakeChain = ReturnType<typeof createFakeChain>

export function createFakeChain(manifest: ManifestV2, options: { now?: () => number; finalizeImmediately?: boolean } = {}) {
  const now = options.now ?? Date.now
  const m = manifest
  const cashToken = lower(m.cashToken), stockToken = lower(m.stockToken), fundingVault = lower(m.fundingVault)
  const mintController = lower(m.mintController), redemptionEscrow = lower(m.redemptionEscrow), operator = lower(m.signerAddress)
  const contracts = new Set<string>([cashToken, stockToken, fundingVault, mintController, redemptionEscrow])
  const tokens = new Set<string>([cashToken, stockToken])
  const decimals = new Map<string, bigint>([[cashToken, 6n], [stockToken, 9n]])
  const checkpointNumber = BigInt(m.checkpointNumber)
  const otherCheckpointHash = keccak256(toHex("fake-chain:other-checkpoint"))

  const getters = new Map<string, Hex>()
  const bindings: [string, string, string][] = [
    [stockToken, "mintController", mintController], [stockToken, "redemptionEscrow", redemptionEscrow],
    [fundingVault, "cashToken", cashToken], [fundingVault, "redemptionEscrow", redemptionEscrow], [fundingVault, "operator", operator],
    [mintController, "stockToken", stockToken], [mintController, "operator", operator],
    [redemptionEscrow, "stockToken", stockToken], [redemptionEscrow, "cashToken", cashToken], [redemptionEscrow, "fundingVault", fundingVault], [redemptionEscrow, "operator", operator],
  ]
  for (const [target, getter, value] of bindings) {
    const data = encodeFunctionData({ abi: parseAbi([`function ${getter}() view returns (address)`]), functionName: getter })
    getters.set(`${target}:${data}`, word(BigInt(value)))
  }

  const balances = new Map<string, bigint>()
  const allowances = new Map<string, bigint>()
  const supply = new Map<string, bigint>([[cashToken, 0n], [stockToken, 0n]])
  const nonces = new Map<string, bigint>()
  const blocks: Block[] = []
  const mined = new Map<string, Mined>()
  const applied: AppliedTransaction[] = []
  const foreign: ForeignTransaction[] = []
  const serverCalls: { method: string; params: unknown[] }[] = []
  let finalizeImmediately = options.finalizeImmediately ?? true
  let finalized = checkpointNumber
  let revertNext = false

  const balanceKey = (token: string, owner: string) => `${token}:${owner}`
  const allowanceKey = (token: string, owner: string, spender: string) => `${token}:${owner}:${spender}`
  const balance = (token: string, owner: string) => balances.get(balanceKey(token, lower(owner))) ?? 0n
  const allowance = (token: string, owner: string, spender: string) => allowances.get(allowanceKey(token, lower(owner), lower(spender))) ?? 0n

  function blockTimestamp(): bigint {
    const previous = blocks.length > 0 ? blocks[blocks.length - 1]!.timestamp : 0n
    const current = BigInt(Math.floor(now() / 1000))
    return current > previous ? current : previous
  }

  function appendBlock(transactions: Hex[], hash?: Hex): Block {
    const number = BigInt(blocks.length)
    const parentHash = blocks.length > 0 ? blocks[blocks.length - 1]!.hash : (`0x${"0".repeat(64)}` as Hex)
    const timestamp = blockTimestamp()
    const blockHash = hash ?? keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], [number, parentHash, transactions[0] ?? parentHash, timestamp]))
    const block = { number, hash: blockHash, parentHash, timestamp, transactions }
    blocks.push(block)
    if (finalizeImmediately) finalized = number
    return block
  }
  // Genesis through the checkpoint; the checkpoint block carries the reviewed hash.
  for (let n = 0n; n <= checkpointNumber; n++) appendBlock([], n === checkpointNumber ? m.checkpointHash : keccak256(toHex(`fake-chain:block:${n}`)))
  finalized = checkpointNumber

  function transfer(token: string, from: string, to: string, amount: bigint): boolean {
    const available = balance(token, from)
    if (amount <= 0n || available < amount) return false
    balances.set(balanceKey(token, from), available - amount)
    balances.set(balanceKey(token, to), balance(token, to) + amount)
    return true
  }

  function spend(token: string, owner: string, spender: string, amount: bigint): boolean {
    const approved = allowance(token, owner, spender)
    if (approved < amount || balance(token, owner) < amount) return false
    allowances.set(allowanceKey(token, owner, spender), approved - amount)
    return transfer(token, owner, spender, amount)
  }

  /** Effects and logs of a reviewed call, or null for a revert. State changes only when non-null. */
  function effects(from: Address, to: Address, data: Hex, value: bigint): Log[] | null {
    if (value !== 0n || !contracts.has(to)) return null
    let call: { functionName: string; args: readonly unknown[] }
    try {
      call = decodeFunctionData({ abi: CALLS_ABI, data }) as typeof call
    } catch {
      return null
    }
    if (call.functionName === "approve" && tokens.has(to)) {
      const [spender, amount] = call.args as [Address, bigint]
      allowances.set(allowanceKey(to, from, lower(spender)), amount)
      return [eventLog(to, "Approval", { owner: from, spender: lower(spender), value: amount })]
    }
    if (call.functionName === "depositForOrder" && to === fundingVault) {
      const [orderKey, amount] = call.args as [Hex, bigint]
      if (!spend(cashToken, from, fundingVault, amount)) return null
      return [eventLog(cashToken, "Transfer", { from, to: fundingVault, value: amount }), eventLog(fundingVault, "FundingReceived", { orderKey, payer: from, token: cashToken, amount })]
    }
    if (call.functionName === "escrowForOrder" && to === redemptionEscrow) {
      const [orderKey, token, amount] = call.args as [Hex, Address, bigint]
      if (lower(token) !== stockToken || !spend(stockToken, from, redemptionEscrow, amount)) return null
      const escrowId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" }], [orderKey, from, stockToken]))
      return [eventLog(stockToken, "Transfer", { from, to: redemptionEscrow, value: amount }), eventLog(redemptionEscrow, "StockEscrowed", { escrowId, orderKey, payer: from, token: stockToken, quantity: amount })]
    }
    return null
  }

  function transactionHash(from: Address, nonce: bigint, to: Address, data: Hex): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes" }], [from, nonce, to, data]))
  }

  /** Applies one transaction on the reviewed chain: one new block, deterministic hash. */
  function sendTransaction(request: ChainTransactionRequest, network: NetworkVariant = "reviewed"): Hex {
    const from = addressParam(request.from), to = addressParam(request.to), data = dataParam(request.data), value = valueParam(request.value)
    const nonce = nonces.get(from) ?? 0n
    nonces.set(from, nonce + 1n)
    if (network !== "reviewed") {
      // A transaction sent to another network never becomes visible on the reviewed chain.
      const hash = keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], [network, transactionHash(from, nonce, to, data)]))
      foreign.push(Object.freeze({ hash, network, request: { ...request } }))
      return hash
    }
    const hash = transactionHash(from, nonce, to, data)
    const logs = revertNext ? null : effects(from, to, data, value)
    revertNext = false
    const block = appendBlock([hash])
    const tx: AppliedTransaction = Object.freeze({ hash, from, to, data, value, nonce, blockNumber: block.number, status: logs === null ? "reverted" : "success" })
    applied.push(tx)
    mined.set(hash, { tx, logs: logs ?? [], blockHash: block.hash })
    return hash
  }

  function blockTag(value: unknown): bigint | null {
    const latest = BigInt(blocks.length - 1)
    if (value === "latest" || value === "pending") return latest
    if (value === "finalized" || value === "safe") return finalized
    if (value === "earliest") return 0n
    if (typeof value !== "string" || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value)) throw rpcError(-32602, "invalid block tag")
    const number = BigInt(value)
    return number <= latest ? number : null
  }

  function blockJson(block: Block, network: NetworkVariant) {
    let hash = block.hash
    if (block.number === checkpointNumber && network === "other-checkpoint") hash = otherCheckpointHash
    if (block.number === checkpointNumber && network === "missing-checkpoint") return null
    return { number: quantity(block.number), hash, parentHash: block.parentHash, timestamp: quantity(block.timestamp), transactions: [...block.transactions] }
  }

  function call(params: unknown[]): Hex {
    const request = params[0] as { to?: unknown; data?: unknown } | undefined
    const to = addressParam(request?.to), data = dataParam(request?.data)
    blockTag(params[1] ?? "latest")
    const getter = getters.get(`${to}:${data}`)
    if (getter) return getter
    if (tokens.has(to)) {
      try {
        const read = decodeFunctionData({ abi: READS_ABI, data }) as { functionName: string; args?: readonly unknown[] }
        if (read.functionName === "balanceOf") return word(balance(to, String(read.args![0])))
        if (read.functionName === "allowance") return word(allowance(to, String(read.args![0]), String(read.args![1])))
        if (read.functionName === "totalSupply") return word(supply.get(to)!)
        if (read.functionName === "decimals") return word(decimals.get(to)!)
      } catch {
        // fall through to revert
      }
    }
    throw rpcError(3, "execution reverted")
  }

  function transactionJson(hash: unknown) {
    const entry = typeof hash === "string" ? mined.get(hash.toLowerCase()) : undefined
    if (!entry) return null
    const { tx } = entry
    return { hash: tx.hash, from: tx.from, to: tx.to, input: tx.data, value: quantity(tx.value), nonce: quantity(tx.nonce), blockHash: entry.blockHash, blockNumber: quantity(tx.blockNumber), transactionIndex: "0x0", chainId: quantity(REVIEWED_CHAIN_ID) }
  }

  function receiptJson(hash: unknown) {
    const entry = typeof hash === "string" ? mined.get(hash.toLowerCase()) : undefined
    if (!entry) return null
    const { tx } = entry
    const blockNumber = quantity(tx.blockNumber)
    const logs = entry.logs.map((log, index) => ({ address: log.address, topics: [...log.topics], data: log.data, blockNumber, blockHash: entry.blockHash, transactionHash: tx.hash, transactionIndex: "0x0", logIndex: quantity(BigInt(index)), removed: false }))
    return { transactionHash: tx.hash, transactionIndex: "0x0", blockHash: entry.blockHash, blockNumber, from: tx.from, to: tx.to, status: tx.status === "success" ? "0x1" : "0x0", logs, cumulativeGasUsed: "0x0", gasUsed: "0x0", contractAddress: null }
  }

  /** Synchronous JSON-RPC answer for a network view. Throws { code } errors like a node. */
  function answer(network: NetworkVariant, method: string, params: unknown[] = []): unknown {
    switch (method) {
      case "eth_chainId": return network === "other-chain" ? "0x1" : quantity(REVIEWED_CHAIN_ID)
      case "eth_blockNumber": return quantity(BigInt(blocks.length - 1))
      case "eth_getBlockByNumber": {
        const number = blockTag(params[0])
        return number === null ? null : blockJson(blocks[Number(number)]!, network)
      }
      case "eth_getCode": {
        const target = addressParam(params[0])
        blockTag(params[1] ?? "latest")
        return contracts.has(target) ? CODE : "0x"
      }
      case "eth_call": return call(params)
      case "eth_getTransactionByHash": return network === "reviewed" ? transactionJson(params[0]) : null
      case "eth_getTransactionReceipt": return network === "reviewed" ? receiptJson(params[0]) : null
      default: throw rpcError(-32601, "method not found")
    }
  }

  /** Server-side JsonRpcTransport: always the reviewed network, read methods only. */
  const rpc: RpcTransport = async (method, params) => {
    serverCalls.push({ method, params: structuredClone(params) })
    if (!SERVER_METHODS.has(method)) throw rpcError(-32601, "method not found")
    return structuredClone(answer("reviewed", method, params))
  }

  function mint(token: string, wallet: string, amount: bigint | string) {
    const value = BigInt(amount)
    if (value < 0n) throw new Error("NEGATIVE_MINT")
    balances.set(balanceKey(token, lower(wallet)), balance(token, wallet) + value)
    supply.set(token, supply.get(token)! + value)
  }

  return Object.freeze({
    chainId: 91342 as const,
    manifest: m,
    rpc,
    answer,
    sendTransaction,
    mintCash: (wallet: string, amount: bigint | string) => mint(cashToken, wallet, amount),
    mintStock: (wallet: string, amount: bigint | string) => mint(stockToken, wallet, amount),
    balanceOf: (token: string, wallet: string) => balance(lower(token), wallet),
    allowance: (token: string, owner: string, spender: string) => allowance(lower(token), owner, spender),
    totalSupply: (token: string) => supply.get(lower(token)) ?? 0n,
    /** The next reviewed transaction is mined as a revert whatever it calls. */
    revertNextTransaction() { revertNext = true },
    setFinalizeImmediately(value: boolean) { finalizeImmediately = value; if (value) finalized = BigInt(blocks.length - 1) },
    /** Moves the finalized head to the latest block. */
    finalize() { finalized = BigInt(blocks.length - 1) },
    get latestBlock() { return BigInt(blocks.length - 1) },
    get finalizedBlock() { return finalized },
    get transactions(): readonly AppliedTransaction[] { return applied },
    get foreignTransactions(): readonly ForeignTransaction[] { return foreign },
    get serverCalls(): readonly { method: string; params: unknown[] }[] { return serverCalls },
  })
}
