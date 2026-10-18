import { encodeFunctionData, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem"
import type { GiwaDeploymentRegistry, RegistryProduct } from "../registry/types.js"

const accessAbi = parseAbi(["function greenlist(address account)", "function pause()", "function unpause()"])
const functionPausableAbi = parseAbi(["function pauseFn(bytes4 selector)", "function unpauseFn(bytes4 selector)"])

// Function-level pause (FunctionPausable.pauseFn/unpauseFn) selector map. "deposit" pauses
// BOTH deposit-vault entry paths; "withdraw" pauses BOTH redemption-vault entry paths.
// claimRedeem and admin selectors are deliberately NOT pausable here — already-requested
// redemptions stay claimable. Selectors from the deployed signatures:
//   deposit(uint256 paymentAssets, uint256 minSharesOut, address recipient)        = 0x8dbdbe6d
//   requestDeposit(uint256 paymentAssets, uint256 minSharesOut, address recipient) = 0x50814a4b
//   redeemInstant(uint256 sharesIn, uint256 minAssetsOut, address recipient)       = 0x8835e747
//   requestRedeem(uint256 sharesIn, uint256 minAssetsOut, address recipient)       = 0xbff2bab5
export const FUNCTION_PAUSE_SELECTORS = {
  deposit: {
    vault: "depositVault",
    selectors: [
      { name: "deposit", selector: "0x8dbdbe6d" },
      { name: "requestDeposit", selector: "0x50814a4b" },
    ],
  },
  withdraw: {
    vault: "redemptionVault",
    selectors: [
      { name: "redeemInstant", selector: "0x8835e747" },
      { name: "requestRedeem", selector: "0xbff2bab5" },
    ],
  },
} as const

export type FunctionPauseKind = keyof typeof FUNCTION_PAUSE_SELECTORS
const priceFeedAbi = parseAbi([
  "function setRoundDataSafe(int256 answer)",
  "function setHealthyDiff(uint256 healthyDiff_)",
])
const erc20Abi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"])
const redemptionVaultAbi = parseAbi(["function fulfillRedeem(uint256 requestId)"])
const depositVaultAbi = parseAbi(["function withdrawTo(address to, uint256 amount)"])
// Both vaults expose a function named `setLimits` with different arity — they MUST be separate
// ABI fragments, or encodeFunctionData({ functionName: "setLimits" }) is ambiguous.
const depositLimitsAbi = parseAbi([
  "function setLimits(uint256 minimumDeposit_, uint256 maxSupplyCap_, uint256 vaultMintAllowance_)",
])
const redemptionLimitsAbi = parseAbi(["function setLimits(uint256 minimumRedeem_, uint256 vaultRedeemAllowance_)"])
const SHARE_DECIMALS = 18

export type UnsignedAdminTransaction = {
  readonly chainId: number
  readonly to: Address
  readonly value: "0x0"
  readonly data: Hex
  readonly description: string
  readonly simulation: {
    /** not-run: the client wallet simulates. simulated / failed: the server ran an eth_call. */
    readonly status: "not-run" | "simulated" | "failed"
    readonly reason: string
  }
}

function addressOrThrow(value: unknown, label: string): Address {
  if (typeof value === "string" && isAddress(value)) return value
  throw new Error(`${label} is not available in the deployment registry`)
}

function productById(registry: GiwaDeploymentRegistry, productId: string): RegistryProduct {
  const product = registry.products.find((candidate) => candidate.productId === productId)
  if (!product) throw new Error(`Unknown productId ${productId}`)
  return product
}

/** Same unsigned shape for admin transactions built outside this module (e.g. ArcoUSD recalls). */
export function unsignedAdminTransaction(chainId: number, to: Address, data: Hex, description: string): UnsignedAdminTransaction {
  return tx(chainId, to, data, description)
}

function tx(chainId: number, to: Address, data: Hex, description: string): UnsignedAdminTransaction {
  return {
    chainId,
    to,
    value: "0x0",
    data,
    description,
    simulation: {
      status: "not-run",
      reason: "No signing or broadcast is performed by the API; client wallet must simulate/sign.",
    },
  }
}

export function buildGreenlistTransactions(registry: GiwaDeploymentRegistry, walletAddress: Address) {
  return registry.products.flatMap((product) => {
    const targets = [
      {
        address: addressOrThrow(product.productToken.proxy, `${product.symbol}.productToken.proxy`),
        label: `${product.symbol} product token`,
      },
      {
        address: addressOrThrow(product.depositVault.proxy, `${product.symbol}.depositVault.proxy`),
        label: `${product.symbol} deposit vault`,
      },
      {
        address: addressOrThrow(product.redemptionVault.proxy, `${product.symbol}.redemptionVault.proxy`),
        label: `${product.symbol} redemption vault`,
      },
    ]
    return targets.map((target) =>
      tx(
        registry.chainId,
        target.address,
        encodeFunctionData({ abi: accessAbi, functionName: "greenlist", args: [walletAddress] }),
        `Greenlist ${walletAddress} on ${target.label}`,
      ),
    )
  })
}

export function buildSetPriceTransaction(registry: GiwaDeploymentRegistry, productId: string, answer: bigint) {
  const product = productById(registry, productId)
  return tx(
    registry.chainId,
    addressOrThrow(product.priceFeed.proxy, `${product.symbol}.priceFeed.proxy`),
    encodeFunctionData({ abi: priceFeedAbi, functionName: "setRoundDataSafe", args: [answer] }),
    `Set ${product.symbol} product price feed answer`,
  )
}

export function buildSetHealthyDiffTransaction(registry: GiwaDeploymentRegistry, productId: string, seconds: bigint) {
  const product = productById(registry, productId)
  return tx(
    registry.chainId,
    addressOrThrow(product.priceFeed.proxy, `${product.symbol}.priceFeed.proxy`),
    encodeFunctionData({ abi: priceFeedAbi, functionName: "setHealthyDiff", args: [seconds] }),
    `Set ${product.symbol} price feed staleness window`,
  )
}

export function buildPauseTransactions(
  registry: GiwaDeploymentRegistry,
  productId: string,
  action: "pause" | "unpause",
  target: "depositVault" | "redemptionVault" | "allVaults" = "allVaults",
) {
  const product = productById(registry, productId)
  const vaults =
    target === "allVaults"
      ? (["depositVault", "redemptionVault"] as const)
      : ([target] as const)

  return vaults.map((vault) =>
    tx(
      registry.chainId,
      addressOrThrow(product[vault].proxy, `${product.symbol}.${vault}.proxy`),
      encodeFunctionData({ abi: accessAbi, functionName: action, args: [] }),
      `${action === "pause" ? "Pause" : "Unpause"} ${product.symbol} ${vault}`,
    ),
  )
}

// Per-kind function-level pause: one tx per entry-path selector (2 per kind). The
// whole-vault buildPauseTransactions above (Tier2 util) is a separate, coarser control.
export function buildFunctionPauseTransactions(
  registry: GiwaDeploymentRegistry,
  productId: string,
  kind: FunctionPauseKind,
  paused: boolean,
  /** Restrict to these selectors (live-state plan); defaults to both entry paths. */
  onlySelectors?: readonly string[],
) {
  const product = productById(registry, productId)
  const mapping = FUNCTION_PAUSE_SELECTORS[kind]
  const vaultAddress = addressOrThrow(product[mapping.vault].proxy, `${product.symbol}.${mapping.vault}.proxy`)
  const action = paused ? "pauseFn" : "unpauseFn"
  const label = kind === "deposit" ? "deposits" : "withdrawals"
  const selectors = onlySelectors
    ? mapping.selectors.filter(({ selector }) => onlySelectors.includes(selector))
    : mapping.selectors
  return selectors.map(({ name, selector }) =>
    tx(
      registry.chainId,
      vaultAddress,
      encodeFunctionData({ abi: functionPausableAbi, functionName: action, args: [selector as Hex] }),
      `${paused ? "Pause" : "Unpause"} ${product.symbol} ${label} (${name})`,
    ),
  )
}

export function buildLiquidityTransaction(registry: GiwaDeploymentRegistry, productId: string, amount: bigint) {
  const product = productById(registry, productId)
  const paymentAsset = registry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)
  if (!paymentAsset) throw new Error(`Missing payment asset ${product.paymentAssetSymbol}`)
  return tx(
    registry.chainId,
    addressOrThrow(paymentAsset.contract.proxy, `${paymentAsset.symbol}.contract.proxy`),
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [addressOrThrow(product.redemptionVault.proxy, `${product.symbol}.redemptionVault.proxy`), amount],
    }),
    `Provide ${product.paymentAssetSymbol} liquidity to ${product.symbol} redemption vault`,
  )
}

