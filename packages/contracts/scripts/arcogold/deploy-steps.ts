import {
  BigNumber,
  Contract,
  ContractReceipt,
  ContractTransaction,
  Overrides,
  Signer,
  constants,
  utils,
} from "ethers"
import { artifacts, ethers, upgrades } from "hardhat"
import type { Address, ArcoUSDContract, ArcoUSDPlainContract } from "../arcousd/arcousd-registry"
import {
  codeHash,
  ensureDeployed,
  matchesArtifact,
  readbackWithRetry,
} from "../arcousd/deploy-steps"
import { earliestGoldBlock, type ArcoGoldRegistry } from "./arcogold-registry"

// Idempotent, resumable ArcoGOLD deployment — the ArcoUSD executor's pattern (registry AND chain
// checked before every step; deploys recorded as pending before waiting). The same executor runs
// in the hardhat test (test/arcogold-deploy.test.ts) and on GIWA via scripts/deploy-arcogold-giwa.ts.
// It never touches the ArcoUSD stack and touches the core only through the faucet (MINTER on the
// two new test assets is granted ON THOSE ASSETS; the faucet gets configureAsset for them).

export type GoldCoreRefs = { admin: Address; faucet: Address }

export type GoldDeployContext = {
  signer: Signer & { address: string }
  registry: ArcoGoldRegistry
  core: GoldCoreRefs
  save: (registry: ArcoGoldRegistry) => void
  log?: (message: string) => void
  txOverrides?: (kind: "deploy" | "call") => Promise<Overrides>
  confirm?: (tx: ContractTransaction, label: string) => Promise<ContractReceipt>
}

export type PlannedStep = { key: string; label: string }

const ROLE = (name: string) => utils.keccak256(utils.toUtf8Bytes(name))
const MINTER_ROLE = ROLE("MINTER_ROLE")
const BURNER_ROLE = ROLE("BURNER_ROLE")
export const GOLD_SEED_HOLDER = "0x000000000000000000000000000000000000dEaD"
const unitGrantKey = (role: string) => `unit:${role}:reserve`

const ACCESS_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
]
const FAUCET_ABI = [
  "function assetConfigs(address token) view returns (uint256 dripAmount, uint256 dailyCap, uint256 globalCap, uint256 cooldown, bool enabled)",
  "function configureAsset(address token,uint256 dripAmount,uint256 dailyCap,uint256 globalCap,uint256 cooldown,bool enabled)",
]
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]

// Contract limits (ArcoUSDReserve / SArcoUSD constants), checked before any transaction.
const MAX_ASSETS = 8
const MAX_FEE_BPS = 100
const BPS = 10_000
const MAX_QUEUE_MIN_DELAY = 7 * 24 * 60 * 60
const HOUR = 60 * 60
const MAX_VESTING = 30 * 24 * HOUR
const UINT = /^\d+$/
const DECIMAL = /^\d+(\.\d+)?$/

