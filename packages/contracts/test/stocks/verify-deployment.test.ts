import assert from "assert/strict"
import hre from "hardhat"
import { prepareStocksDeployment } from "../../scripts/stocks/prepare-deployment"
import {
  deploymentHttpsRpc,
  verifyStocksDeploymentEvidence,
  type DeploymentReadRpc,
} from "../../scripts/stocks/verify-deployment"

describe("GIWA Stocks finalized deployment evidence", () => {
  let prepared: Awaited<ReturnType<typeof prepareStocksDeployment>>
  let hashes: string[]
  const rpc: DeploymentReadRpc = (method, params) => hre.network.provider.send(method, params)
  const hash = (byte: string) => `0x${byte.repeat(64)}`
  const input = () => ({
    plan: prepared,
    expectedPlanDigest: prepared.planDigest,
    transactionHashes: hashes,
    abiDigest: "a".repeat(64),
  })
  beforeEach(async () => {
    await hre.network.provider.send("hardhat_reset")
    const [deployer, operator, faucetOperator] = await hre.ethers.getSigners()
    prepared = await prepareStocksDeployment(
      {
        chainId: 91342,
        deployer: deployer.address,
        operator: operator.address,
        faucetOperator: faucetOperator.address,
        startingNonce: "0",
      },
      hre.artifacts,
    )
    hashes = []
  })
  async function deploy(afterStep?: (index: number) => Promise<void>) {
    for (const [index, step] of prepared.steps.entries()) {
      hashes.push(
        await hre.network.provider.send("eth_sendTransaction", [
          { ...step.transaction, gas: "0x4c4b40" },
        ]),
      )
      if (afterStep) await afterStep(index)
    }
  }
  function changed(
    transform: (method: string, params: unknown[], value: any) => unknown,
  ): DeploymentReadRpc {
    return async (method, params) =>
      transform(method, params, structuredClone(await rpc(method, params)))
  }

  it("verifies all original finalized CREATE transactions, runtime hashes/getters and produces v2 manifest", async () => {
    await deploy()
    const calls: { method: string; params: unknown[] }[] = []
    const result = await verifyStocksDeploymentEvidence(
      input(),
      hre.artifacts,
      async (method, params) => {
        calls.push({ method, params })
        return rpc(method, params)
      },
    )
    const { manifest, evidence } = result
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.chainId, 91342)
    assert.equal(manifest.profile, "DEMO_TESTNET")
    assert.equal(manifest.checkpointNumber, "1")
    assert.equal(evidence.finalizedCutoff.number, "5")
    assert.equal(evidence.checkpointPolicy, "FIRST_CREATION_BLOCK_INCLUSIVE")
    assert.equal(manifest.checkpointHash, (await hre.ethers.provider.getBlock(1)).hash)
    assert.equal(manifest.abiDigest, input().abiDigest)
    assert.equal(manifest.signerAddress, prepared.input.operator)
    assert.equal(manifest.cashToken, prepared.steps[0].predictedAddress)
    assert.equal(manifest.redemptionEscrow, prepared.steps[4].predictedAddress)
    assert.equal(manifest.cashScale, 6)
    assert.equal(manifest.quantityScale, 9)
    assert.equal(manifest.restrictedTransfers, true)
    assert.equal(manifest.nonUpgradeable, true)
    assert.deepEqual(
      evidence.creations.map((row) => row.transactionHash),
      hashes,
    )
    assert.equal(Object.keys(manifest.codeHashes).length, 5)
    for (const step of prepared.steps)
      assert.equal(manifest.codeHashes[step.predictedAddress], step.expectedRuntimeCodeHash)
    for (const call of calls.filter((c) => ["eth_getCode", "eth_call"].includes(c.method)))
      assert.equal(call.params[1], "0x5")
    assert.ok(calls.every((c) => !/send|sign|mine/.test(c.method)))
    assert.match(manifest.deploymentId, /^giwa-stocks-[a-f0-9]{64}$/)
    assert.match(manifest.networkInstance, /^giwa-91342-[a-f0-9]{64}$/)
  })

  it("keeps manifest identity stable when the same completed deployment is verified at a later empty cutoff", async () => {
    await deploy()
    const before = await verifyStocksDeploymentEvidence(input(), hre.artifacts, rpc)
    await hre.network.provider.send("evm_mine")
    const after = await verifyStocksDeploymentEvidence(input(), hre.artifacts, rpc)
    assert.deepEqual(after.manifest, before.manifest)
    assert.notEqual(after.evidence.finalizedCutoff.hash, before.evidence.finalizedCutoff.hash)
  })

  it("rejects changed original approval digest, changed plan, malformed ABI or incomplete/duplicate hash input before RPC", async () => {
    await deploy()
    let calls = 0
    const none: DeploymentReadRpc = async () => {
      calls++
      throw new Error("Unexpected RPC")
    }
    const badPlan = structuredClone(prepared)
    badPlan.steps[0].transaction.value = "0x1" as "0x0"
    for (const bad of [
      { ...input(), expectedPlanDigest: "b".repeat(64) },
      { ...input(), plan: badPlan },
      { ...input(), abiDigest: "not-a-digest" },
      { ...input(), transactionHashes: hashes.slice(0, 4) },
      { ...input(), transactionHashes: [hashes[0], hashes[0], ...hashes.slice(2)] },
      { ...input(), transactionHashes: [...hashes.slice(0, 4), "0x" + "0".repeat(64)] },
      { ...input(), extra: "unexpected" },
    ])
      await assert.rejects(() => verifyStocksDeploymentEvidence(bad, hre.artifacts, none))
    assert.equal(calls, 0)
  })

  it("never treats unsigned or partial deployment as completed evidence", async () => {
    hashes = [hash("1"), hash("2"), hash("3"), hash("4"), hash("5")]
    await assert.rejects(
      () => verifyStocksDeploymentEvidence(input(), hre.artifacts, rpc),
      /PENDING_OR_MISSING/,
    )
    hashes = []
    for (const step of prepared.steps.slice(0, 4))
      hashes.push(
        await hre.network.provider.send("eth_sendTransaction", [
          { ...step.transaction, gas: "0x4c4b40" },
        ]),
      )
    hashes.push(hash("5"))
    await assert.rejects(
      () => verifyStocksDeploymentEvidence(input(), hre.artifacts, rpc),
      /PENDING_OR_MISSING/,
    )
  })

  it("rejects pending receipts and transactions or creations newer than the finalized cutoff", async () => {
    await deploy()
    for (const method of ["eth_getTransactionByHash", "eth_getTransactionReceipt"]) {
      await assert.rejects(
        () =>
          verifyStocksDeploymentEvidence(
            input(),
            hre.artifacts,
            changed((m, p, value) => (m === method && p[0] === hashes[4] ? null : value)),
          ),
        /PENDING_OR_MISSING/,
      )
    }
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_getTransactionByHash" && p[0] === hashes[0]
              ? { ...value, blockNumber: null }
              : value,
          ),
        ),
      /PENDING_OR_MISSING/,
    )
    const notFinal: DeploymentReadRpc = (method, params) =>
      rpc(
        method,
        method === "eth_getBlockByNumber" && params[0] === "finalized" ? ["0x4", false] : params,
      )
    await assert.rejects(
      () => verifyStocksDeploymentEvidence(input(), hre.artifacts, notFinal),
      /NOT_FINALIZED/,
    )
  })

  it("rejects wrong chain, sender, nonce, value, calldata and non-CREATE transactions", async () => {
    await deploy()
    const [, other] = await hre.ethers.getSigners()
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, _p, value) => (m === "eth_chainId" ? "0x1" : value)),
        ),
      /GIWA_TESTNET_ONLY/,
    )
    for (const replacement of [
      { chainId: "0x1" },
      { from: other.address },
      { nonce: "0x1" },
      { value: "0x1" },
      { input: "0x6000" },
      { to: other.address },
      { hash: hash("f") },
    ])
      await assert.rejects(() =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_getTransactionByHash" && p[0] === hashes[0]
              ? { ...value, ...replacement }
              : value,
          ),
        ),
      )
    const wrongOrder = [hashes[1], hashes[0], ...hashes.slice(2)]
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          { ...input(), transactionHashes: wrongOrder },
          hre.artifacts,
          rpc,
        ),
      /NONCE_MISMATCH|CALLDATA/,
    )
  })

  it("rejects reverted creation, incorrect deployed address and inconsistent receipt identity", async () => {
    await deploy()
    const [, other] = await hre.ethers.getSigners()
    for (const replacement of [
      { status: "0x0" },
      { contractAddress: other.address },
      { from: other.address },
      { transactionHash: hash("f") },
      { blockHash: hash("f") },
      { transactionIndex: "0x1" },
    ]) {
      await assert.rejects(() =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_getTransactionReceipt" && p[0] === hashes[0]
              ? { ...value, ...replacement }
              : value,
          ),
        ),
      )
    }
  })

  it("requires transaction inclusion in the exact canonical block", async () => {
    await deploy()
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_getBlockByNumber" && p[0] === "0x1" ? { ...value, hash: hash("f") } : value,
          ),
        ),
      /NOT_CANONICAL/,
    )
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_getBlockByNumber" && p[0] === "0x1"
              ? { ...value, transactions: [hash("f")] }
              : value,
          ),
        ),
      /NOT_IN_CANONICAL_BLOCK/,
    )
  })

  it("rejects missing/changed runtime code, constructor bindings and token scales at the cutoff", async () => {
    await deploy()
    for (const code of ["0x", "0x6000"])
      await assert.rejects(
        () =>
          verifyStocksDeploymentEvidence(
            input(),
            hre.artifacts,
            changed((m, _p, value) => (m === "eth_getCode" ? code : value)),
          ),
        /RUNTIME_CODE_MISMATCH/,
      )
    const zero = "0x" + "0".repeat(64)
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_call" &&
            (p[0] as any).data === hre.ethers.utils.id("faucetOperator()").slice(0, 10)
              ? zero
              : value,
          ),
        ),
      /CONSTRUCTOR_BINDING_MISMATCH/,
    )
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) =>
            m === "eth_call" && (p[0] as any).data === "0x313ce567" ? zero : value,
          ),
        ),
      /TOKEN_SCALE_MISMATCH/,
    )
  })

  it("rechecks deployment history and finalized cutoff after all code/getter reads", async () => {
    await deploy()
    let firstBlockReads = 0
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) => {
            if (m === "eth_getBlockByNumber" && p[0] === "0x1" && ++firstBlockReads > 1)
              return { ...value, hash: hash("f") }
            return value
          }),
        ),
      /CANONICAL_HISTORY_CHANGED/,
    )
    let finalizedReads = 0
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) => {
            if (m === "eth_getBlockByNumber" && p[0] === "finalized") finalizedReads++
            if (finalizedReads === 2 && m === "eth_getBlockByNumber" && p[0] === "0x5")
              return { ...value, hash: hash("f") }
            return value
          }),
        ),
      /FINALIZED_CUTOFF_CHANGED/,
    )
    finalizedReads = 0
    await assert.rejects(
      () =>
        verifyStocksDeploymentEvidence(
          input(),
          hre.artifacts,
          changed((m, p, value) => {
            if (m === "eth_getBlockByNumber" && p[0] === "finalized" && ++finalizedReads === 2)
              return { ...value, number: "0x4" }
            return value
          }),
        ),
      /FINALIZED_HEAD_REGRESSED/,
    )
  })

  it("rejects real early deposits before all five contracts exist instead of skipping their history", async () => {
    const [, , faucetOperator, holder] = await hre.ethers.getSigners()
    await deploy(async (index) => {
      if (index !== 1) return
      const cash = await hre.ethers.getContractAt(
        "StocksTestCash",
        prepared.steps[0].predictedAddress,
        faucetOperator,
      )
      const vault = await hre.ethers.getContractAt(
        "StocksFundingVault",
        prepared.steps[1].predictedAddress,
        holder,
      )
      await (await cash.faucet(holder.address, "120000000")).wait()
      await (await cash.connect(holder).approve(vault.address, "120000000")).wait()
      await (await vault.depositForOrder(hash("7"), "120000000")).wait()
      assert.equal(await hre.ethers.provider.getCode(prepared.steps[4].predictedAddress), "0x")
    })
    await assert.rejects(
      () => verifyStocksDeploymentEvidence(input(), hre.artifacts, rpc),
      /PRE_ACTIVATION_TEST_CASH_ACTIVITY/,
    )
  })

  it("rejects stock minting before activation even with untouched zero-supply test cash", async () => {
    await deploy()
    const [, operator, , holder] = await hre.ethers.getSigners()
    const controller = await hre.ethers.getContractAt(
      "StocksMintController",
      prepared.steps[2].predictedAddress,
      operator,
    )
    await (
      await controller.mintForOperation(
        hash("8"),
        prepared.steps[3].predictedAddress,
        holder.address,
        "1000000000",
      )
    ).wait()
    await assert.rejects(
      () => verifyStocksDeploymentEvidence(input(), hre.artifacts, rpc),
      /PRE_ACTIVATION_STOCK_ACTIVITY/,
    )
  })

  it("HTTPS transport accepts only explicit credential-free endpoints and read methods", async () => {
    for (const endpoint of [
      "http://127.0.0.1:8545",
      "https://user:password@rpc.example",
      "https://rpc.example?apiKey=redacted",
      "https://rpc.example#fragment",
    ]) {
      assert.throws(() => deploymentHttpsRpc(endpoint), /EXPLICIT_HTTPS_READ_RPC_REQUIRED/)
    }
    let requests = 0
    const transport = deploymentHttpsRpc("https://rpc.example.test", (async (_url, init) => {
      requests++
      assert.equal(init?.redirect, "error")
      const body = JSON.parse(String(init?.body))
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x164ce" })
    }) as typeof fetch)
    assert.equal(await transport("eth_chainId", []), "0x164ce")
    for (const method of [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "eth_sign",
      "personal_unlockAccount",
      "evm_mine",
    ]) {
      await assert.rejects(() => transport(method, []), /READ_ONLY_DEPLOYMENT_RPC/)
    }
    assert.equal(requests, 1)
    const wrongEnvelope = deploymentHttpsRpc("https://rpc.example.test", (async () =>
      Response.json({ jsonrpc: "2.0", id: "wrong", result: "0x164ce" })) as typeof fetch)
    await assert.rejects(() => wrongEnvelope("eth_chainId", []), /RPC_RESPONSE_INVALID/)
  })
})