// Admin withdrawal of pooled deposits (ArcoDepositVault.withdrawTo, DEPOSIT_VAULT_ADMIN_ROLE).
// `to` is client-supplied (defaults to the connected operator wallet in the console) because
// signing is the trust boundary — the signer reviews the recipient. MAINNET HOOK: constrain
// `to` to a configured treasury/multisig allowlist here before building; the on-chain
// withdrawTo does NOT restrict the recipient.
export function buildWithdrawTransaction(
  registry: GiwaDeploymentRegistry,
  productId: string,
  to: Address,
  amount: bigint,
) {
  const product = productById(registry, productId)
  return tx(
    registry.chainId,
    addressOrThrow(product.depositVault.proxy, `${product.symbol}.depositVault.proxy`),
    encodeFunctionData({ abi: depositVaultAbi, functionName: "withdrawTo", args: [to, amount] }),
    `Withdraw ${product.paymentAssetSymbol} from ${product.symbol} deposit vault to ${to}`,
  )
}

// Direct-transfer redemption payout: payment token from the operator wallet to the requester.
// Mirrors buildLiquidityTransaction with the requester as recipient.
export function buildPayoutTransaction(
  registry: GiwaDeploymentRegistry,
  productId: string,
  requester: Address,
  amount: bigint,
) {
  const product = productById(registry, productId)
  const paymentAsset = registry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)
  if (!paymentAsset) throw new Error(`Missing payment asset ${product.paymentAssetSymbol}`)
  return tx(
    registry.chainId,
    addressOrThrow(paymentAsset.contract.proxy, `${paymentAsset.symbol}.contract.proxy`),
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [requester, amount] }),
    `Pay out ${product.paymentAssetSymbol} redemption to ${requester} (${product.symbol})`,
  )
}

