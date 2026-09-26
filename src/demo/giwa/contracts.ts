import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  type Abi,
  type Hex,
  type WalletClient,
} from "viem"
import { GIWA_PUBLIC_RPC, giwaSepolia } from "./config"
import { vaultAddressForOperation, type ProductOperation } from "./operation-routing"
import type { GiwaCatalogItem, HexAddress, UnsignedAdminTransaction } from "./types"
import type { ActiveWalletSource } from "./stocks-wallet-source/types"

const faucetAbi = parseAbi(["function drip(address token)"])
const faucetWithDripAllAbi = parseAbi(["function drip(address token)", "function dripAll()"])
const productTokenAbi = parseAbi(["function greenlistEnforced() view returns (bool)"])
const priceFeedReadAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function healthyDiff() view returns (uint256)",
  "function minExpectedAnswer() view returns (uint256)",
  "function maxExpectedAnswer() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function decimals() view returns (uint8)",
])
const depositVaultAbi = parseAbi([
  "function deposit(uint256 paymentAssets, uint256 minSharesOut, address recipient) returns (uint256)",
  "function requestDeposit(uint256 paymentAssets, uint256 minSharesOut, address recipient) returns (uint256)",
])
const redemptionVaultAbi = parseAbi([
  "function redeemInstant(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256)",
  "function requestRedeem(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256)",
  "function claimRedeem(uint256 requestId)",
])

// Testnet-only zero slippage floor for GIWA preprod. Before any mainnet reuse,
// minSharesOut/minAssetsOut must be made user-configurable and non-zero by default.
const TESTNET_ZERO_SLIPPAGE_FLOOR = 0n

const accessControlAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"])

/** AccessControl role ids the admin screens check before a wallet signs (keccak256 of the role name). */
export const ADMIN_ROLE_IDS = {
  FEED_ADMIN_ROLE: keccak256(toBytes("FEED_ADMIN_ROLE")),
  PAUSER_ROLE: keccak256(toBytes("PAUSER_ROLE")),
} as const
export type AdminRoleName = keyof typeof ADMIN_ROLE_IDS

export const publicGiwaClient = createPublicClient({
  chain: giwaSepolia,
  transport: http(GIWA_PUBLIC_RPC),
})

export function toBaseUnits(value: string, decimals: number) {
  const normalized = value.trim() || "0"
  return parseUnits(normalized, decimals)
}

export function fromBaseUnits(value: bigint, decimals: number) {
  return formatUnits(value, decimals)
}

type ActiveWalletClient = Pick<WalletClient, "sendTransaction" | "writeContract"> &
  Partial<Pick<WalletClient, "getAddresses" | "getChainId" | "signMessage">>
type SimulateContractClient = {
  simulateContract(args: Record<string, unknown>): Promise<{ request: unknown }>
}
type ContractWriter = {
  writeContract(request: unknown): Promise<Hex>
}

type DynamicRawProvider = Extract<ActiveWalletSource, { mode: "dynamic" }>["rawProvider"]
let walletSource: { mode: "injected" } | { mode: "dynamic"; client: ActiveWalletClient | null; rawProvider?: DynamicRawProvider; readRawProvider?: () => DynamicRawProvider } = { mode: "injected" }

export function setInjectedWalletSource() {
  walletSource = { mode: "injected" }
}

export function setDynamicWalletClient(client: ActiveWalletClient | null, rawProvider?: DynamicRawProvider, readRawProvider?: () => DynamicRawProvider) {
  walletSource = { mode: "dynamic", client, ...(client && rawProvider ? { rawProvider, readRawProvider } : {}) }
}

/** Read-only view of the active source object. It creates no client and issues no request. */
export function activeWalletSource(): ActiveWalletSource {
  if (walletSource.mode === "dynamic") {
    const { client, rawProvider, readRawProvider } = walletSource
    if (!rawProvider) return { mode: "dynamic", client }
    try { return { mode: "dynamic", client, rawProvider: readRawProvider ? readRawProvider() : rawProvider } }
    catch { return { mode: "dynamic", client, rawProvider: null } }
  }
  return { mode: "injected", provider: typeof window === "undefined" ? null : window.ethereum ?? null }
}

