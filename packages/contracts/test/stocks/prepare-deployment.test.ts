import assert from "assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"
import hre from "hardhat"
import { Contract } from "ethers"
import {
  prepareStocksDeployment,
  verifyPreparedDeployment,
  assertPreparedStep,
  filesystemStocksArtifacts,
  type PublicDeploymentInput,
} from "../../scripts/stocks/prepare-deployment"

describe("GIWA Stocks unsigned deployment preparation", () => {
  let input: PublicDeploymentInput
  beforeEach(async () => {
    await hre.network.provider.send("hardhat_reset")
    const [deployer, operator, faucetOperator] = await hre.ethers.getSigners()
    input = {
      chainId: 91342,
      deployer: deployer.address,
      operator: operator.address,
      faucetOperator: faucetOperator.address,
      startingNonce: "0",
    }
  })

  it("prepares deterministic five-step unsigned requests without changing account nonce", async () => {
    const before = await hre.ethers.provider.getTransactionCount(input.deployer)
    const a = await prepareStocksDeployment(input, hre.artifacts)
    const b = await prepareStocksDeployment(input, hre.artifacts)
    assert.deepEqual(a, b)
    assert.equal(a.status, "UNSIGNED_NOT_BROADCAST")
    assert.equal(a.steps.length, 5)
    assert.equal(await hre.ethers.provider.getTransactionCount(input.deployer), before)
    assert.match(a.planDigest, /^[0-9a-f]{64}$/)
    for (const [index, step] of a.steps.entries()) {
      assert.equal(step.transaction.from, input.deployer.toLowerCase())
      assert.equal(step.transaction.nonce, `0x${index.toString(16)}`)
      assert.equal(step.transaction.to, null)
      assert.equal(step.transaction.value, "0x0")
      assert.equal(step.transaction.chainId, 91342)
      assert.equal(step.initCodeHash, hre.ethers.utils.keccak256(step.transaction.data))
      assert.equal(
        step.predictedAddress,
        hre.ethers.utils.getContractAddress({ from: input.deployer, nonce: index }).toLowerCase(),
      )
      assert.equal(await hre.ethers.provider.getCode(step.predictedAddress), "0x")
    }
    assert.deepEqual(await verifyPreparedDeployment(a, hre.artifacts), a)
  })

  it("executes exact prepared bytecode locally and matches all five runtime hashes and immutable getters", async () => {
    const plan = await prepareStocksDeployment(input, hre.artifacts)
    const [signer] = await hre.ethers.getSigners()
    const completed: { index: number; address: string; runtimeCodeHash: string }[] = []
    for (const [index, step] of plan.steps.entries()) {
      const tx = assertPreparedStep(plan, index, {
        chainId: 91342,
        deployer: signer.address,
        pendingNonce: String(await signer.getTransactionCount("pending")),
        completed,
      })
      // Test signing is only the isolated Hardhat provider's unlocked account.
      const hash = await hre.network.provider.send("eth_sendTransaction", [
        { ...tx, gas: "0x4c4b40" },
      ])
      const receipt = await hre.ethers.provider.getTransactionReceipt(hash)
      assert.equal(receipt.status, 1)
      assert.equal(receipt.contractAddress.toLowerCase(), step.predictedAddress)
      const code = await hre.ethers.provider.getCode(step.predictedAddress)
      const runtimeCodeHash = hre.ethers.utils.keccak256(code)
      assert.equal(runtimeCodeHash, step.expectedRuntimeCodeHash)
      for (const binding of step.expectedBindings) {
        const contract = new Contract(
          step.predictedAddress,
          [`function ${binding.getter}() view returns (address)`],
          hre.ethers.provider,
        )
        assert.equal((await contract[binding.getter]()).toLowerCase(), binding.expected)
      }
      completed.push({ index, address: step.predictedAddress, runtimeCodeHash })
    }
    const decimals = [6, 9]
    for (const [n, index] of [0, 3].entries()) {
      const token = new Contract(
        plan.steps[index].predictedAddress,
        ["function decimals() view returns(uint8)"],
        hre.ethers.provider,
      )
      assert.equal(await token.decimals(), decimals[n])
    }
    assert.equal(await signer.getTransactionCount("pending"), 5)
  })

  it("rejects missing, malformed, zero, overlapping, implicit or unexpected public role input", async () => {
    const invalid: unknown[] = [
      null,
      {},
      { ...input, chainId: 1 },
      { ...input, deployer: "not-address" },
      { ...input, operator: hre.ethers.constants.AddressZero },
      { ...input, operator: input.deployer },
      { ...input, faucetOperator: input.operator },
      { ...input, startingNonce: 0 },
      { ...input, startingNonce: "01" },
      { ...input, startingNonce: "-1" },
      { ...input, startingNonce: "1.0" },
      { ...input, startingNonce: "18446744073709551615" },
      { ...input, extra: "unexpected" },
    ]
    for (const value of invalid)
      await assert.rejects(() => prepareStocksDeployment(value, hre.artifacts))
    const predictedCash = hre.ethers.utils.getContractAddress({ from: input.deployer, nonce: 0 })
    await assert.rejects(
      () => prepareStocksDeployment({ ...input, operator: predictedCash }, hre.artifacts),
      /ROLE_CONTRACT_ADDRESS_OVERLAP/,
    )
  })

  it("preserves high decimal nonces exactly without JavaScript number rounding", async () => {
    const plan = await prepareStocksDeployment(
      { ...input, startingNonce: "9007199254740993" },
      hre.artifacts,
    )
    assert.equal(plan.steps[0].transaction.nonce, "0x20000000000001")
    assert.equal(plan.steps[4].transaction.nonce, "0x20000000000005")
    assert.equal(
      plan.steps[0].predictedAddress,
      hre.ethers.utils
        .getContractAddress({ from: input.deployer, nonce: "9007199254740993" })
        .toLowerCase(),
    )
  })

  it("rejects wrong compiler, EVM target, optimizer, missing build evidence and artifact tampering", async () => {
    for (const corrupt of [
      (build: any) => {
        build.solcVersion = "0.8.29"
      },
      (build: any) => {
        build.input.settings.evmVersion = "prague"
      },
      (build: any) => {
        build.input.settings.optimizer.runs = 100
      },
      (build: any) => {
        build.input.settings.optimizer.enabled = false
      },
    ]) {
      await assert.rejects(
        () =>
          prepareStocksDeployment(input, {
            readArtifact: (name) => hre.artifacts.readArtifact(name),
            getBuildInfo: async (name) => {
              const build = structuredClone(await hre.artifacts.getBuildInfo(name))
              corrupt(build)
              return build
            },
          }),
        /PINNED_COMPILER_SETTINGS_REQUIRED/,
      )
    }
    await assert.rejects(
      () =>
        prepareStocksDeployment(input, {
          readArtifact: (name) => hre.artifacts.readArtifact(name),
          getBuildInfo: async () => undefined,
        }),
      /PINNED_COMPILER_SETTINGS_REQUIRED/,
    )
    await assert.rejects(
      () =>
        prepareStocksDeployment(input, {
          readArtifact: async (name) => ({
            ...(await hre.artifacts.readArtifact(name)),
            bytecode: "0x6000",
          }),
          getBuildInfo: (name) => hre.artifacts.getBuildInfo(name),
        }),
      /ARTIFACT_BUILD_MISMATCH/,
    )
  })

  it("rejects modified calldata, roles, runtime hashes, nonce or reordered steps", async () => {
    const original = await prepareStocksDeployment(input, hre.artifacts)
    for (const corrupt of [
      (plan: any) => {
        plan.steps[0].transaction.data += "00"
      },
      (plan: any) => {
        plan.steps[0].transaction.value = "0x1"
      },
      (plan: any) => {
        plan.steps[0].transaction.nonce = "0x1"
      },
      (plan: any) => {
        plan.steps[0].expectedRuntimeCodeHash = hre.ethers.constants.HashZero
      },
      (plan: any) => {
        plan.steps.reverse()
      },
      (plan: any) => {
        plan.input.operator = input.faucetOperator
      },
      (plan: any) => {
        plan.extra = true
      },
    ]) {
      const changed = structuredClone(original)
      corrupt(changed)
      await assert.rejects(() => verifyPreparedDeployment(changed, hre.artifacts))
    }
  })

  it("fails closed before send when another transaction consumed the starting nonce", async () => {
    const plan = await prepareStocksDeployment(input, hre.artifacts)
    const [deployer, other] = await hre.ethers.getSigners()
    await (await deployer.sendTransaction({ to: other.address, value: 0 })).wait()
    assert.throws(
      () =>
        assertPreparedStep(plan, 0, {
          chainId: 91342,
          deployer: deployer.address,
          pendingNonce: String(1),
          completed: [],
        }),
      /DEPLOYMENT_NONCE_CHANGED/,
    )
    assert.equal(await hre.ethers.provider.getCode(plan.steps[0].predictedAddress), "0x")
  })

  it("rejects sequence/network/prior-code mismatch and EVM refuses out-of-order nonce", async () => {
    const plan = await prepareStocksDeployment(input, hre.artifacts)
    const observed = { chainId: 91342, deployer: input.deployer, pendingNonce: "0", completed: [] }
    assert.throws(
      () => assertPreparedStep(plan, 0, { ...observed, chainId: 1 }),
      /NETWORK_OR_SENDER/,
    )
    assert.throws(
      () => assertPreparedStep(plan, 0, { ...observed, deployer: input.operator }),
      /NETWORK_OR_SENDER/,
    )
    assert.throws(
      () => assertPreparedStep(plan, 1, { ...observed, pendingNonce: "1" }),
      /SEQUENCE_INCOMPLETE/,
    )
    assert.throws(
      () =>
        assertPreparedStep(plan, 1, {
          ...observed,
          pendingNonce: "1",
          completed: [
            {
              index: 0,
              address: plan.steps[0].predictedAddress,
              runtimeCodeHash: hre.ethers.constants.HashZero,
            },
          ],
        }),
      /PRIOR_DEPLOYMENT_EVIDENCE/,
    )
    await assert.rejects(
      () =>
        hre.network.provider.send("eth_sendTransaction", [
          { ...plan.steps[1].transaction, gas: "0x4c4b40" },
        ]),
      /Nonce too high|nonce/i,
    )
    assert.equal(await hre.ethers.provider.getTransactionCount(input.deployer), 0)
  })

  it("offline filesystem CLI creates reviewable unsigned JSON without overwrite or Hardhat provider configuration", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "stocks-unsigned-plan-"))
    try {
      const publicInput = path.join(temp, "public-roles.json")
      const output = path.join(temp, "unsigned-plan.json")
      await writeFile(publicInput, JSON.stringify(input))
      const command = [
        "-r",
        "ts-node/register",
        "scripts/stocks/prepare-deployment.ts",
        "--input",
        publicInput,
        "--output",
        output,
      ]
      const result = spawnSync(process.execPath, command, {
        cwd: path.resolve(__dirname, "../.."),
        encoding: "utf8",
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /No transaction was signed or broadcast/)
      const prepared = JSON.parse(await readFile(output, "utf8"))
      assert.deepEqual(
        prepared,
        await prepareStocksDeployment(
          input,
          filesystemStocksArtifacts(path.resolve(__dirname, "../../artifacts/stocks")),
        ),
      )
      assert.deepEqual(await verifyPreparedDeployment(prepared, hre.artifacts), prepared)
      assert.equal(await hre.ethers.provider.getTransactionCount(input.deployer), 0)
      const duplicate = spawnSync(process.execPath, command, {
        cwd: path.resolve(__dirname, "../.."),
        encoding: "utf8",
      })
      assert.equal(duplicate.status, 1)
      assert.match(duplicate.stderr, /PUBLIC_DEPLOYMENT_JSON_NOT_WRITTEN/)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