export function buildFulfillRedeemTransaction(
  registry: GiwaDeploymentRegistry,
  redemptionVaultAddress: Address,
  requestId: bigint,
) {
  return tx(
    registry.chainId,
    redemptionVaultAddress,
    encodeFunctionData({ abi: redemptionVaultAbi, functionName: "fulfillRedeem", args: [requestId] }),
    `Fulfill redemption request ${requestId.toString()}`,
  )
}

function paymentDecimalsOf(registry: GiwaDeploymentRegistry, product: RegistryProduct): number {
  const paymentAsset = registry.assets.find((asset) => asset.symbol === product.paymentAssetSymbol)
  if (!paymentAsset) throw new Error(`Missing payment asset ${product.paymentAssetSymbol}`)
  return paymentAsset.decimals
}

// ArcoDepositVault.setLimits(minimumDeposit, maxSupplyCap, vaultMintAllowance) — DEPOSIT_VAULT_ADMIN_ROLE.
// Inputs are HUMAN units; scaled server-side per the registry decimals: minimumDeposit in PAYMENT units
// (10^paymentDecimals), the two caps in 18-dec SHARES. parseUnits throws on a malformed number.
export function buildSetDepositLimitsTransaction(
  registry: GiwaDeploymentRegistry,
  productId: string,
  limits: { minimumDeposit: string; maxSupplyCap: string; vaultMintAllowance: string },
) {
  const product = productById(registry, productId)
  const paymentDecimals = paymentDecimalsOf(registry, product)
  return tx(
    registry.chainId,
    addressOrThrow(product.depositVault.proxy, `${product.symbol}.depositVault.proxy`),
    encodeFunctionData({
      abi: depositLimitsAbi,
      functionName: "setLimits",
      args: [
        parseUnits(limits.minimumDeposit, paymentDecimals),
        parseUnits(limits.maxSupplyCap, SHARE_DECIMALS),
        parseUnits(limits.vaultMintAllowance, SHARE_DECIMALS),
      ],
    }),
    `Set ${product.symbol} deposit vault limits`,
  )
}

// ArcoRedemptionVault.setLimits(minimumRedeem, vaultRedeemAllowance) — REDEMPTION_VAULT_ADMIN_ROLE.
// minimumRedeem in 18-dec SHARES; vaultRedeemAllowance in PAYMENT units.
export function buildSetRedemptionLimitsTransaction(
  registry: GiwaDeploymentRegistry,
  productId: string,
  limits: { minimumRedeem: string; vaultRedeemAllowance: string },
) {
  const product = productById(registry, productId)
  const paymentDecimals = paymentDecimalsOf(registry, product)
  return tx(
    registry.chainId,
    addressOrThrow(product.redemptionVault.proxy, `${product.symbol}.redemptionVault.proxy`),
    encodeFunctionData({
      abi: redemptionLimitsAbi,
      functionName: "setLimits",
      args: [parseUnits(limits.minimumRedeem, SHARE_DECIMALS), parseUnits(limits.vaultRedeemAllowance, paymentDecimals)],
    }),
    `Set ${product.symbol} redemption vault limits`,
  )
}