function browserProvider() {
  if (!window.ethereum) throw new Error("Injected wallet not found")
  return window.ethereum
}

export function walletClient() {
  if (walletSource.mode === "dynamic") {
    if (!walletSource.client) {
      throw new Error("Dynamic wallet client is unavailable. Connect and switch to GIWA Sepolia.")
    }
    return walletSource.client
  }
  return createWalletClient({
    chain: giwaSepolia,
    transport: custom(browserProvider()),
  })
}

type ReceiptClient = {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string }>
}

type EstimateGasClient = {
  estimateGas(args: { account: HexAddress; to: HexAddress; data: Hex; value: bigint }): Promise<bigint>
}

type PreparedWalletClient = {
  sendTransaction(args: {
    account: HexAddress
    chain: typeof giwaSepolia
    to: HexAddress
    data: Hex
    value: bigint
  }): Promise<Hex>
}

export function readableError(err: unknown) {
  const shortMessage = typeof err === "object" && err && "shortMessage" in err ? String(err.shortMessage) : null
  return shortMessage ?? (err instanceof Error ? err.message : String(err))
}

function isMissingFunctionError(err: unknown) {
  return /selector|function.*not|no data|does not exist|unknown function|decode/i.test(readableError(err))
}

function preparedTransactionValue(tx: UnsignedAdminTransaction) {
  return tx.value === "0x0" ? 0n : BigInt(tx.value)
}

function assertBackendSimulationHint(tx: UnsignedAdminTransaction) {
  const status = tx.simulation?.status?.toLowerCase()
  if (!status || status === "success" || status === "ok" || status === "not-run" || status === "skipped") return
  throw new Error(tx.simulation?.reason ? `Backend simulation failed: ${tx.simulation.reason}` : "Backend simulation failed")
}

export async function waitForSuccessfulReceipt(hash: Hex, client: ReceiptClient = publicGiwaClient as ReceiptClient) {
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== "success") throw new Error("Transaction reverted before confirmation")
  return receipt
}

export async function afterConfirmedReceipt(
  hash: Hex,
  refreshReads: () => Promise<unknown> | unknown,
  client: ReceiptClient = publicGiwaClient as ReceiptClient,
) {
  const receipt = await waitForSuccessfulReceipt(hash, client)
  await refreshReads()
  return receipt
}

export async function estimatePreparedTransaction(
  account: HexAddress,
  tx: UnsignedAdminTransaction,
  client: EstimateGasClient = publicGiwaClient as EstimateGasClient,
) {
  assertBackendSimulationHint(tx)
  try {
    await client.estimateGas({
      account,
      to: tx.to,
      data: tx.data,
      value: preparedTransactionValue(tx),
    })
  } catch (err) {
    throw new Error(`Transaction simulation failed: ${readableError(err)}`)
  }
}

export async function sendPreparedTransactionWithClients(
  account: HexAddress,
  tx: UnsignedAdminTransaction,
  clients: { publicClient?: EstimateGasClient; wallet?: PreparedWalletClient } = {},
) {
  await estimatePreparedTransaction(account, tx, clients.publicClient ?? (publicGiwaClient as EstimateGasClient))
  const client = clients.wallet ?? (walletClient() as PreparedWalletClient)
  return client.sendTransaction({
    account,
    chain: giwaSepolia,
    to: tx.to,
    data: tx.data,
    value: preparedTransactionValue(tx),
  })
}

export async function sendPreparedTransaction(account: HexAddress, tx: UnsignedAdminTransaction) {
  return sendPreparedTransactionWithClients(account, tx)
}

export async function simulateAndWriteWithClients(args: {
  account: HexAddress
  address: HexAddress
  abi: Abi
  functionName: string
  args: readonly unknown[]
}, clients: { publicClient?: SimulateContractClient; wallet?: ContractWriter } = {}) {
  const simulation = await (clients.publicClient ?? (publicGiwaClient as unknown as SimulateContractClient)).simulateContract({
    account: args.account,
    address: args.address,
    abi: args.abi,
    functionName: args.functionName,
    args: [...args.args],
  })
  return (clients.wallet ?? (walletClient() as unknown as ContractWriter)).writeContract(simulation.request)
}

