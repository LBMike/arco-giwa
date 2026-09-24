import assert from "assert/strict"
import hre from "hardhat"
import { Wallet, utils } from "ethers"
import {
  attestSignedStocksCreate,
  type SignedCreateFeeLimits,
} from "../../scripts/stocks/attest-signed-create"
import {
  assertPreparedStep,
  prepareStocksDeployment,
  type UnsignedStocksDeployment,
} from "../../scripts/stocks/prepare-deployment"

describe("GIWA Stocks offline signed CREATE attestation", () => {
  let deployer: Wallet
  let other: Wallet
  let plan: UnsignedStocksDeployment
  const fees: SignedCreateFeeLimits = {
    maxGas: 5_000_000n,
    maxPriorityFeePerGas: 2_000_000_000n,
    maxFeePerGas: 3_000_000_000n,
    maxTotalFeeWei: 15_000_000_000_000_000n,
  }

  beforeEach(async () => {
    deployer = Wallet.createRandom()
    other = Wallet.createRandom()
    plan = await prepareStocksDeployment(
      {
        chainId: 91342,
        deployer: deployer.address,
        operator: Wallet.createRandom().address,
        faucetOperator: Wallet.createRandom().address,
        startingNonce: "7",
      },
      hre.artifacts,
    )
  })

  async function signed(index = 0, overrides: Record<string, unknown> = {}, wallet = deployer) {
    const step = plan.steps[index]
    return wallet.signTransaction({
      type: 2,
      chainId: 91342,
      nonce: step.transaction.nonce,
      to: undefined,
      value: 0,
      data: step.transaction.data,
      gasLimit: "4000000",
      maxPriorityFeePerGas: "1000000000",
      maxFeePerGas: "2000000000",
      accessList: [],
      ...overrides,
    })
  }

  function observed(
    source: UnsignedStocksDeployment,
    requested: number,
  ): Parameters<typeof assertPreparedStep>[2] {
    const index = requested >= 0 && requested < source.steps.length ? requested : 0
    // Pure fixture observations. A production caller must obtain these from
    // trusted chain reads and finalized receipts/code, never from the plan.
    return {
      chainId: 91342,
      deployer: source.input.deployer,
      pendingNonce: BigInt(source.steps[index].transaction.nonce).toString(),
      completed: source.steps.slice(0, index).map((step) => ({
        index: step.index,
        address: step.predictedAddress,
        runtimeCodeHash: step.expectedRuntimeCodeHash,
      })),
    }
  }

  async function attest(
    raw: string,
    options: Partial<Parameters<typeof attestSignedStocksCreate>[0]> = {},
  ) {
    const chosenPlan = options.plan ?? plan
    const chosenIndex = options.stepIndex ?? 0
    return attestSignedStocksCreate(
      {
        plan,
        expectedPlanDigest: plan.planDigest,
        stepIndex: 0,
        observed: observed(chosenPlan, chosenIndex),
        signedTransaction: raw,
        limits: fees,
        ...options,
      },
      hre.artifacts,
    )
  }

  async function refused(
    raw: string,
    options: Partial<Parameters<typeof attestSignedStocksCreate>[0]> = {},
  ) {
    await assert.rejects(
      attest(raw, options),
      (error) =>
        error instanceof Error &&
        error.message === "SIGNED_DEPLOYMENT_ATTESTATION_FAILED" &&
        !error.message.includes(raw) &&
        !error.message.includes(utils.keccak256(raw)),
    )
  }

  it("returns the original signed hash for exact CREATE steps without a provider or broadcast", async () => {
    const first = await signed()
    const fifth = await signed(4)
    assert.equal(await attest(first), utils.keccak256(first))
    assert.equal(await attest(fifth, { stepIndex: 4 }), utils.keccak256(fifth))
  })

  it("preserves a valid nonce above JavaScript's safe-integer range", async () => {
    plan = await prepareStocksDeployment(
      { ...plan.input, startingNonce: "9007199254740993" },
      hre.artifacts,
    )
    const raw = await signed()
    assert.equal(await attest(raw), utils.keccak256(raw))
    await refused(await signed(0, { nonce: "9007199254740992" }))
  })

  it("rejects another signer, chain, nonce, non-CREATE destination, nonzero value, calldata and access list", async () => {
    const variants = [
      await signed(0, {}, other),
      await signed(0, { chainId: 1 }),
      await signed(0, { nonce: "8" }),
      await signed(0, { to: other.address }),
      await signed(0, { value: 1 }),
      await signed(0, { data: `${plan.steps[0].transaction.data}00` }),
      await signed(0, { accessList: [{ address: other.address, storageKeys: [] }] }),
    ]
    for (const raw of variants) await refused(raw)
  })

  it("requires EIP-1559, a canonical signed envelope and an exact step index", async () => {
    const raw = await signed()
    await refused(raw, { stepIndex: -1 })
    await refused(raw, { stepIndex: 1 })
    await refused(raw, { stepIndex: 5 })
    await refused(
      await deployer.signTransaction({
        type: 0,
        chainId: 91342,
        nonce: 7,
        data: plan.steps[0].transaction.data,
        value: 0,
        gasLimit: 4_000_000,
        gasPrice: 2_000_000_000,
      }),
    )
    await refused("0x02ffff")
    await refused(`0x02${"00".repeat(64 * 1024 + 1)}`)
  })

  it("enforces gas, priority, per-gas and total fee ceilings", async () => {
    const initCode = utils.arrayify(plan.steps[0].transaction.data)
    const zeroBytes = initCode.filter((byte) => byte === 0).length
    const nonzeroBytes = initCode.length - zeroBytes
    const intrinsic =
      53_000n +
      4n * BigInt(zeroBytes) +
      16n * BigInt(nonzeroBytes) +
      2n * BigInt(Math.ceil(initCode.length / 32))
    await refused(await signed(0, { gasLimit: "1" }))
    await refused(await signed(0, { gasLimit: (intrinsic - 1n).toString() }))
    const exactIntrinsic = await signed(0, { gasLimit: intrinsic.toString() })
    assert.equal(await attest(exactIntrinsic), utils.keccak256(exactIntrinsic))
    await refused(await signed(0, { gasLimit: "5000001" }))
    await refused(await signed(0, { maxPriorityFeePerGas: "2000000001" }))
    await refused(await signed(0, { maxFeePerGas: "3000000001" }))
    await refused(await signed(), { limits: { ...fees, maxTotalFeeWei: 7_999_999_999_999_999n } })
    await refused(await signed(), { limits: { ...fees, maxGas: 0n } })
  })

  it("requires the fresh pending nonce and the exact completed deployment prefix", async () => {
    const first = await signed()
    await refused(first, { observed: { ...observed(plan, 0), pendingNonce: "8" } })
    await refused(first, { observed: { ...observed(plan, 0), chainId: 1 } })
    await refused(first, { observed: { ...observed(plan, 0), deployer: other.address } })

    const second = await signed(1)
    await refused(second, { stepIndex: 1, observed: { ...observed(plan, 1), completed: [] } })
    const prior = observed(plan, 1).completed
    await refused(second, {
      stepIndex: 1,
      observed: {
        ...observed(plan, 1),
        completed: [{ ...prior[0], runtimeCodeHash: `0x${"00".repeat(32)}` }],
      },
    })
    assert.equal(await attest(second, { stepIndex: 1 }), utils.keccak256(second))
  })

  it("rebuilds the plan from artifacts and separately checks the retained approval digest", async () => {
    const raw = await signed()
    await refused(raw, { expectedPlanDigest: "b".repeat(64) })
    const altered = structuredClone(plan)
    altered.steps[0].transaction.data += "00"
    await refused(raw, { plan: altered })
    const coherentButUnapproved = await prepareStocksDeployment(
      { ...plan.input, startingNonce: "8" },
      hre.artifacts,
    )
    await refused(raw, { plan: coherentButUnapproved })
    await assert.rejects(
      attestSignedStocksCreate(
        {
          plan,
          expectedPlanDigest: plan.planDigest,
          stepIndex: 0,
          observed: observed(plan, 0),
          signedTransaction: raw,
          limits: fees,
        },
        {
          readArtifact: hre.artifacts.readArtifact.bind(hre.artifacts),
          getBuildInfo: async (name) => {
            const build = structuredClone(await hre.artifacts.getBuildInfo(name))
            if (build) build.input.settings.evmVersion = "prague"
            return build
          },
        },
      ),
      /^Error: SIGNED_DEPLOYMENT_ATTESTATION_FAILED$/,
    )
  })
})
