import { BigNumber, Contract, ContractReceipt, ContractTransaction, Overrides, Signer, constants, utils } from "ethers"
import { artifacts, ethers, upgrades } from "hardhat"
import {
  earliestBlock,
  type Address,
  type ArcoUSDContract,
  type ArcoUSDRegistry,
  type ArcoUSDReserveAsset,
} from "./arcousd-registry"

// Idempotent, resumable ArcoUSD deployment. Every step first checks the registry AND the chain,
// so re-running after a crash or timeout never deploys twice or re-sends a grant. The same
// executor runs in the hardhat test (test/arcousd-deploy.test.ts) and on GIWA via
// scripts/deploy-arcousd-giwa.ts.

export type CoreRefs = {
  admin: Address
  faucet: Address
  /** Core payment assets the Reserve accepts (tUSDC), from the core registry. */
  assets: Record<string, { address: Address; decimals: number }>
  /** Arco products usable as MMF strategies, from the core registry. */
  products: Record<string, { depositVault: Address; redemptionVault: Address; productToken: Address }>
}

export type DeployContext = {
  signer: Signer & { address: string }
  registry: ArcoUSDRegistry
  core: CoreRefs
  save: (registry: ArcoUSDRegistry) => void
  log?: (message: string) => void
  txOverrides?: (kind: "deploy" | "call") => Promise<Overrides>
  confirm?: (tx: ContractTransaction, label: string) => Promise<ContractReceipt>
}

export type PlannedStep = { key: string; label: string }

const ROLE = (name: string) => utils.keccak256(utils.toUtf8Bytes(name))
const MINTER_ROLE = ROLE("MINTER_ROLE")
const BURNER_ROLE = ROLE("BURNER_ROLE")
const FAUCET_DRIP: Record<string, string> = { tUSDT: "1000", tRLUSD: "1000" }
const FAUCET_COOLDOWN = 24 * 60 * 60

const ACCESS_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
]
const FAUCET_ABI = [
  "function assetConfigs(address token) view returns (uint256 dripAmount, uint256 dailyCap, uint256 globalCap, uint256 cooldown, bool enabled)",
  "function configureAsset(address token,uint256 dripAmount,uint256 dailyCap,uint256 globalCap,uint256 cooldown,bool enabled)",
]
const PRODUCT_TOKEN_ABI = [
  "function greenlistEnforced() view returns (bool)",
  "function isGreenlisted(address account) view returns (bool)",
  "function greenlist(address account)",
]

// Reserve limits (ArcoUSDReserve.sol constants), checked before any transaction.
const MAX_ASSETS = 8
const MAX_STRATEGIES = 8
const MAX_INSTANT_FEE_BPS = 100
const BPS = 10_000
const MAX_QUEUE_MIN_DELAY = 7 * 24 * 60 * 60
const UINT = /^\d+$/

// GIWA's RPC can lag on read-after-write right after a confirmed deploy (see deploy-giwa.ts
// readbackWithRetry, which lost a registry record to it once).
const READBACK_ATTEMPTS = 6
const READBACK_BASE_DELAY_MS = 1_000
const READBACK_MAX_DELAY_MS = 15_000
const PENDING_WAIT_MS = 180_000

/**
 * Every input the broadcast will use, validated up front (also by the dry-run), so a bad value
 * fails before the first transaction instead of halfway through.
 */