async function simulateAndWrite(args: {
  account: HexAddress
  address: HexAddress
  abi: Abi
  functionName: string
  args: readonly unknown[]
}) {
  return simulateAndWriteWithClients(args)
}

export async function readTokenBalance(token: HexAddress, account: HexAddress, decimals: number) {
  const balance = await publicGiwaClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  })
  return fromBaseUnits(balance, decimals)
}

export async function readGreenlistEnforced(productToken: HexAddress) {
  try {
    return await publicGiwaClient.readContract({
      address: productToken,
      abi: productTokenAbi,
      functionName: "greenlistEnforced",
    })
  } catch (err) {
    if (isMissingFunctionError(err)) return false
    throw err
  }
}

export type PriceFeedState = {
  answer: bigint
  updatedAt: bigint
  roundId: bigint
  healthyDiff: bigint
  min: bigint
  max: bigint
  maxDeviationBps: bigint
  decimals: number
}

// Reads the on-chain ProductPriceFeed via the public RPC. Uses parallel readContract
// calls (not multicall) so it does not depend on a Multicall3 deployment on GIWA Sepolia.
export async function readPriceFeedState(priceFeed: HexAddress): Promise<PriceFeedState> {
  const base = { address: priceFeed, abi: priceFeedReadAbi } as const
  const [latestRoundData, healthyDiff, min, max, maxDeviationBps, decimals] = await Promise.all([
    publicGiwaClient.readContract({ ...base, functionName: "latestRoundData" }),
    publicGiwaClient.readContract({ ...base, functionName: "healthyDiff" }),
    publicGiwaClient.readContract({ ...base, functionName: "minExpectedAnswer" }),
    publicGiwaClient.readContract({ ...base, functionName: "maxExpectedAnswer" }),
    publicGiwaClient.readContract({ ...base, functionName: "maxDeviationBps" }),
    publicGiwaClient.readContract({ ...base, functionName: "decimals" }),
  ])
  const [roundId, answer, , updatedAt] = latestRoundData as readonly [bigint, bigint, bigint, bigint, bigint]
  return {
    answer,
    updatedAt,
    roundId,
    healthyDiff: healthyDiff as bigint,
    min: min as bigint,
    max: max as bigint,
    maxDeviationBps: maxDeviationBps as bigint,
    decimals: Number(decimals),
  }
}

/** Read-only: whether `account` holds `role` on an AccessControl contract (price feed, vault). */
export async function readHasRole(contract: HexAddress, role: AdminRoleName, account: HexAddress): Promise<boolean> {
  return (await publicGiwaClient.readContract({
    address: contract,
    abi: accessControlAbi,
    functionName: "hasRole",
    args: [ADMIN_ROLE_IDS[role], account],
  })) as boolean
}

// Reads productToken.totalSupply()/decimals() so the panel can derive human shares
// outstanding (totalSupply / 10**decimals) for NAV-per-share pricing.
export async function readShareSupply(productToken: HexAddress): Promise<{ supply: bigint; decimals: number }> {
  const [supply, decimals] = await Promise.all([
    publicGiwaClient.readContract({ address: productToken, abi: erc20Abi, functionName: "totalSupply" }),
    publicGiwaClient.readContract({ address: productToken, abi: erc20Abi, functionName: "decimals" }),
  ])
  return { supply: supply as bigint, decimals: Number(decimals) }
}

export async function readAllowance(token: HexAddress, owner: HexAddress, spender: HexAddress, decimals: number) {
  const allowance = await publicGiwaClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })
  return {
    raw: allowance,
    display: fromBaseUnits(allowance, decimals),
  }
}

export async function approveVault(args: {
  account: HexAddress
  token: HexAddress
  vault: HexAddress
  amount: bigint
}) {
  return simulateAndWrite({
    account: args.account,
    address: args.token,
    abi: erc20Abi,
    functionName: "approve",
    args: [args.vault, args.amount],
  })
}

export async function dripTestAsset(args: { account: HexAddress; faucet: HexAddress; token: HexAddress }) {
  return simulateAndWrite({
    account: args.account,
    address: args.faucet,
    abi: faucetAbi,
    functionName: "drip",
    args: [args.token],
  })
}