export function validateArcoGoldInputs(registry: ArcoGoldRegistry): void {
  const errors: string[] = []
  const uint = (value: unknown, label: string, positive = false) => {
    if (
      typeof value !== "string" ||
      !UINT.test(value) ||
      BigInt(value) >= 2n ** 256n ||
      (positive && BigInt(value) === 0n)
    ) {
      errors.push(
        `${label} must be a ${positive ? "positive " : ""}base-unit integer string below 2^256`,
      )
    }
  }
  const intIn = (value: unknown, min: number, max: number, label: string) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
      errors.push(`${label} must be an integer in ${min}..${max}`)
  }
  const name = (value: unknown, label: string) => {
    if (typeof value !== "string" || !value.trim() || value.length > 32)
      errors.push(`${label} must be a 1-32 character string`)
  }
  name(registry.unit.name, "unit.name")
  name(registry.unit.symbol, "unit.symbol")
  name(registry.savings.name, "savings.name")
  name(registry.savings.symbol, "savings.symbol")
  if (registry.unit.symbol === "ArcoUSD" || registry.savings.symbol === "sArcoUSD")
    errors.push("the gold stack must not reuse the ArcoUSD names")
  const { params } = registry
  uint(params.mintCap, "params.mintCap", true)
  intIn(params.mmfTargetBps, 0, BPS, "params.mmfTargetBps")
  intIn(params.bufferFloorBps, 0, BPS, "params.bufferFloorBps")
  intIn(params.queueMinDelay, 0, MAX_QUEUE_MIN_DELAY, "params.queueMinDelay")
  uint(registry.pegFeed.answerBase18, "pegFeed.answerBase18", true)
  intIn(registry.pegFeed.maxDepegBps, 0, BPS, "pegFeed.maxDepegBps")
  intIn(registry.savings.params.vestingPeriod, HOUR, MAX_VESTING, "savings.params.vestingPeriod")
  const symbols = new Set<string>()
  for (const asset of registry.testAssets) {
    if (symbols.has(asset.symbol)) errors.push(`test asset ${asset.symbol} listed twice`)
    symbols.add(asset.symbol)
    intIn(asset.decimals, 0, 18, `testAssets.${asset.symbol}.decimals`)
    if (
      typeof asset.faucet?.drip !== "string" ||
      !DECIMAL.test(asset.faucet.drip) ||
      Number(asset.faucet.drip) <= 0
    ) {
      errors.push(`testAssets.${asset.symbol}.faucet.drip must be a positive decimal string`)
    }
    intIn(
      asset.faucet?.dailyCapDrips,
      1,
      1_000_000,
      `testAssets.${asset.symbol}.faucet.dailyCapDrips`,
    )
    intIn(
      asset.faucet?.globalCapDrips,
      1,
      1_000_000_000,
      `testAssets.${asset.symbol}.faucet.globalCapDrips`,
    )
    intIn(asset.faucet?.cooldown, 0, 30 * 24 * HOUR, `testAssets.${asset.symbol}.faucet.cooldown`)
  }
  if (registry.reserveAssets.length === 0 || registry.reserveAssets.length > MAX_ASSETS)
    errors.push(`1..${MAX_ASSETS} reserve assets`)
  for (const asset of registry.reserveAssets) {
    const test = registry.testAssets.find((item) => item.symbol === asset.symbol)
    if (!test) errors.push(`Reserve asset ${asset.symbol} is not one of the gold test assets`)
    else if (test.decimals !== asset.decimals)
      errors.push(`${asset.symbol} decimals ${test.decimals} != reserve asset ${asset.decimals}`)
    intIn(asset.instantFeeBps, 0, MAX_FEE_BPS, `reserveAssets.${asset.symbol}.instantFeeBps`)
    intIn(asset.swapFeeBps, 0, MAX_FEE_BPS, `reserveAssets.${asset.symbol}.swapFeeBps`)
    if (asset.depositCap !== "max")
      uint(asset.depositCap, `reserveAssets.${asset.symbol}.depositCap`)
    uint(asset.minQueued, `reserveAssets.${asset.symbol}.minQueued`)
  }
  const seed = registry.reserveAssets.find((asset) => asset.symbol === registry.savings.seedAsset)
  if (!seed) errors.push(`savings.seedAsset ${registry.savings.seedAsset} must be a Reserve asset`)
  else if (seed.swapFeeBps !== 0)
    errors.push("savings.seedAsset must have no swap fee (the seed is exactly 1 unit)")
  if (registry.savings.distributor !== null)
    errors.push("savings.distributor must stay null (no distributor in ArcoGOLD v1)")
  if (errors.length) throw new Error(`ArcoGOLD deploy inputs invalid: ${errors.join("; ")}`)
}