export function validateArcoUSDInputs(registry: ArcoUSDRegistry, core: CoreRefs): void {
  const errors: string[] = []
  const uint = (value: unknown, label: string) => {
    if (typeof value !== "string" || !UINT.test(value) || BigInt(value) >= 2n ** 256n) {
      errors.push(`${label} must be a base-unit integer string below 2^256`)
    }
  }
  const intIn = (value: unknown, min: number, max: number, label: string) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) errors.push(`${label} must be an integer in ${min}..${max}`)
  }
  const { params } = registry
  uint(params.mintCap, "params.mintCap")
  intIn(params.mmfTargetBps, 0, BPS, "params.mmfTargetBps")
  intIn(params.bufferFloorBps, 0, BPS, "params.bufferFloorBps")
  intIn(params.queueMinDelay, 0, MAX_QUEUE_MIN_DELAY, "params.queueMinDelay")
  for (const asset of registry.testAssets) {
    intIn(asset.decimals, 0, 18, `testAssets.${asset.symbol}.decimals`)
    if (!FAUCET_DRIP[asset.symbol]) errors.push(`testAssets.${asset.symbol} has no faucet drip amount`)
  }
  if (registry.reserveAssets.length > MAX_ASSETS) errors.push(`at most ${MAX_ASSETS} reserve assets`)
  for (const asset of registry.reserveAssets) {
    const test = registry.testAssets.find((item) => item.symbol === asset.symbol)
    const decimals = test ? test.decimals : core.assets[asset.symbol]?.decimals
    if (decimals === undefined) errors.push(`Reserve asset ${asset.symbol} is not in the core registry`)
    else if (decimals !== asset.decimals) errors.push(`${asset.symbol} decimals ${decimals} != registry ${asset.decimals}`)
    intIn(asset.instantFeeBps, 0, MAX_INSTANT_FEE_BPS, `reserveAssets.${asset.symbol}.instantFeeBps`)
    if (asset.depositCap !== "max") uint(asset.depositCap, `reserveAssets.${asset.symbol}.depositCap`)
    uint(asset.minQueued, `reserveAssets.${asset.symbol}.minQueued`)
  }
  if (registry.strategies.length > MAX_STRATEGIES) errors.push(`at most ${MAX_STRATEGIES} strategies`)
  for (const strategy of registry.strategies) {
    if (!core.products[strategy.productId]) errors.push(`Strategy product ${strategy.productId} is not in the core registry`)
    uint(strategy.maxAllocation, `strategies.${strategy.productId}.maxAllocation`)
  }
  if (errors.length) throw new Error(`ArcoUSD deploy inputs invalid: ${errors.join("; ")}`)
}

/** Steps still to do, for the dry-run plan. Pure: reads the registry only (and validates inputs). */
export function planArcoUSDDeployment(registry: ArcoUSDRegistry, core: CoreRefs): PlannedStep[] {
  validateArcoUSDInputs(registry, core)
  const steps: PlannedStep[] = []
  const resume = (pending?: boolean) => (pending ? " (resume pending deploy)" : "")
  for (const asset of registry.testAssets) {
    if (!asset.contract.proxy || asset.contract.pending) {
      steps.push({ key: `deploy:${asset.symbol}`, label: `deploy ${asset.symbol} (TestAssetToken proxy, ${asset.decimals} dec)${resume(asset.contract.pending)}` })
    }
  }
  if (!registry.arcoUSD.proxy || registry.arcoUSD.pending) {
    steps.push({ key: "deploy:ArcoUSD", label: `deploy ArcoUSD proxy${resume(registry.arcoUSD.pending)}` })
  }
  if (!registry.reserve.proxy || registry.reserve.pending) {
    steps.push({ key: "deploy:ArcoUSDReserve", label: `deploy ArcoUSDReserve proxy${resume(registry.reserve.pending)}` })
  }
  if (!registry.lens.address || registry.lens.pending) {
    steps.push({ key: "deploy:ArcoUSDReserveLens", label: `deploy ArcoUSDReserveLens${resume(registry.lens.pending)}` })
  }
  for (const role of ["MINTER_ROLE", "BURNER_ROLE"]) {
    if (!registry.roleGrants.some((grant) => grant.key === `ArcoUSD:${role}:reserve`)) {
      steps.push({ key: `grant:${role}`, label: `ArcoUSD.grantRole(${role}, Reserve)` })
    }
  }
  for (const asset of registry.reserveAssets) {
    if (!asset.configured) steps.push({ key: `asset:${asset.symbol}`, label: `Reserve.setAsset(${asset.symbol}, minQueued ${asset.minQueued})` })
  }
  for (const strategy of registry.strategies) {
    if (strategy.strategyId === null) {
      steps.push({ key: `strategy:${strategy.productId}`, label: `Reserve.addStrategy(${strategy.productId})` })
    }
  }
  for (const asset of registry.testAssets) {
    if (!asset.faucetConfigured) steps.push({ key: `faucet:${asset.symbol}`, label: `faucet: MINTER for faucet + configureAsset(${asset.symbol}, drip ${FAUCET_DRIP[asset.symbol]})` })
  }
  for (const strategy of registry.strategies) {
    if (!registry.greenlisted.includes(strategy.productId)) {
      steps.push({ key: `greenlist:${strategy.productId}`, label: `${strategy.productId} product token: greenlist Reserve if enforced` })
    }
  }
  if (!registry.deployed) steps.push({ key: "finalize", label: "mark registry deployed" })
  return steps
}

