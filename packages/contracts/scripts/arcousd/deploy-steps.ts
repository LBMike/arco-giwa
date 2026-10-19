import { BigNumber, Contract, ContractReceipt, ContractTransaction, Overrides, Signer, constants, utils } from "ethers"
import { artifacts, ethers, upgrades } from "hardhat"
import {
  earliestBlock,
  type Address,
  type ArcoUSDContract,
  type ArcoUSDPlainContract,
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
const SETTLER_ROLE = ROLE("SETTLER_ROLE")
const REWARDER_ROLE = ROLE("REWARDER_ROLE")
const SETTLER_GRANT_KEY = "Reserve:SETTLER_ROLE:router"
// Keyed by the distributor's address: a redeployed distributor gets its own grants (revoking the
// old one's MINTER_ROLE is a manual, reviewed step).
const distributorMinterKey = (address: string | null) => `ArcoUSD:MINTER_ROLE:distributor:${address ?? "new"}`
const distributorRewarderKey = (address: string | null) => `sArcoUSD:REWARDER_ROLE:distributor:${address ?? "new"}`
/** Holder of the sArcoUSD seed shares (nobody can redeem them). */
export const SAVINGS_SEED_HOLDER = "0x000000000000000000000000000000000000dEaD"
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
const DEPOSIT_VAULT_ABI = ["function paymentToken() view returns (address)"]
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
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
// sArcoUSD and ArcoUSDSavingsDistributor limits (contract constants).
const HOUR = 60 * 60
const MAX_SAVINGS_PERIOD = 30 * 24 * HOUR
const MAX_SAVINGS_APR_BPS = 5000
const MAX_SAVINGS_MARGIN_BPS = 1000
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
    intIn(asset.swapFeeBps, 0, MAX_INSTANT_FEE_BPS, `reserveAssets.${asset.symbol}.swapFeeBps`)
    if (asset.depositCap !== "max") uint(asset.depositCap, `reserveAssets.${asset.symbol}.depositCap`)
    uint(asset.minQueued, `reserveAssets.${asset.symbol}.minQueued`)
  }
  if (registry.strategies.length > MAX_STRATEGIES) errors.push(`at most ${MAX_STRATEGIES} strategies`)
  for (const strategy of registry.strategies) {
    if (!core.products[strategy.productId]) errors.push(`Strategy product ${strategy.productId} is not in the core registry`)
    uint(strategy.maxAllocation, `strategies.${strategy.productId}.maxAllocation`)
  }
  const routerProducts = new Set<string>()
  for (const vault of registry.routerVaults) {
    if (!core.products[vault.productId]) errors.push(`Router vault product ${vault.productId} is not in the core registry`)
    if (routerProducts.has(vault.productId)) errors.push(`Router vault product ${vault.productId} is listed twice`)
    routerProducts.add(vault.productId)
  }
  const savings = registry.savings.params
  intIn(savings.vestingPeriod, HOUR, MAX_SAVINGS_PERIOD, "savings.params.vestingPeriod")
  intIn(savings.minInterval, HOUR, MAX_SAVINGS_PERIOD, "savings.params.minInterval")
  intIn(savings.maxAprBps, 0, MAX_SAVINGS_APR_BPS, "savings.params.maxAprBps")
  intIn(savings.reserveMarginBps, 0, MAX_SAVINGS_MARGIN_BPS, "savings.params.reserveMarginBps")
  // The distributor refuses an interval longer than the vesting period (it would cut the APR cap).
  if (Number.isInteger(savings.minInterval) && Number.isInteger(savings.vestingPeriod) && savings.minInterval > savings.vestingPeriod) {
    errors.push("savings.params.minInterval must not exceed savings.params.vestingPeriod")
  }
  if (!seedAsset(registry, core)) errors.push("savings seed needs a fee-free Reserve asset from the core registry (tUSDC)")
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
  if (!registry.router.proxy || registry.router.pending) {
    steps.push({ key: "deploy:ArcoRouter", label: `deploy ArcoRouter proxy${resume(registry.router.pending)}` })
  }
  for (const role of ["MINTER_ROLE", "BURNER_ROLE"]) {
    if (!registry.roleGrants.some((grant) => grant.key === `ArcoUSD:${role}:reserve`)) {
      steps.push({ key: `grant:${role}`, label: `ArcoUSD.grantRole(${role}, Reserve)` })
    }
  }
  if (!registry.roleGrants.some((grant) => grant.key === SETTLER_GRANT_KEY)) {
    steps.push({ key: "grant:SETTLER_ROLE", label: "Reserve.grantRole(SETTLER_ROLE, ArcoRouter)" })
  }
  for (const asset of registry.reserveAssets) {
    if (!asset.configured) {
      steps.push({ key: `asset:${asset.symbol}`, label: `Reserve.setAsset(${asset.symbol}, swapFee ${asset.swapFeeBps} bps, minQueued ${asset.minQueued})` })
    }
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
  for (const vault of registry.routerVaults) {
    if (!vault.configured) steps.push({ key: `router:${vault.productId}`, label: `ArcoRouter.setVault(${vault.productId} deposit vault, true)` })
  }
  const savings = registry.savings
  if (!savings.vault.proxy || savings.vault.pending) {
    steps.push({ key: "deploy:SArcoUSD", label: `deploy sArcoUSD proxy (vesting ${savings.params.vestingPeriod}s)${resume(savings.vault.pending)}` })
  }
  if (!savings.distributor.address || savings.distributor.pending) {
    const { minInterval, maxAprBps, reserveMarginBps } = savings.params
    steps.push({
      key: "deploy:ArcoUSDSavingsDistributor",
      label: `deploy ArcoUSDSavingsDistributor (every ${minInterval}s, APR cap ${maxAprBps} bps, margin ${reserveMarginBps} bps)${resume(savings.distributor.pending)}`,
    })
  }
  if (!savings.zap.address || savings.zap.pending) {
    steps.push({ key: "deploy:ArcoSavingsZap", label: `deploy ArcoSavingsZap${resume(savings.zap.pending)}` })
  }
  if (!registry.roleGrants.some((grant) => grant.key === distributorMinterKey(savings.distributor.address))) {
    steps.push({ key: "grant:distributor:MINTER_ROLE", label: "ArcoUSD.grantRole(MINTER_ROLE, ArcoUSDSavingsDistributor)" })
  }
  if (!registry.roleGrants.some((grant) => grant.key === distributorRewarderKey(savings.distributor.address))) {
    steps.push({ key: "grant:distributor:REWARDER_ROLE", label: "sArcoUSD.grantRole(REWARDER_ROLE, ArcoUSDSavingsDistributor)" })
  }
  if (!savings.seeded) {
    steps.push({ key: "seed:sArcoUSD", label: `sArcoUSD.seed(): 1 sArcoUSD for ${SAVINGS_SEED_HOLDER} and open deposits (1 ArcoUSD from the deployer, made from ${seedAsset(registry, core)?.symbol ?? "tUSDC"} via the Reserve if needed)` })
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

  // 1-4 (and 11). Test assets (tUSDT, tRLUSD), ArcoUSD, Reserve, Lens, Router (and the Savings contracts). Each deploy is recorded as pending
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
  // Plain contracts (no proxy) keep their addresses in storage, not immutables, so the runtime
  // bytecode equals the artifact and an interrupted deploy can be matched against it.
  const plainDeploy = (current: ArcoUSDPlainContract, contractName: string, args: () => unknown[], assign: (next: ArcoUSDPlainContract) => void) =>
    ensureDeployed(
      contractName,
      current,
      async () => (await ethers.getContractFactory(contractName, signer)).deploy(...args(), await overrides("deploy")),
      (address, deployTxHash) => {
        assign({ address, bytecodeHash: null, deployTxHash, pending: true })
        save()
      },
      async (address, deployTxHash, blockNumber) => {
        const bytecodeHash = await readbackWithRetry(() => codeHash(address), contractName, log)
        assign({ address, bytecodeHash, deployTxHash, blockNumber })
        save()
      },
      (address) => matchesArtifact(address, contractName),
      tracked,
    )
  const grantAll = async (grants: { key: string; target: Contract; role: string; account: string }[]) => {
    for (const { key, target, role, account } of grants) {
      if (registry.roleGrants.some((grant) => grant.key === key)) continue
      if (await target.hasRole(role, account)) {
        registry.roleGrants.push({ key, txHash: null, status: "already-present" })
      } else {
        const tx = (await target.grantRole(role, account, await overrides("call"))) as ContractTransaction
        await confirm(tx, key)
        registry.roleGrants.push({ key, txHash: tx.hash as `0x${string}`, status: "confirmed" })
      }
      save()
    }
  }

  if (!registry.lens.address || registry.lens.pending) {
    await plainDeploy(registry.lens, "ArcoUSDReserveLens", () => [], (next) => (registry.lens = next))
  }
  if (!registry.router.proxy || registry.router.pending) {
    await proxyDeploy(registry.router, "ArcoRouter", "ArcoRouter", () => [registry.reserve.proxy, signer.address], (next) => (registry.router = next))
  }
  const arcoUSD = new Contract(registry.arcoUSD.proxy!, ACCESS_ABI, signer)
  const reserve = await ethers.getContractAt("ArcoUSDReserve", registry.reserve.proxy!, signer)
  const router = await ethers.getContractAt("ArcoRouter", registry.router.proxy!, signer)

  // 5. Mint/burn on ArcoUSD for the Reserve only; settleFor on the Reserve for the Router only.
  await grantAll([
    { key: "ArcoUSD:MINTER_ROLE:reserve", target: arcoUSD, role: MINTER_ROLE, account: reserve.address },
    { key: "ArcoUSD:BURNER_ROLE:reserve", target: arcoUSD, role: BURNER_ROLE, account: reserve.address },
    { key: SETTLER_GRANT_KEY, target: reserve as Contract, role: SETTLER_ROLE, account: router.address },
  ])

  // 6. Reserve assets.
  for (const asset of registry.reserveAssets) {
    asset.address = resolveAssetAddress(asset, registry, core)
    if (asset.configured) continue
    const params = {
      depositEnabled: true,
      redeemEnabled: true,
      instantFeeBps: asset.instantFeeBps,
      swapFeeBps: asset.swapFeeBps,
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

  // 10. Product deposit vaults the Router may buy into. setVault reverts unless the vault's payment
  // token is a supported Reserve asset, so that is checked first (a fixed gas limit skips estimation).
  for (const vault of registry.routerVaults) {
    if (vault.configured) continue
    const depositVault = core.products[vault.productId].depositVault
    if (!(await router.allowedVault(depositVault))) {
      const paymentToken = await new Contract(depositVault, DEPOSIT_VAULT_ABI, signer).paymentToken()
      if (!(await reserve.getAssetConfig(paymentToken)).supported) {
        throw new Error(`Router vault ${vault.productId}: payment token ${paymentToken} is not a Reserve asset`)
      }
      log(`ArcoRouter.setVault ${vault.productId}`)
      await confirm(await router.setVault(depositVault, true, await overrides("call")), `router setVault ${vault.productId}`)
    }
    vault.configured = true
    save()
  }

  // 11. Savings: sArcoUSD, the surplus distributor (MINTER on ArcoUSD, REWARDER on sArcoUSD), the Zap.
  const savings = registry.savings
  if (!savings.vault.proxy || savings.vault.pending) {
    await proxyDeploy(savings.vault, "sArcoUSD", "SArcoUSD", () => [registry.arcoUSD.proxy, signer.address, savings.params.vestingPeriod], (next) => (savings.vault = next))
  }
  if (!savings.distributor.address || savings.distributor.pending) {
    const { minInterval, maxAprBps, reserveMarginBps } = savings.params
    await plainDeploy(
      savings.distributor,
      "ArcoUSDSavingsDistributor",
      () => [reserve.address, registry.lens.address, savings.vault.proxy, signer.address, minInterval, maxAprBps, reserveMarginBps],
      (next) => (savings.distributor = next),
    )
  }
  if (!savings.zap.address || savings.zap.pending) {
    await plainDeploy(savings.zap, "ArcoSavingsZap", () => [reserve.address, savings.vault.proxy], (next) => (savings.zap = next))
  }
  const sArcoUSD = await ethers.getContractAt("SArcoUSD", savings.vault.proxy!, signer)
  const distributorAddress = savings.distributor.address!
  await grantAll([
    { key: distributorMinterKey(distributorAddress), target: arcoUSD, role: MINTER_ROLE, account: distributorAddress },
    { key: distributorRewarderKey(distributorAddress), target: sArcoUSD as Contract, role: REWARDER_ROLE, account: distributorAddress },
  ])

  // 12. Seed: sArcoUSD.seed() mints MIN_SHARES (1 sArcoUSD) to 0x…dEaD for exactly 1 ArcoUSD and
  // opens deposits in the same call (deposits stay closed until then, so nothing can front-run it).
  // The floor shares belong to nobody, so small holders can always exit in full. Paid with the
  // deployer's ArcoUSD, made from the base asset (tUSDC, 1:1) through the Reserve when short.
  if (!savings.seeded) {
    const minShares = (await sArcoUSD.MIN_SHARES()) as BigNumber
    if ((await sArcoUSD.balanceOf(SAVINGS_SEED_HOLDER)).lt(minShares)) {
      if (!((await sArcoUSD.totalSupply()) as BigNumber).isZero()) {
        throw new Error(
          `sArcoUSD ${sArcoUSD.address} already has shares but no seed (deposits were opened by hand?). seed() only runs on an empty vault: inspect it before re-running.`,
        )
      }
      const arco = new Contract(registry.arcoUSD.proxy!, ERC20_ABI, signer)
      const held = (await arco.balanceOf(signer.address)) as BigNumber
      if (held.lt(minShares)) {
        const base = seedAsset(registry, core)!
        const scale = BigNumber.from(10).pow(18 - base.decimals)
        const amount = minShares.sub(held).add(scale).sub(1).div(scale) // rounded up to whole base units
        const token = new Contract(base.address, ERC20_ABI, signer)
        if ((await token.balanceOf(signer.address)).lt(amount)) {
          throw new Error(
            `Seeding sArcoUSD needs ${utils.formatUnits(amount, base.decimals)} ${base.symbol} (or ${utils.formatEther(minShares.sub(held))} more ArcoUSD) in the deployer wallet ${signer.address}. Fund it and re-run: everything before this step is recorded.`,
          )
        }
        if ((await token.allowance(signer.address, reserve.address)).lt(amount)) {
          await confirm(await token.approve(reserve.address, amount, await overrides("call")), `${base.symbol} approve Reserve (seed)`)
        }
        log(`Reserve.deposit ${utils.formatUnits(amount, base.decimals)} ${base.symbol} for the sArcoUSD seed`)
        await confirm(await reserve.deposit(base.address, amount, signer.address, await overrides("call")), "Reserve.deposit (seed)")
      }
      if ((await arco.allowance(signer.address, sArcoUSD.address)).lt(minShares)) {
        await confirm(await arco.approve(sArcoUSD.address, minShares, await overrides("call")), "ArcoUSD approve sArcoUSD (seed)")
      }
      log(`sArcoUSD.seed() for ${SAVINGS_SEED_HOLDER}`)
      await confirm(await sArcoUSD.seed(await overrides("call")), "sArcoUSD seed")
    }
    savings.seeded = true
    save()
  }

  registry.deploymentBlock = earliestBlock(registry)
  registry.deployed = true
  save()
  return registry
}

/** The fee-free Reserve asset from the core registry (tUSDC) that pays for the sArcoUSD seed. */
function seedAsset(registry: ArcoUSDRegistry, core: CoreRefs): { symbol: string; address: Address; decimals: number } | null {
  const asset = registry.reserveAssets.find((item) => item.swapFeeBps === 0 && core.assets[item.symbol])
  if (!asset) return null
  const ref = core.assets[asset.symbol]
  return { symbol: asset.symbol, address: ref.address, decimals: ref.decimals }
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