/** Steps still to do, for the dry-run plan. Pure: reads the registry only (and validates inputs). */
export function planArcoGoldDeployment(registry: ArcoGoldRegistry): PlannedStep[] {
  validateArcoGoldInputs(registry)
  const steps: PlannedStep[] = []
  const resume = (pending?: boolean) => (pending ? " (resume pending deploy)" : "")
  const todo = (contract: ArcoUSDContract) => !contract.proxy || contract.pending
  const todoPlain = (contract: ArcoUSDPlainContract) => !contract.address || contract.pending
  for (const asset of registry.testAssets) {
    if (todo(asset.contract))
      steps.push({
        key: `deploy:${asset.symbol}`,
        label: `deploy ${asset.symbol} (TestAssetToken proxy, ${asset.decimals} dec)${resume(asset.contract.pending)}`,
      })
  }
  const { unit, savings } = registry
  if (todo(unit.contract))
    steps.push({
      key: "deploy:unit",
      label: `deploy ${unit.symbol} "${unit.name}" (ArcoUSDNamed proxy)${resume(unit.contract.pending)}`,
    })
  if (todo(registry.reserve))
    steps.push({
      key: "deploy:reserve",
      label: `deploy gold ArcoUSDReserve proxy (mintCap ${registry.params.mintCap})${resume(registry.reserve.pending)}`,
    })
  if (todoPlain(registry.lens))
    steps.push({
      key: "deploy:lens",
      label: `deploy ArcoUSDReserveLens${resume(registry.lens.pending)}`,
    })
  if (todoPlain(registry.pegFeed))
    steps.push({
      key: "deploy:pegFeed",
      label: `deploy ConstantPriceFeed(${registry.pegFeed.answerBase18})${resume(registry.pegFeed.pending)}`,
    })
  for (const role of ["MINTER_ROLE", "BURNER_ROLE"]) {
    if (!registry.roleGrants.some((grant) => grant.key === unitGrantKey(role)))
      steps.push({ key: `grant:${role}`, label: `${unit.symbol}.grantRole(${role}, gold Reserve)` })
  }
  for (const asset of registry.reserveAssets) {
    if (!asset.configured)
      steps.push({
        key: `asset:${asset.symbol}`,
        label: `Reserve.setAsset(${asset.symbol}, fees ${asset.instantFeeBps}/${asset.swapFeeBps} bps, peg feed ±${registry.pegFeed.maxDepegBps} bps, minQueued ${asset.minQueued})`,
      })
  }
  for (const asset of registry.testAssets) {
    if (!asset.faucetConfigured)
      steps.push({
        key: `faucet:${asset.symbol}`,
        label: `faucet: MINTER for faucet on ${asset.symbol} + configureAsset(drip ${asset.faucet.drip})`,
      })
  }
  if (todo(savings.vault))
    steps.push({
      key: "deploy:vault",
      label: `deploy ${savings.symbol} "${savings.name}" (SArcoUSDNamed proxy, vesting ${savings.params.vestingPeriod}s)${resume(savings.vault.pending)}`,
    })
  if (todoPlain(savings.zap))
    steps.push({
      key: "deploy:zap",
      label: `deploy ArcoSavingsZap (gold Reserve, ${savings.symbol})${resume(savings.zap.pending)}`,
    })
  if (!savings.seeded)
    steps.push({
      key: "seed:vault",
      label: `${savings.symbol}.seed(): 1 share for ${GOLD_SEED_HOLDER} from 1 ${unit.symbol} (made from ${savings.seedAsset} via the Reserve; ${savings.seedAsset} minted to the deployer if short) and open deposits`,
    })
  if (!registry.deployed) steps.push({ key: "finalize", label: "mark registry deployed" })
  return steps
}