export async function runArcoUSDDeployment(ctx: DeployContext): Promise<ArcoUSDRegistry> {
  const { registry, core, signer } = ctx
  const log = ctx.log ?? (() => undefined)
  const overrides = async (kind: "deploy" | "call") => (ctx.txOverrides ? ctx.txOverrides(kind) : {})
  const confirm = ctx.confirm ?? (async (tx: ContractTransaction) => tx.wait(1))
  const save = () => ctx.save(registry)
  // Validate every input before sending anything (throws before the first transaction or save).
  planArcoUSDDeployment(registry, core)
  registry.admin = signer.address as Address
  const tracked = { confirm, log }

  // 1-4. Test assets (tUSDT, tRLUSD), ArcoUSD, Reserve, Lens. Each deploy is recorded as pending
  // (address + tx hash) BEFORE waiting, so a timeout or crash is settled by receipt on re-run.
  const proxyDeploy = (current: ArcoUSDContract, label: string, contractName: string, args: () => unknown[], assign: (next: ArcoUSDContract) => void) =>
    ensureDeployed(
      label,
      { address: current.proxy, deployTxHash: current.deployTxHash, pending: current.pending },
      async () =>
        upgrades.deployProxy(await ethers.getContractFactory(contractName, signer), args(), {
          initializer: "initialize",
          kind: "transparent",
          txOverrides: await overrides("deploy"),
        } as any),
      (address, deployTxHash) => {
        assign({ proxy: address, implementation: null, bytecodeHash: null, deployTxHash, pending: true })
        save()
      },
      async (address, deployTxHash, blockNumber) => {
        const { implementation, bytecodeHash } = await readbackWithRetry(async () => {
          const implementation = (await upgrades.erc1967.getImplementationAddress(address)) as Address
          return { implementation, bytecodeHash: await codeHash(implementation) }
        }, label, log)
        assign({ proxy: address, implementation, bytecodeHash, deployTxHash, blockNumber })
        save()
      },
      // A proxy is ours when its EIP-1967 implementation runs exactly the compiled contract.
      async (address) => matchesArtifact(await upgrades.erc1967.getImplementationAddress(address), contractName),
      tracked,
    )

  for (const asset of registry.testAssets) {
    if (asset.contract.proxy && !asset.contract.pending) continue
    await proxyDeploy(asset.contract, asset.symbol, "TestAssetToken", () => [asset.name, asset.symbol, asset.decimals, signer.address], (next) => (asset.contract = next))
  }
  if (!registry.arcoUSD.proxy || registry.arcoUSD.pending) {
    await proxyDeploy(registry.arcoUSD, "ArcoUSD", "ArcoUSD", () => [signer.address], (next) => (registry.arcoUSD = next))
  }
  if (!registry.reserve.proxy || registry.reserve.pending) {
    const { mintCap, mmfTargetBps, bufferFloorBps, queueMinDelay } = registry.params
    await proxyDeploy(
      registry.reserve,
      "ArcoUSDReserve",
      "ArcoUSDReserve",
      () => [registry.arcoUSD.proxy, signer.address, mintCap, mmfTargetBps, bufferFloorBps, queueMinDelay],
      (next) => (registry.reserve = next),
    )
  }
  if (!registry.lens.address || registry.lens.pending) {
    await ensureDeployed(
      "ArcoUSDReserveLens",
      registry.lens,
      async () => (await ethers.getContractFactory("ArcoUSDReserveLens", signer)).deploy(await overrides("deploy")),
      (address, deployTxHash) => {
        registry.lens = { address, bytecodeHash: null, deployTxHash, pending: true }
        save()
      },
      async (address, deployTxHash, blockNumber) => {
        const bytecodeHash = await readbackWithRetry(() => codeHash(address), "ArcoUSDReserveLens", log)
        registry.lens = { address, bytecodeHash, deployTxHash, blockNumber }
        save()
      },
      (address) => matchesArtifact(address, "ArcoUSDReserveLens"),
      tracked,
    )
  }
  const arcoUSD = new Contract(registry.arcoUSD.proxy!, ACCESS_ABI, signer)
  const reserve = await ethers.getContractAt("ArcoUSDReserve", registry.reserve.proxy!, signer)

  // 5. Mint/burn for the Reserve only.
  for (const [name, role] of [["MINTER_ROLE", MINTER_ROLE], ["BURNER_ROLE", BURNER_ROLE]] as const) {
    const key = `ArcoUSD:${name}:reserve`
    if (registry.roleGrants.some((grant) => grant.key === key)) continue
    if (await arcoUSD.hasRole(role, reserve.address)) {
      registry.roleGrants.push({ key, txHash: null, status: "already-present" })
    } else {
      const tx = (await arcoUSD.grantRole(role, reserve.address, await overrides("call"))) as ContractTransaction
      await confirm(tx, key)
      registry.roleGrants.push({ key, txHash: tx.hash as `0x${string}`, status: "confirmed" })
    }
    save()
  }

  // 6. Reserve assets.
  for (const asset of registry.reserveAssets) {
    asset.address = resolveAssetAddress(asset, registry, core)
    if (asset.configured) continue
    const params = {
      depositEnabled: true,
      redeemEnabled: true,
      instantFeeBps: asset.instantFeeBps,
      depositCap: asset.depositCap === "max" ? constants.MaxUint256 : BigNumber.from(asset.depositCap),
      priceFeed: constants.AddressZero,
      maxDepegBps: 0,
      minQueued: BigNumber.from(asset.minQueued),
    }
    log(`Reserve.setAsset ${asset.symbol}`)
    await confirm(await reserve.setAsset(asset.address, params, await overrides("call")), `setAsset ${asset.symbol}`)
    asset.configured = true
    save()
  }

  // 7. MMF strategies (existing Arco products). Allocation stays a separate, operator-signed step.
  for (const strategy of registry.strategies) {
    if (strategy.strategyId !== null) continue
    const product = core.products[strategy.productId]
    if (!product) throw new Error(`Strategy product ${strategy.productId} is not in the core registry`)
    const existing = await findStrategyId(reserve, product.productToken)
    if (existing !== null) {
      strategy.strategyId = existing
    } else {
      log(`Reserve.addStrategy ${strategy.productId}`)
      const tx = await reserve.addStrategy(product.depositVault, product.redemptionVault, strategy.maxAllocation, await overrides("call"))
      await confirm(tx, `addStrategy ${strategy.productId}`)
      strategy.strategyId = await readbackWithRetry(async () => {
        const id = await findStrategyId(reserve, product.productToken)
        if (id === null) throw new Error(`strategy for ${strategy.productId} not visible yet`)
        return id
      }, `addStrategy ${strategy.productId}`, log)
    }
    save()
  }

  // 8. Faucet: the faucet mints test assets, so it needs MINTER on each, then a drip config.
  const faucet = new Contract(core.faucet, FAUCET_ABI, signer)
  for (const asset of registry.testAssets) {
    if (asset.faucetConfigured) continue
    const token = new Contract(asset.contract.proxy!, ACCESS_ABI, signer)
    if (!(await token.hasRole(MINTER_ROLE, core.faucet))) {
      await confirm(await token.grantRole(MINTER_ROLE, core.faucet, await overrides("call")), `${asset.symbol} MINTER faucet`)
    }
    const drip = utils.parseUnits(FAUCET_DRIP[asset.symbol], asset.decimals)
    const current = await faucet.assetConfigs(asset.contract.proxy)
    if (!current.enabled || !BigNumber.from(current.dripAmount).eq(drip)) {
      const tx = await faucet.configureAsset(asset.contract.proxy, drip, drip.mul(10), drip.mul(1_000_000), FAUCET_COOLDOWN, true, await overrides("call"))
      await confirm(tx, `faucet configureAsset ${asset.symbol}`)
    }
    asset.faucetConfigured = true
    save()
  }

  // 9. A product token with greenlist enforcement must greenlist the Reserve to hold shares.
  for (const strategy of registry.strategies) {
    if (registry.greenlisted.includes(strategy.productId)) continue
    const token = new Contract(core.products[strategy.productId].productToken, PRODUCT_TOKEN_ABI, signer)
    if ((await token.greenlistEnforced()) && !(await token.isGreenlisted(reserve.address))) {
      await confirm(await token.greenlist(reserve.address, await overrides("call")), `${strategy.productId} greenlist Reserve`)
    }
    registry.greenlisted.push(strategy.productId)
    save()
  }

  registry.deploymentBlock = earliestBlock(registry)
  registry.deployed = true
  save()
  return registry
}