export type FaucetDripAllResult =
  | { mode: "dripAll"; hashes: Hex[]; fallbackReason?: undefined }
  | { mode: "perAssetFallback"; hashes: Hex[]; fallbackReason: string }

export async function dripAllTestAssetsWithClients(
  args: { account: HexAddress; faucet: HexAddress; tokens: readonly HexAddress[] },
  clients: { publicClient?: SimulateContractClient; wallet?: ContractWriter } = {},
): Promise<FaucetDripAllResult> {
  try {
    const hash = await simulateAndWriteWithClients(
      {
        account: args.account,
        address: args.faucet,
        abi: faucetWithDripAllAbi,
        functionName: "dripAll",
        args: [],
      },
      clients,
    )
    return { mode: "dripAll", hashes: [hash] }
  } catch (err) {
    if (!isMissingFunctionError(err)) {
      throw err
    }
    if (args.tokens.length === 0) {
      throw new Error(`Faucet dripAll is unavailable and no configured assets were provided: ${readableError(err)}`)
    }
    const hashes: Hex[] = []
    for (const token of args.tokens) {
      hashes.push(
        await simulateAndWriteWithClients(
          {
            account: args.account,
            address: args.faucet,
            abi: faucetAbi,
            functionName: "drip",
            args: [token],
          },
          clients,
        ),
      )
    }
    return {
      mode: "perAssetFallback",
      hashes,
      fallbackReason: readableError(err),
    }
  }
}

export async function dripAllTestAssets(args: { account: HexAddress; faucet: HexAddress; tokens: readonly HexAddress[] }) {
  return dripAllTestAssetsWithClients(args)
}

export function encodedOperationCall(
  product: GiwaCatalogItem,
  operation: ProductOperation,
  amount: bigint,
  recipient: HexAddress,
  requestId?: bigint,
): { to: HexAddress | null; data: Hex; requiresApproval: boolean } {
  const to = vaultAddressForOperation(product, operation)
  if (!to) return { to: null, data: "0x", requiresApproval: false }

  if (operation === "claimRedeem") {
    return {
      to,
      data: encodeFunctionData({ abi: redemptionVaultAbi, functionName: "claimRedeem", args: [requestId ?? 0n] }),
      requiresApproval: false,
    }
  }

  if (operation === "deposit" || operation === "requestDeposit") {
    return {
      to,
      data: encodeFunctionData({
        abi: depositVaultAbi,
        functionName: operation,
        args: [amount, TESTNET_ZERO_SLIPPAGE_FLOOR, recipient],
      }),
      requiresApproval: true,
    }
  }

  return {
    to,
    data: encodeFunctionData({
      abi: redemptionVaultAbi,
      functionName: operation,
      args: [amount, TESTNET_ZERO_SLIPPAGE_FLOOR, recipient],
    }),
    requiresApproval: false,
  }
}

export async function submitProductOperation(args: {
  account: HexAddress
  product: GiwaCatalogItem
  operation: ProductOperation
  amount: bigint
  requestId?: bigint
}) {
  const to = vaultAddressForOperation(args.product, args.operation)
  if (!to) throw new Error("Vault address is missing from the registry")
  if (args.operation === "claimRedeem") {
    return simulateAndWrite({
      account: args.account,
      address: to,
      abi: redemptionVaultAbi,
      functionName: "claimRedeem",
      args: [args.requestId ?? 0n],
    })
  }
  if (args.operation === "deposit" || args.operation === "requestDeposit") {
    return simulateAndWrite({
      account: args.account,
      address: to,
      abi: depositVaultAbi,
      functionName: args.operation,
      args: [args.amount, TESTNET_ZERO_SLIPPAGE_FLOOR, args.account],
    })
  }
  return simulateAndWrite({
    account: args.account,
    address: to,
    abi: redemptionVaultAbi,
    functionName: args.operation,
    args: [args.amount, TESTNET_ZERO_SLIPPAGE_FLOOR, args.account],
  })
}

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<T>
      on?: (event: string, handler: (...args: unknown[]) => void) => void
      removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
    }
  }
}
