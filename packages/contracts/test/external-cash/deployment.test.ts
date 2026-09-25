import assert from "assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { spawnSync } from "child_process"
import hre from "hardhat"
import { Contract, ContractFactory, Wallet, utils } from "ethers"
import proxyArtifact from "@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json"
import adminArtifact from "@openzeppelin/contracts/build/contracts/ProxyAdmin.json"
import { EXPECTED_GIWA_DEPLOYER } from "../../scripts/keystore-constants"
import {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  PLATFORM_TUSDC,
  prepareExternalCashDeployment,
  verifyPreparedExternalCashDeployment,
  assertPreparedExternalCashStep,
  type ExternalCashDeploymentInput,
  type UnsignedExternalCashDeployment,
} from "../../scripts/stocks/prepare-external-cash"
import {
  verifyExternalCashDeploymentEvidence,
  type DeploymentReadRpc,
} from "../../scripts/stocks/verify-external-cash"
import { prepareStocksDeployment } from "../../scripts/stocks/prepare-deployment"
import {
  inspectLocalDeployment,
  sendNextLocalDeployment,
  type LocalDeploymentContext,
} from "../../scripts/stocks/local-executor"
import {
  readLocalCreateIntents,
  persistLocalCreateIntent,
} from "../../scripts/stocks/local-journal"