function resolveAssetAddress(asset: ArcoUSDReserveAsset, registry: ArcoUSDRegistry, core: CoreRefs): Address {
  const test = registry.testAssets.find((item) => item.symbol === asset.symbol)
  const address = test ? test.contract.proxy : core.assets[asset.symbol]?.address
  if (!address) throw new Error(`No address for reserve asset ${asset.symbol}`)
  const decimals = test ? test.decimals : core.assets[asset.symbol].decimals
  if (decimals !== asset.decimals) throw new Error(`${asset.symbol} decimals ${decimals} != registry ${asset.decimals}`)
  return address as Address
}

async function findStrategyId(reserve: Contract, productToken: string): Promise<number | null> {
  if (!(await reserve.strategyProductToken(productToken))) return null
  const count = Number(await reserve.strategyCount())
  for (let id = 0; id < count; id++) {
    const strategy = await reserve.getStrategy(id)
    if (String(strategy.productToken).toLowerCase() === productToken.toLowerCase()) return id
  }
  throw new Error(`Product token ${productToken} is registered but no strategy matches`)
}

type DeployRecord = { address: Address | null; deployTxHash?: `0x${string}`; pending?: boolean }

/**
 * Deploys (or settles an interrupted deploy of) one contract:
 *   no record → send, record pending (address + hash) at once, confirm, then `finish`;
 *   pending   → mined OK: `finish` without redeploying; reverted, or dropped with no code at the
 *               address: deploy again; still in the mempool: wait (and throw "re-run later" on
 *               timeout); unknown tx but code at the address (replaced at the same nonce, or the
 *               node pruned its tx index): adopt it only if `isOurs` proves it runs the compiled
 *               contract, otherwise stop for a human.
 */