export async function runArcoGoldDeployment(ctx: GoldDeployContext): Promise<ArcoGoldRegistry> {
  const { registry, core, signer } = ctx
  const log = ctx.log ?? (() => undefined)
  const overrides = async (kind: "deploy" | "call") =>
    ctx.txOverrides ? ctx.txOverrides(kind) : {}
  const confirm = ctx.confirm ?? (async (tx: ContractTransaction) => tx.wait(1))
  const save = () => ctx.save(registry)
  planArcoGoldDeployment(registry) // validates before the first transaction
  registry.admin = signer.address as Address
  registry.faucet = core.faucet
  const tracked = { confirm, log }

  const proxyDeploy = (
    current: ArcoUSDContract,
    label: string,
    contractName: string,
    initializer: string,
    args: () => unknown[],
    assign: (next: ArcoUSDContract) => void,
  ) =>
    ensureDeployed(
      label,
      { address: current.proxy, deployTxHash: current.deployTxHash, pending: current.pending },
      async () =>
        upgrades.deployProxy(await ethers.getContractFactory(contractName, signer), args(), {
          initializer,
          kind: "transparent",
          txOverrides: await overrides("deploy"),
        } as any),
      (address, deployTxHash) => {
        assign({
          proxy: address,
          implementation: null,
          bytecodeHash: null,
          deployTxHash,
          pending: true,
        })
        save()
      },
      async (address, deployTxHash, blockNumber) => {
        const { implementation, bytecodeHash } = await readbackWithRetry(
          async () => {
            const implementation = (await upgrades.erc1967.getImplementationAddress(
              address,
            )) as Address
            return { implementation, bytecodeHash: await codeHash(implementation) }
          },
          label,
          log,
        )
        assign({ proxy: address, implementation, bytecodeHash, deployTxHash, blockNumber })
        save()
      },
      async (address) =>
        matchesArtifact(await upgrades.erc1967.getImplementationAddress(address), contractName),
      tracked,
    )
  const plainDeploy = (
    current: ArcoUSDPlainContract,
    contractName: string,
    args: () => unknown[],
    assign: (next: ArcoUSDPlainContract) => void,
    isOurs: (address: Address) => Promise<boolean> = (address) =>
      matchesArtifact(address, contractName),
  ) =>
    ensureDeployed(
      contractName,
      current,
      async () =>
        (await ethers.getContractFactory(contractName, signer)).deploy(
          ...args(),
          await overrides("deploy"),
        ),
      (address, deployTxHash) => {
        assign({ address, bytecodeHash: null, deployTxHash, pending: true })
        save()
      },
      async (address, deployTxHash, blockNumber) => {
        const bytecodeHash = await readbackWithRetry(() => codeHash(address), contractName, log)
        assign({ address, bytecodeHash, deployTxHash, blockNumber })
        save()
      },
      isOurs,
      tracked,
    )
  /** Named tokens must carry the names the registry asks for (initializeNamed, never the inherited initialize). */
  const expectNames = async (address: string, name: string, symbol: string, label: string) => {
    const token = new Contract(address, ERC20_ABI, signer)
    const [actualName, actualSymbol] = await readbackWithRetry(
      async () => Promise.all([token.name(), token.symbol()]),
      label,
      log,
    )
    if (actualName !== name || actualSymbol !== symbol) {
      throw new Error(
        `${label} at ${address} is "${actualName}"/"${actualSymbol}", expected "${name}"/"${symbol}". Stop and inspect.`,
      )
    }
  }

  // 1. Test assets, the unit, the Reserve, the Lens, the peg feed.
  for (const asset of registry.testAssets) {
    if (asset.contract.proxy && !asset.contract.pending) continue
    await proxyDeploy(
      asset.contract,
      asset.symbol,
      "TestAssetToken",
      "initialize",
      () => [asset.name, asset.symbol, asset.decimals, signer.address],
      (next) => (asset.contract = next),
    )
  }
  const { unit, savings } = registry
  if (!unit.contract.proxy || unit.contract.pending) {
    await proxyDeploy(
      unit.contract,
      unit.symbol,
      "ArcoUSDNamed",
      "initializeNamed",
      () => [unit.name, unit.symbol, signer.address],
      (next) => (unit.contract = next),
    )
  }
  await expectNames(unit.contract.proxy!, unit.name, unit.symbol, unit.symbol)
  if (!registry.reserve.proxy || registry.reserve.pending) {
    const { mintCap, mmfTargetBps, bufferFloorBps, queueMinDelay } = registry.params
    await proxyDeploy(
      registry.reserve,
      "gold ArcoUSDReserve",
      "ArcoUSDReserve",
      "initialize",
      () => [
        unit.contract.proxy,
        signer.address,
        mintCap,
        mmfTargetBps,
        bufferFloorBps,
        queueMinDelay,
      ],
      (next) => (registry.reserve = next),
    )
  }
  if (!registry.lens.address || registry.lens.pending) {
    await plainDeploy(
      registry.lens,
      "ArcoUSDReserveLens",
      () => [],
      (next) => (registry.lens = next),
    )
  }
  if (!registry.pegFeed.address || registry.pegFeed.pending) {
    const answer = BigNumber.from(registry.pegFeed.answerBase18)
    await plainDeploy(
      registry.pegFeed,
      "ConstantPriceFeed",
      () => [answer],
      // Replace the deploy record wholesale (a confirmed record has no `pending`); keep the feed params.
      (next) =>
        (registry.pegFeed = {
          ...next,
          answerBase18: registry.pegFeed.answerBase18,
          maxDepegBps: registry.pegFeed.maxDepegBps,
        }),
      // The answer is an immutable (patched into the code), so the artifact bytes cannot match: a
      // recovered feed is ours when it has the artifact's code size and reports the same answer.
      async (address) => {
        const [code, artifact] = await Promise.all([
          ethers.provider.getCode(address),
          artifacts.readArtifact("ConstantPriceFeed"),
        ])
        if (code.length !== artifact.deployedBytecode.length) return false
        const feed = await ethers.getContractAt("ConstantPriceFeed", address, signer)
        return BigNumber.from(await feed.answerBase18()).eq(answer)
      },
    )
  }
  const unitToken = new Contract(unit.contract.proxy!, ACCESS_ABI, signer)
  const reserve = await ethers.getContractAt("ArcoUSDReserve", registry.reserve.proxy!, signer)
  if (String(await reserve.arcoUSD()).toLowerCase() !== unit.contract.proxy!.toLowerCase()) {
    throw new Error(
      `gold Reserve ${reserve.address} issues ${await reserve.arcoUSD()}, not ${unit.symbol} ${unit.contract.proxy}. Stop and inspect.`,
    )
  }

  // 2. Mint/burn on the unit for the gold Reserve only.
  for (const [role, hash] of [
    ["MINTER_ROLE", MINTER_ROLE],
    ["BURNER_ROLE", BURNER_ROLE],
  ] as const) {
    const key = unitGrantKey(role)
    if (registry.roleGrants.some((grant) => grant.key === key)) continue
    if (await unitToken.hasRole(hash, reserve.address)) {
      registry.roleGrants.push({ key, txHash: null, status: "already-present" })
    } else {
      const tx = (await unitToken.grantRole(
        hash,
        reserve.address,
        await overrides("call"),
      )) as ContractTransaction
      await confirm(tx, key)
      registry.roleGrants.push({ key, txHash: tx.hash as `0x${string}`, status: "confirmed" })
    }
    save()
  }

  // 3. Reserve assets: 1 token = 1 ounce, checked against the constant peg feed.
  for (const asset of registry.reserveAssets) {
    const test = registry.testAssets.find((item) => item.symbol === asset.symbol)!
    asset.address = test.contract.proxy
    if (asset.configured) continue
    const params = {
      depositEnabled: true,
      redeemEnabled: true,
      instantFeeBps: asset.instantFeeBps,
      swapFeeBps: asset.swapFeeBps,
      depositCap:
        asset.depositCap === "max" ? constants.MaxUint256 : BigNumber.from(asset.depositCap),
      priceFeed: registry.pegFeed.address,
      maxDepegBps: registry.pegFeed.maxDepegBps,
      minQueued: BigNumber.from(asset.minQueued),
    }
    log(`Reserve.setAsset ${asset.symbol}`)
    await confirm(
      await reserve.setAsset(asset.address, params, await overrides("call")),
      `setAsset ${asset.symbol}`,
    )
    asset.configured = true
    save()
  }

  // 4. Faucet: MINTER on each gold test asset for the faucet, then its drip config.
  const faucet = new Contract(core.faucet, FAUCET_ABI, signer)
  for (const asset of registry.testAssets) {
    if (asset.faucetConfigured) continue
    const token = new Contract(asset.contract.proxy!, ACCESS_ABI, signer)
    if (!(await token.hasRole(MINTER_ROLE, core.faucet))) {
      await confirm(
        await token.grantRole(MINTER_ROLE, core.faucet, await overrides("call")),
        `${asset.symbol} MINTER faucet`,
      )
    }
    const drip = utils.parseUnits(asset.faucet.drip, asset.decimals)
    const want = {
      dailyCap: drip.mul(asset.faucet.dailyCapDrips),
      globalCap: drip.mul(asset.faucet.globalCapDrips),
      cooldown: asset.faucet.cooldown,
    }
    const current = await faucet.assetConfigs(asset.contract.proxy)
    const same =
      current.enabled &&
      BigNumber.from(current.dripAmount).eq(drip) &&
      BigNumber.from(current.dailyCap).eq(want.dailyCap) &&
      BigNumber.from(current.globalCap).eq(want.globalCap) &&
      BigNumber.from(current.cooldown).eq(want.cooldown)
    if (!same) {
      const tx = await faucet.configureAsset(
        asset.contract.proxy,
        drip,
        want.dailyCap,
        want.globalCap,
        want.cooldown,
        true,
        await overrides("call"),
      )
      await confirm(tx, `faucet configureAsset ${asset.symbol}`)
    }
    asset.faucetConfigured = true
    save()
  }

  // 5. ArcoGOLD (ERC-4626 over the unit) and the Zap. No distributor in v1.
  if (!savings.vault.proxy || savings.vault.pending) {
    await proxyDeploy(
      savings.vault,
      savings.symbol,
      "SArcoUSDNamed",
      "initializeNamed",
      () => [
        savings.name,
        savings.symbol,
        unit.contract.proxy,
        signer.address,
        savings.params.vestingPeriod,
      ],
      (next) => (savings.vault = next),
    )
  }
  await expectNames(savings.vault.proxy!, savings.name, savings.symbol, savings.symbol)
  if (!savings.zap.address || savings.zap.pending) {
    await plainDeploy(
      savings.zap,
      "ArcoSavingsZap",
      () => [reserve.address, savings.vault.proxy],
      (next) => (savings.zap = next),
    )
  }
  const vault = await ethers.getContractAt("SArcoUSDNamed", savings.vault.proxy!, signer)

  // 6. Seed: MIN_SHARES (1 share) for 0x…dEaD for exactly 1 unit, opening deposits in the same call.
  // The unit comes from the deployer's balance, else from the fee-free seed asset through the
  // Reserve; the deployer is the seed asset's admin (it deployed it) and mints what it lacks.
  if (!savings.seeded) {
    const minShares = (await vault.MIN_SHARES()) as BigNumber
    if ((await vault.balanceOf(GOLD_SEED_HOLDER)).lt(minShares)) {
      if (!((await vault.totalSupply()) as BigNumber).isZero()) {
        throw new Error(
          `${savings.symbol} ${vault.address} already has shares but no seed (deposits opened by hand?). seed() only runs on an empty vault: inspect it before re-running.`,
        )
      }
      const unitErc20 = new Contract(unit.contract.proxy!, ERC20_ABI, signer)
      const held = (await unitErc20.balanceOf(signer.address)) as BigNumber
      if (held.lt(minShares)) {
        const seed = registry.reserveAssets.find((asset) => asset.symbol === savings.seedAsset)!
        const scale = BigNumber.from(10).pow(18 - seed.decimals)
        const amount = minShares.sub(held).add(scale).sub(1).div(scale) // whole base units, rounded up
        const token = new Contract(seed.address!, ERC20_ABI, signer)
        const balance = (await token.balanceOf(signer.address)) as BigNumber
        if (balance.lt(amount)) {
          log(
            `mint ${utils.formatUnits(amount.sub(balance), seed.decimals)} ${seed.symbol} to the deployer for the seed`,
          )
          await confirm(
            await token.mint(signer.address, amount.sub(balance), await overrides("call")),
            `${seed.symbol} mint (seed)`,
          )
        }
        if ((await token.allowance(signer.address, reserve.address)).lt(amount)) {
          await confirm(
            await token.approve(reserve.address, amount, await overrides("call")),
            `${seed.symbol} approve Reserve (seed)`,
          )
        }
        log(
          `Reserve.deposit ${utils.formatUnits(amount, seed.decimals)} ${seed.symbol} for the ${savings.symbol} seed`,
        )
        await confirm(
          await reserve.deposit(seed.address, amount, signer.address, await overrides("call")),
          "Reserve.deposit (seed)",
        )
      }
      if ((await unitErc20.allowance(signer.address, vault.address)).lt(minShares)) {
        await confirm(
          await unitErc20.approve(vault.address, minShares, await overrides("call")),
          `${unit.symbol} approve ${savings.symbol} (seed)`,
        )
      }
      log(`${savings.symbol}.seed() for ${GOLD_SEED_HOLDER}`)
      await confirm(await vault.seed(await overrides("call")), `${savings.symbol} seed`)
    }
    savings.seeded = true
    save()
  }

  registry.deploymentBlock = earliestGoldBlock(registry)
  registry.deployed = true
  save()
  return registry
}