describe("GIWA Stocks existing platform tUSDC deployment", () => {
  const rpc: DeploymentReadRpc = (method, params) => hre.network.provider.send(method, params)
  const key = (value: string) => utils.id(value)
  let cash: Contract, proxyAdmin: Contract, faucet: Contract, implementation: Contract
  let input: ExternalCashDeploymentInput, plan: UnsignedExternalCashDeployment, hashes: string[]
  const evidence = () => ({ plan, expectedPlanDigest: plan.planDigest, transactionHashes: hashes })

  beforeEach(async () => {
    await hre.network.provider.send("hardhat_reset")
    const [deployer, operator, admin, holder] = await hre.ethers.getSigners()
    implementation = await (await hre.ethers.getContractFactory("TestAssetToken", admin)).deploy()
    await implementation.deployed()
    proxyAdmin = await new ContractFactory(
      adminArtifact.abi,
      adminArtifact.bytecode,
      admin,
    ).deploy()
    await proxyAdmin.deployed()
    // A real ERC1967 proxy at the fixed existing platform address inside the local EVM only.
    await hre.network.provider.send("hardhat_setCode", [
      PLATFORM_TUSDC,
      proxyArtifact.deployedBytecode,
    ])
    await hre.network.provider.send("hardhat_setStorageAt", [
      PLATFORM_TUSDC,
      IMPLEMENTATION_SLOT,
      utils.hexZeroPad(implementation.address, 32),
    ])
    await hre.network.provider.send("hardhat_setStorageAt", [
      PLATFORM_TUSDC,
      ADMIN_SLOT,
      utils.hexZeroPad(proxyAdmin.address, 32),
    ])
    cash = await hre.ethers.getContractAt("TestAssetToken", PLATFORM_TUSDC, admin)
    await (await cash.initialize("Test USDC", "tUSDC", 6, admin.address)).wait()
    const faucetImplementation = await (
      await hre.ethers.getContractFactory("TestAssetFaucet", admin)
    ).deploy()
    await faucetImplementation.deployed()
    const faucetProxy = await new ContractFactory(
      proxyArtifact.abi,
      proxyArtifact.bytecode,
      admin,
    ).deploy(
      faucetImplementation.address,
      proxyAdmin.address,
      faucetImplementation.interface.encodeFunctionData("initialize", [admin.address]),
    )
    await faucetProxy.deployed()
    faucet = await hre.ethers.getContractAt("TestAssetFaucet", faucetProxy.address, admin)
    await (await cash.grantRole(key("MINTER_ROLE"), faucet.address)).wait()
    await (
      await faucet.configureAsset(
        cash.address,
        "1000000000",
        "10000000000",
        "1000000000000",
        86400,
        true,
      )
    ).wait()
    await (await faucet.connect(holder).drip(cash.address)).wait()
    assert.equal((await cash.balanceOf(holder.address)).toString(), "1000000000")
    const anchor = await hre.ethers.provider.getBlock("latest")
    const codeHash = async (a: string) => utils.keccak256(await hre.ethers.provider.getCode(a))
    input = {
      chainId: 91342,
      deployer: deployer.address,
      operator: operator.address,
      startingNonce: "0",
      abiDigest: "a".repeat(64),
      cashToken: PLATFORM_TUSDC,
      cashCodeHash: await codeHash(cash.address),
      cashIdentity: {
        kind: "ERC1967",
        implementation: implementation.address,
        implementationCodeHash: await codeHash(implementation.address),
        proxyAdmin: proxyAdmin.address,
        proxyAdminCodeHash: await codeHash(proxyAdmin.address),
      },
      network: {
        networkInstance: "giwa-existing-signer-network",
        checkpointNumber: String(anchor.number),
        checkpointHash: anchor.hash,
      },
    }
    plan = await prepareExternalCashDeployment(input, hre.artifacts)
    hashes = []
  })
  async function deploy(afterStep?: (index: number) => Promise<void>) {
    const completed: { index: number; address: string; runtimeCodeHash: string }[] = []
    for (const [index, step] of plan.steps.entries()) {
      const tx = assertPreparedExternalCashStep(plan, index, {
        chainId: 91342,
        deployer: plan.input.deployer,
        pendingNonce: String(
          await hre.ethers.provider.getTransactionCount(plan.input.deployer, "pending"),
        ),
        completed,
      })
      hashes.push((await rpc("eth_sendTransaction", [{ ...tx, gas: "0x4c4b40" }])) as string)
      const receipt = await hre.ethers.provider.getTransactionReceipt(hashes[index])
      assert.equal(receipt.status, 1)
      const runtimeCodeHash = utils.keccak256(
        await hre.ethers.provider.getCode(step.predictedAddress),
      )
      assert.equal(runtimeCodeHash, step.expectedRuntimeCodeHash)
      completed.push({ index, address: step.predictedAddress, runtimeCodeHash })
      if (afterStep) await afterStep(index)
    }
  }
  const changed =
    (transform: (method: string, params: unknown[], value: any) => unknown): DeploymentReadRpc =>
    async (method, params) =>
      transform(method, params, structuredClone(await rpc(method, params)))

  it("prepares exactly four deterministic offline CREATEs with precise nonces and immutable bindings", async () => {
    assert.equal(plan.steps.length, 4)
    assert.equal(
      plan.steps.some((step) => (step.contractName as string) === "StocksTestCash"),
      false,
    )
    assert.deepEqual(await prepareExternalCashDeployment(input, hre.artifacts), plan)
    assert.deepEqual(await verifyPreparedExternalCashDeployment(plan, hre.artifacts), plan)
    assert.equal(await hre.ethers.provider.getTransactionCount(input.deployer), 0)
    assert.equal(plan.steps[0].constructorArguments[0], PLATFORM_TUSDC)
    const high = await prepareExternalCashDeployment(
      { ...input, startingNonce: "9007199254740993" },
      hre.artifacts,
    )
    assert.equal(high.steps[3].transaction.nonce, "0x20000000000004")
    await deploy()
    for (const step of plan.steps)
      for (const binding of step.expectedBindings) {
        const c = new Contract(
          step.predictedAddress,
          [`function ${binding.getter}() view returns(address)`],
          hre.ethers.provider,
        )
        assert.equal((await c[binding.getter]()).toLowerCase(), binding.expected)
      }
  })

  it("retains an explicit existing network anchor but generates an independent v3 deployment identity", async () => {
    await deploy()
    const calls: string[] = []
    const before = await verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, (m, p) => {
      calls.push(m)
      return rpc(m, p)
    })
    assert.equal(before.manifest.schemaVersion, 3)
    assert.equal(before.manifest.cashToken, PLATFORM_TUSDC)
    assert.equal(before.manifest.cashSymbol, "tUSDC")
    assert.equal(before.manifest.nonUpgradeable, false)
    assert.equal(before.manifest.stockContractsNonUpgradeable, true)
    assert.deepEqual(before.manifest.cashIdentity, plan.input.cashIdentity)
    assert.equal(before.manifest.networkInstance, input.network.networkInstance)
    assert.equal(before.manifest.checkpointNumber, input.network.checkpointNumber)
    assert.equal(before.manifest.checkpointHash, input.network.checkpointHash)
    assert.match(before.manifest.deploymentId, /^giwa-stocks-tusdc-[0-9a-f]{64}$/)
    assert.equal(Object.keys(before.manifest.codeHashes).length, 5)
    assert.equal((await cash.totalSupply()).toString(), "1000000000")
    assert.ok(calls.every((method) => !/send|sign|mine/.test(method)))
    await rpc("evm_mine", [])
    const after = await verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc)
    assert.deepEqual(before.manifest, after.manifest)
  })

  async function roundTrip() {
    const [, operator, , holder] = await hre.ethers.getSigners()
    const [vaultAddress, controllerAddress, stockAddress, escrowAddress] = plan.steps.map(
      (step) => step.predictedAddress,
    )
    const vault = await hre.ethers.getContractAt("StocksFundingVault", vaultAddress, holder)
    const controller = await hre.ethers.getContractAt(
      "StocksMintController",
      controllerAddress,
      operator,
    )
    const stock = await hre.ethers.getContractAt("StocksToken", stockAddress, holder)
    const escrow = await hre.ethers.getContractAt("StocksRedemptionEscrow", escrowAddress, holder)
    await (await cash.connect(holder).approve(vault.address, "120000000")).wait()
    await (await vault.depositForOrder(key("buy"), "120000000")).wait()
    assert.equal((await cash.balanceOf(holder.address)).toString(), "880000000")
    await (
      await controller.mintForOperation(key("mint"), stock.address, holder.address, "1000000000")
    ).wait()
    await (await stock.approve(escrow.address, "1000000000")).wait()
    const receipt = await (
      await escrow.escrowForOrder(key("sell"), stock.address, "1000000000")
    ).wait()
    const event = receipt.events?.find((e: any) => e.event === "StockEscrowed")
    assert.ok(event)
    await (
      await escrow
        .connect(operator)
        .settleRedemption(key("settle"), event.args.escrowId, "120000000")
    ).wait()
    assert.equal((await cash.balanceOf(holder.address)).toString(), "1000000000")
    assert.equal((await cash.balanceOf(vault.address)).toString(), "0")
    assert.equal((await stock.totalSupply()).toString(), "0")
    assert.equal((await stock.balanceOf(escrow.address)).toString(), "0")
    assert.equal((await escrow.cashToken()).toLowerCase(), PLATFORM_TUSDC)
  }

  it("completes actual platform faucet → approve → buy → mint → sell → same tUSDC payout", async () => {
    await deploy()
    await verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc)
    await roundTrip()
  })

  it("cannot pay the tUSDC vault by approving the old ARCO cash token", async () => {
    await deploy()
    const [, , admin, holder] = await hre.ethers.getSigners()
    const oldCash = await (
      await hre.ethers.getContractFactory("StocksTestCash", admin)
    ).deploy(admin.address)
    await oldCash.deployed()
    await (await oldCash.faucet(holder.address, "120000000")).wait()
    await (
      await oldCash.connect(holder).approve(plan.steps[0].predictedAddress, "120000000")
    ).wait()
    const vault = await hre.ethers.getContractAt(
      "StocksFundingVault",
      plan.steps[0].predictedAddress,
      holder,
    )
    await assert.rejects(
      vault.depositForOrder(key("wrong-cash"), "120000000"),
      /insufficient allowance/,
    )
    assert.equal((await cash.balanceOf(vault.address)).toString(), "0")
    assert.equal((await oldCash.balanceOf(holder.address)).toString(), "120000000")
  })

  it("rejects wrong asset, unknown input keys, malformed identity, unsafe nonce and modified approved plan before RPC", async () => {
    const bad = [
      null,
      { ...input, chainId: 1 },
      { ...input, cashToken: input.deployer },
      { ...input, startingNonce: "18446744073709551612" },
      { ...input, startingNonce: "01" },
      { ...input, cashIdentity: { ...input.cashIdentity, implementation: PLATFORM_TUSDC } },
      { ...input, cashIdentity: { ...input.cashIdentity, extra: true } },
      { ...input, extra: true },
      { ...input, network: { ...input.network, checkpointNumber: 1 } },
      { ...input, operator: input.deployer },
    ]
    for (const value of bad)
      await assert.rejects(prepareExternalCashDeployment(value, hre.artifacts))
    const tampered = structuredClone(plan)
    tampered.steps[0].transaction.data = "0x6000"
    await assert.rejects(
      verifyPreparedExternalCashDeployment(tampered, hre.artifacts),
      /PLAN_CHANGED/,
    )
    const none: DeploymentReadRpc = async () => {
      throw Error("UNEXPECTED_RPC")
    }
    hashes = [key("1"), key("2"), key("3"), key("4")]
    for (const value of [
      { ...evidence(), plan: tampered },
      { ...evidence(), expectedPlanDigest: "b".repeat(64) },
      { ...evidence(), transactionHashes: [key("1"), key("2"), key("3"), key("3")] },
    ]) {
      await assert.rejects(
        verifyExternalCashDeploymentEvidence(value, hre.artifacts, none),
        (error) => !String(error).includes("UNEXPECTED_RPC"),
      )
    }
  })

  it("supports the specifically approved single administrator without broadening other role collisions", async () => {
    const single = await prepareExternalCashDeployment(
      { ...input, deployer: EXPECTED_GIWA_DEPLOYER, operator: EXPECTED_GIWA_DEPLOYER },
      hre.artifacts,
    )
    assert.equal(single.input.operator, EXPECTED_GIWA_DEPLOYER.toLowerCase())
    const v2 = await prepareStocksDeployment(
      {
        chainId: 91342,
        deployer: input.deployer,
        operator: input.operator,
        faucetOperator: (await hre.ethers.getSigners())[2].address,
        startingNonce: "0",
      },
      hre.artifacts,
    )
    assert.equal(v2.steps.length, 5)
    assert.equal(v2.stockPolicy.nonUpgradeable, true)
    await assert.rejects(verifyPreparedExternalCashDeployment(v2, hre.artifacts))
  })

  it("detects proxy implementation and admin slot changes even when proxy bytecode is unchanged", async () => {
    await deploy()
    const proxyCode = await hre.ethers.provider.getCode(PLATFORM_TUSDC)
    const [, , admin] = await hre.ethers.getSigners()
    const replacement = await (
      await hre.ethers.getContractFactory("TestAssetToken", admin)
    ).deploy()
    await replacement.deployed()
    await (await proxyAdmin.upgrade(PLATFORM_TUSDC, replacement.address)).wait()
    assert.equal(await hre.ethers.provider.getCode(PLATFORM_TUSDC), proxyCode)
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc),
      /PROXY_IDENTITY_MISMATCH/,
    )
    await (await proxyAdmin.upgrade(PLATFORM_TUSDC, implementation.address)).wait()
    // Restoring the expected identity cannot erase the intervening upgrade history.
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc),
      /PROXY_ACTIVITY/,
    )
    await hre.network.provider.send("hardhat_setStorageAt", [
      PLATFORM_TUSDC,
      ADMIN_SLOT,
      utils.hexZeroPad(admin.address, 32),
    ])
    await hre.network.provider.send("evm_mine")
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc),
      /PROXY_IDENTITY_MISMATCH/,
    )
  })

  it("rejects changed implementation/admin bytecode, cash metadata and absent runtime code", async () => {
    await deploy()
    for (const target of [
      PLATFORM_TUSDC,
      plan.input.cashIdentity.implementation,
      plan.input.cashIdentity.proxyAdmin,
    ]) {
      await assert.rejects(
        verifyExternalCashDeploymentEvidence(
          evidence(),
          hre.artifacts,
          changed((m, p, v) => (m === "eth_getCode" && p[0] === target ? "0x6000" : v)),
        ),
        /CODE_IDENTITY_MISMATCH/,
      )
    }
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(
        evidence(),
        hre.artifacts,
        changed((m, p, v) =>
          m === "eth_call" && (p[0] as any).data === "0x313ce567"
            ? utils.hexZeroPad("0x12", 32)
            : v,
        ),
      ),
      /TOKEN_SCALE_MISMATCH/,
    )
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(
        evidence(),
        hre.artifacts,
        changed((m, p, v) =>
          m === "eth_call" && (p[0] as any).data === "0x95d89b41"
            ? utils.defaultAbiCoder.encode(["string"], ["USDC"])
            : v,
        ),
      ),
      /SYMBOL_MISMATCH/,
    )
  })

  it("rejects real pre-activation deposits, donations, and a fully completed round trip with zero final balances", async () => {
    await deploy()
    await roundTrip()
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc),
      /ECONOMIC_OR_PROXY_ACTIVITY/,
    )
    const [, , , holder] = await hre.ethers.getSigners()
    await (await cash.connect(holder).transfer(plan.steps[0].predictedAddress, "1")).wait()
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc),
      /PRE_ACTIVATION_VAULT_BALANCE/,
    )
  })

  it("rejects missing or unfinalized creation evidence, altered nonce/calldata/sender and canonical inclusion", async () => {
    await deploy()
    const lastReceipt = await hre.ethers.provider.getTransactionReceipt(hashes[3])
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, (m, p) =>
        rpc(
          m,
          m === "eth_getBlockByNumber" && p[0] === "finalized"
            ? [utils.hexValue(lastReceipt.blockNumber - 1), false]
            : p,
        ),
      ),
      /NOT_FINALIZED/,
    )
    for (const replacement of [
      { nonce: "0xff" },
      { input: "0x6000" },
      { from: input.operator },
      { to: input.operator },
    ]) {
      await assert.rejects(
        verifyExternalCashDeploymentEvidence(
          evidence(),
          hre.artifacts,
          changed((m, p, v) =>
            m === "eth_getTransactionByHash" && p[0] === hashes[0] ? { ...v, ...replacement } : v,
          ),
        ),
      )
    }
    const firstReceipt = await hre.ethers.provider.getTransactionReceipt(hashes[0])
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(
        evidence(),
        hre.artifacts,
        changed((m, p, v) =>
          m === "eth_getBlockByNumber" && p[0] === utils.hexValue(firstReceipt.blockNumber)
            ? { ...v, transactions: [] }
            : v,
        ),
      ),
      /NOT_IN_CANONICAL_BLOCK/,
    )
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(
        evidence(),
        hre.artifacts,
        changed((m, p, v) => (m === "eth_getTransactionReceipt" && p[0] === hashes[0] ? null : v)),
      ),
      /PENDING_OR_MISSING/,
    )
  })

  it("requires the retained anchor to match canonical history and rejects changes during verification", async () => {
    await deploy()
    const tag = utils.hexValue(BigInt(input.network.checkpointNumber))
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(
        evidence(),
        hre.artifacts,
        changed((m, p, v) =>
          m === "eth_getBlockByNumber" && p[0] === tag ? { ...v, hash: key("wrong") } : v,
        ),
      ),
      /CHECKPOINT_MISMATCH/,
    )
    let reads = 0
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(
        evidence(),
        hre.artifacts,
        changed((m, p, v) =>
          m === "eth_getBlockByNumber" && p[0] === tag && ++reads > 1
            ? { ...v, hash: key("changed") }
            : v,
        ),
      ),
      /CHECKPOINT_CHANGED/,
    )
  })

  async function withExecutor(
    work: (context: LocalDeploymentContext, wallet: Wallet) => Promise<void>,
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "stocks-external-executor-"))
    try {
      const wallet = Wallet.createRandom()
      await rpc("hardhat_setBalance", [wallet.address, "0x56bc75e2d63100000"])
      plan = await prepareExternalCashDeployment(
        { ...input, deployer: wallet.address },
        hre.artifacts,
      )
      const journal = path.join(directory, "journal")
      await mkdir(journal, { mode: 0o700 })
      await work(
        {
          plan,
          journal,
          expectedDeployer: wallet.address,
          artifacts: hre.artifacts,
          rpc,
          approval: {
            expectedPlanDigest: plan.planDigest,
            genesisHash: (await hre.ethers.provider.getBlock(0)).hash,
            maxGas: "5000000",
            maxPriorityFeePerGas: "1000000000",
            maxFeePerGas: "3000000000",
            maxTotalFeeWei: "15000000000000000",
          },
        },
        wallet,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it("uses the durable original-transaction journal for exactly four externally signed local creations", async () => {
    await withExecutor(async (context, wallet) => {
      let sends = 0
      const tracked = {
        ...context,
        rpc: async (m: string, p: unknown[]) => {
          if (m === "eth_sendRawTransaction") sends++
          return rpc(m, p)
        },
      }
      for (let i = 0; i < 4; i++) {
        const entry = await sendNextLocalDeployment(tracked, (tx) => wallet.signTransaction(tx))
        assert.equal(entry.index, i)
        const restored = await inspectLocalDeployment(tracked)
        assert.equal(restored.next?.index ?? null, i === 3 ? null : i + 1)
      }
      hashes = (await readLocalCreateIntents(context.journal)).map((e) => e.transactionHash)
      await verifyExternalCashDeploymentEvidence(evidence(), hre.artifacts, rpc)
      await assert.rejects(
        sendNextLocalDeployment(tracked, (tx) => wallet.signTransaction(tx)),
        /ALREADY_COMPLETE/,
      )
      assert.equal(sends, 4)
      await persistLocalCreateIntent(context.journal, {
        version: 1,
        planDigest: plan.planDigest,
        genesisHash: context.approval.genesisHash,
        deployer: wallet.address.toLowerCase(),
        index: 4,
        nonce: "4",
        transactionHash: key("forbidden-fifth"),
      })
      await assert.rejects(inspectLocalDeployment(tracked), /JOURNAL_BINDING_MISMATCH/)
      assert.equal(sends, 4)
    })
  })

  it("recovers the original four-step deployment transaction after a lost broadcast response without signing or sending it again", async () => {
    await withExecutor(async (context, wallet) => {
      let sends = 0,
        signs = 0
      const sign = (tx: Record<string, unknown>) => {
        signs++
        return wallet.signTransaction(tx)
      }
      const uncertain = {
        ...context,
        rpc: async (m: string, p: unknown[]) => {
          const result = await rpc(m, p)
          if (m === "eth_sendRawTransaction") {
            sends++
            throw Error("lost response")
          }
          return result
        },
      }
      await assert.rejects(
        sendNextLocalDeployment(uncertain, sign),
        /BROADCAST_UNCERTAIN_USE_RECOVER/,
      )
      const restored = await inspectLocalDeployment(context)
      assert.equal(restored.entries.length, 1)
      assert.equal(restored.next?.index, 1)
      assert.equal(signs, 1)
      assert.equal(sends, 1)
    })
  })

  it("blocks external cash changes during a signing prompt and rejects incorrect signed bytes before journaling", async () => {
    await withExecutor(async (context, wallet) => {
      await assert.rejects(
        sendNextLocalDeployment(context, (tx) => wallet.signTransaction({ ...tx, nonce: 1 })),
        /SIGNED_DEPLOYMENT_ATTESTATION_FAILED/,
      )
      assert.deepEqual(await readLocalCreateIntents(context.journal), [])
      const [, , admin] = await hre.ethers.getSigners()
      await assert.rejects(
        sendNextLocalDeployment(context, async (tx) => {
          const signed = await wallet.signTransaction(tx)
          await rpc("hardhat_setStorageAt", [
            PLATFORM_TUSDC,
            ADMIN_SLOT,
            utils.hexZeroPad(admin.address, 32),
          ])
          await rpc("evm_mine", [])
          return signed
        }),
        /EXTERNAL_CASH_CHANGED/,
      )
      assert.deepEqual(await readLocalCreateIntents(context.journal), [])
      assert.equal(await hre.ethers.provider.getTransactionCount(wallet.address), 0)
    })
  })

  it("prepares a public CLI artifact without loading Hardhat configuration or touching chain state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stocks-external-plan-"))
    try {
      const inputPath = path.join(directory, "public-input.json"),
        outputPath = path.join(directory, "plan.json")
      await writeFile(inputPath, JSON.stringify(input))
      const result = spawnSync(
        process.execPath,
        [
          require.resolve("ts-node/dist/bin.js"),
          "scripts/stocks/prepare-external-cash.ts",
          "--input",
          inputPath,
          "--output",
          outputPath,
        ],
        {
          cwd: path.resolve(__dirname, "../.."),
          encoding: "utf8",
          env: { ...process.env, GIWA_REQUIRE_KEYSTORE: "1" },
        },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), plan)
      assert.equal(await hre.ethers.provider.getTransactionCount(input.deployer), 0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