async function ensureDeployed(
  label: string,
  current: DeployRecord,
  send: () => Promise<Contract>,
  markPending: (address: Address, deployTxHash: `0x${string}`) => void,
  finish: (address: Address, deployTxHash: `0x${string}`, blockNumber: number) => Promise<void>,
  isOurs: (address: Address) => Promise<boolean>,
  { confirm, log }: { confirm: (tx: ContractTransaction, label: string) => Promise<ContractReceipt>; log: (message: string) => void },
): Promise<void> {
  if (current.pending && current.address && current.deployTxHash) {
    const settled = await settlePending(label, current.address, current.deployTxHash, isOurs, log)
    if (settled !== null) return finish(current.address, current.deployTxHash, settled.blockNumber)
  }
  log(`deploying ${label}`)
  const contract = await send()
  const address = contract.address as Address
  const deployTxHash = contract.deployTransaction.hash as `0x${string}`
  markPending(address, deployTxHash)
  const receipt = await confirm(contract.deployTransaction, `${label} deploy`)
  await finish(address, deployTxHash, receipt.blockNumber)
}

async function settlePending(
  label: string,
  address: Address,
  hash: `0x${string}`,
  isOurs: (address: Address) => Promise<boolean>,
  log: (message: string) => void,
): Promise<{ blockNumber: number } | null> {
  const provider = ethers.provider
  let receipt = await provider.getTransactionReceipt(hash)
  if (!receipt && (await provider.getTransaction(hash))) {
    log(`${label}: waiting for pending deploy ${hash}`)
    try {
      receipt = await provider.waitForTransaction(hash, 1, PENDING_WAIT_MS)
    } catch {
      throw new Error(`${label}: deploy ${hash} is still pending. Check the explorer and re-run later; nothing was redeployed.`)
    }
  }
  if (receipt?.status === 1) {
    log(`${label}: pending deploy ${hash} confirmed; recording it`)
    return { blockNumber: receipt.blockNumber }
  }
  if (receipt) {
    log(`${label}: pending deploy ${hash} reverted; deploying again`)
    return null
  }
  const code = await provider.getCode(address)
  if (code && code !== "0x") {
    let ours = false
    try {
      ours = await isOurs(address)
    } catch {
      ours = false
    }
    if (!ours) {
      throw new Error(`${label}: deploy tx ${hash} is unknown to the node and ${address} holds code that does not match the compiled contract. Inspect it before re-running.`)
    }
    const blockNumber = await creationBlock(address)
    log(`${label}: deploy tx ${hash} is unknown to the node, but ${address} runs the compiled contract (created in block ${blockNumber}); recording it`)
    return { blockNumber }
  }
  log(`${label}: pending deploy ${hash} was dropped (no receipt, no code); deploying again`)
  return null
}

/** Whether `address` runs exactly the compiled `contractName` (runtime bytecode, metadata included). */
async function matchesArtifact(address: string, contractName: string): Promise<boolean> {
  const [code, artifact] = await Promise.all([ethers.provider.getCode(address), artifacts.readArtifact(contractName)])
  return code.toLowerCase() === artifact.deployedBytecode.toLowerCase()
}

/** First block where `address` has code (binary search on historical getCode). */
async function creationBlock(address: string): Promise<number> {
  let lo = 0
  let hi = await ethers.provider.getBlockNumber()
  try {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const code = await ethers.provider.getCode(address, mid)
      if (code && code !== "0x") hi = mid
      else lo = mid + 1
    }
  } catch (error) {
    throw new Error(`Could not find the creation block of ${address} (the RPC may not serve historical state): ${error instanceof Error ? error.message : String(error)}`)
  }
  return lo
}

/** Retries post-confirmation chain READS (never a transaction) while a lagging RPC catches up. */
async function readbackWithRetry<T>(read: () => Promise<T>, label: string, log: (message: string) => void): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt === READBACK_ATTEMPTS) break
      const delayMs = Math.min(READBACK_BASE_DELAY_MS * 2 ** (attempt - 1), READBACK_MAX_DELAY_MS)
      log(`${label}: readback not ready (attempt ${attempt}/${READBACK_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}; retrying in ${delayMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

async function codeHash(address: string): Promise<`0x${string}`> {
  const code = await ethers.provider.getCode(address)
  if (!code || code === "0x") throw new Error(`No bytecode at ${address}`)
  return utils.keccak256(code) as `0x${string}`
}
