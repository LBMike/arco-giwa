import assert from "assert/strict"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import hre from "hardhat"
import { Contract, ContractFactory, Wallet, utils } from "ethers"
import proxyArtifact from "@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json"
import adminArtifact from "@openzeppelin/contracts/build/contracts/ProxyAdmin.json"
import {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  PLATFORM_TUSDC,
  prepareExternalCashDeployment,
  type UnsignedExternalCashDeployment,
} from "../../scripts/stocks/prepare-external-cash"
import { prepareStocksDeployment } from "../../scripts/stocks/prepare-deployment"
import {
  verifyExternalCashDeploymentEvidence,
  type DeploymentReadRpc,
} from "../../scripts/stocks/verify-external-cash"
import {
  inspectIncludedExternalCashDeployment,
  sendNextIncludedExternalCashDeployment,
  inspectLocalDeployment,
  sendNextLocalDeployment,
  type LocalDeploymentContext,
} from "../../scripts/stocks/local-executor"
import { readLocalCreateIntents } from "../../scripts/stocks/local-journal"

describe("external-cash CREATE inclusion sequencing (never activation finality)", () => {
  const rpc: DeploymentReadRpc = (method, params) => hre.network.provider.send(method, params)
  let context: LocalDeploymentContext, plan: UnsignedExternalCashDeployment, wallet: Wallet
  let directory: string, anchorTag: string, anchorHash: string
  let sends: number, signatures: number
  const sign = async (transaction: Record<string, unknown>) => {
    signatures++
    return wallet.signTransaction(transaction)
  }
  const frozen: DeploymentReadRpc = (method, params) => {
    if (method === "eth_sendRawTransaction") sends++
    return rpc(
      method,
      method === "eth_getBlockByNumber" && params[0] === "finalized" ? [anchorTag, false] : params,
    )
  }
  const changed =
    (transform: (method: string, params: unknown[], value: any) => any): DeploymentReadRpc =>
    async (method, params) =>
      transform(method, params, structuredClone(await frozen(method, params)))
  const inspect = () => inspectIncludedExternalCashDeployment(context)
  const send = () => sendNextIncludedExternalCashDeployment(context, sign)

  beforeEach(async () => {
    await rpc("hardhat_reset", [])
    directory = await mkdtemp(path.join(tmpdir(), "stocks-inclusion-"))
    const journal = path.join(directory, "journal")
    await mkdir(journal, { mode: 0o700 })
    const [, operator, admin] = await hre.ethers.getSigners()
    const implementation = await (
      await hre.ethers.getContractFactory("TestAssetToken", admin)
    ).deploy()
    const proxyAdmin = await new ContractFactory(
      adminArtifact.abi,
      adminArtifact.bytecode,
      admin,
    ).deploy()
    await implementation.deployed()
    await proxyAdmin.deployed()
    await rpc("hardhat_setCode", [PLATFORM_TUSDC, proxyArtifact.deployedBytecode])
    await rpc("hardhat_setStorageAt", [
      PLATFORM_TUSDC,
      IMPLEMENTATION_SLOT,
      utils.hexZeroPad(implementation.address, 32),
    ])
    await rpc("hardhat_setStorageAt", [
      PLATFORM_TUSDC,
      ADMIN_SLOT,
      utils.hexZeroPad(proxyAdmin.address, 32),
    ])
    const cash = await hre.ethers.getContractAt("TestAssetToken", PLATFORM_TUSDC, admin)
    await (await cash.initialize("Test USDC", "tUSDC", 6, admin.address)).wait()
    const anchor = await hre.ethers.provider.getBlock("latest")
    anchorTag = utils.hexValue(anchor.number)
    anchorHash = anchor.hash
    wallet = Wallet.createRandom()
    await rpc("hardhat_setBalance", [wallet.address, "0x8ac7230489e80000"])
    const codeHash = async (address: string) =>
      utils.keccak256(await hre.ethers.provider.getCode(address))
    plan = await prepareExternalCashDeployment(
      {
        chainId: 91342,
        deployer: wallet.address,
        operator: operator.address,
        startingNonce: "0",
        abiDigest: "a".repeat(64),
        cashToken: PLATFORM_TUSDC,
        cashCodeHash: await codeHash(PLATFORM_TUSDC),
        cashIdentity: {
          kind: "ERC1967",
          implementation: implementation.address,
          implementationCodeHash: await codeHash(implementation.address),
          proxyAdmin: proxyAdmin.address,
          proxyAdminCodeHash: await codeHash(proxyAdmin.address),
        },
        network: {
          networkInstance: "giwa-inclusion-fixture",
          checkpointNumber: String(anchor.number),
          checkpointHash: anchor.hash,
        },
      },
      hre.artifacts,
    )
    const genesis = await hre.ethers.provider.getBlock(0)
    context = {
      plan,
      expectedDeployer: wallet.address,
      artifacts: hre.artifacts,
      rpc: frozen,
      journal,
      approval: {
        expectedPlanDigest: plan.planDigest,
        genesisHash: genesis.hash,
        maxGas: "5000000",
        maxPriorityFeePerGas: "1000000000",
        maxFeePerGas: "3000000000",
        maxTotalFeeWei: "15000000000000000",
      },
    }
    sends = 0
    signatures = 0
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  type CashReadPhase = "checkpoint" | "preflight identity" | "pinned identity"
  function failCashRead(phase: CashReadPhase, failure: () => unknown) {
    let implementationReads = 0,
      injected = 0
    context.rpc = async (method, params) => {
      if (method === "eth_getStorageAt" && params[1] === IMPLEMENTATION_SLOT) implementationReads++
      const atCheckpoint = method === "eth_getBlockByNumber" && params[0] === anchorTag
      const atIdentity = method === "eth_getStorageAt" && params[1] === IMPLEMENTATION_SLOT
      if (
        (phase === "checkpoint" && atCheckpoint) ||
        (phase === "preflight identity" && atIdentity && implementationReads === 1) ||
        (phase === "pinned identity" && atIdentity && implementationReads === 3)
      ) {
        injected++
        throw failure()
      }
      return frozen(method, params)
    }
    return () => assert.equal(injected, 1, `error reached ${phase}`)
  }

  it("preserves safe transport and cancellation codes at checkpoint, preflight and pinned cash reads without signing", async () => {
    const failures: [() => Error, string][] = [
      ...[
        "DEPLOYMENT_RPC_UNAVAILABLE",
        "LOCAL_DEPLOYMENT_RPC_UNAVAILABLE",
        "DEPLOYMENT_RPC_RESPONSE_INVALID",
        "TUSDC_DEPLOYMENT_STOPPED",
      ].map((code): [() => Error, string] => [
        () => Object.assign(Error(code), { cause: Error("provider response must stay private") }),
        code,
      ]),
      [
        () => Object.assign(Error("private abort details"), { name: "AbortError" }),
        "TUSDC_DEPLOYMENT_STOPPED",
      ],
      [() => new DOMException("private abort details", "AbortError"), "TUSDC_DEPLOYMENT_STOPPED"],
    ]
    for (const phase of ["checkpoint", "preflight identity", "pinned identity"] as const) {
      // The original finalized executor uses the same preflight, but no inclusion cutoff.
      const operations =
        phase === "pinned identity" ? [send] : [send, () => inspectLocalDeployment(context)]
      for (const operation of operations)
        for (const [failure, expected] of failures) {
          const assertInjected = failCashRead(phase, failure)
          await assert.rejects(operation(), (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.equal(error.message, expected)
            assert.equal("cause" in error, false)
            return true
          })
          assertInjected()
        }
    }
    assert.equal(signatures, 0)
    assert.equal(sends, 0)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 0)
  })

  it("does not expose unknown provider text or code-like substrings through cash validation errors", async () => {
    for (const phase of ["checkpoint", "preflight identity", "pinned identity"] as const)
      for (const failure of [
        () => Error("provider URL/body/private details"),
        () => Error("DEPLOYMENT_RPC_UNAVAILABLE: provider URL/body/private details"),
        () => ({ message: "DEPLOYMENT_RPC_UNAVAILABLE", cause: "private details" }),
      ]) {
        const assertInjected = failCashRead(phase, failure)
        await assert.rejects(send(), (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, "LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED")
          assert.equal("cause" in error, false)
          return true
        })
        assertInjected()
      }
    assert.equal(signatures, 0)
    assert.equal(sends, 0)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 0)
  })

  it("still blocks a real proxy storage change discovered at the pinned inclusion cutoff", async () => {
    let implementationReads = 0
    context.rpc = async (method, params) => {
      if (method === "eth_getStorageAt" && params[1] === IMPLEMENTATION_SLOT)
        if (++implementationReads === 3)
          await rpc("hardhat_setStorageAt", [
            PLATFORM_TUSDC,
            IMPLEMENTATION_SLOT,
            utils.hexZeroPad(wallet.address, 32),
          ])
      return frozen(method, params)
    }
    await assert.rejects(send(), { message: "LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED" })
    assert.equal(implementationReads, 3)
    assert.equal(signatures, 0)
    assert.equal(sends, 0)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 0)
  })

  it("includes four ordered CREATEs while finalized is frozen, satisfies Escrow getters, and still refuses final activation", async () => {
    const hashes: string[] = []
    for (let index = 0; index < 4; index++) {
      assert.equal((await inspect()).next?.index, index)
      const entry = await send()
      hashes.push(entry.transactionHash)
      assert.equal(entry.index, index)
      assert.equal(entry.nonce, String(index))
      assert.equal(
        ((await rpc("eth_getBlockByNumber", [anchorTag, false])) as any).hash,
        anchorHash,
      )
      await assert.rejects(inspectLocalDeployment(context), /ORIGINAL_NOT_FINALIZED/)
    }
    const state = await inspect()
    assert.equal(state.next, null)
    assert.equal(state.completed.length, 4)
    assert.equal(state.originals.length, 4)
    assert.ok(BigInt(state.inclusionCutoff.number) > BigInt(anchorTag))
    assert.equal("manifest" in state, false)
    for (const step of plan.steps)
      for (const binding of step.expectedBindings) {
        const contract = new Contract(
          step.predictedAddress,
          [`function ${binding.getter}() view returns(address)`],
          hre.ethers.provider,
        )
        assert.equal((await contract[binding.getter]()).toLowerCase(), binding.expected)
      }
    const evidence = { plan, expectedPlanDigest: plan.planDigest, transactionHashes: hashes }
    await assert.rejects(
      verifyExternalCashDeploymentEvidence(evidence, hre.artifacts, frozen),
      /FINAL/,
    )
    const final = await verifyExternalCashDeploymentEvidence(evidence, hre.artifacts, rpc)
    assert.equal(final.manifest.schemaVersion, 3)
    await assert.rejects(send(), /ALREADY_COMPLETE/)
    assert.equal(sends, 4)
    assert.equal(signatures, 4)
  })

  it("recovers an existing finalized-executor original without re-signing and without waiting for finality", async () => {
    const entry = await sendNextLocalDeployment(context, sign)
    await assert.rejects(inspectLocalDeployment(context), /ORIGINAL_NOT_FINALIZED/)
    const resumed = await inspect()
    assert.equal(resumed.entries[0].transactionHash, entry.transactionHash)
    assert.equal(resumed.next?.index, 1)
    await send()
    assert.equal(sends, 2)
    assert.equal(signatures, 2)
  })

  it("recovers a lost successful broadcast response from the original hash without another send", async () => {
    context.rpc = async (method, params) => {
      const result = await frozen(method, params)
      if (method === "eth_sendRawTransaction") throw Error("response lost")
      return result
    }
    await assert.rejects(send(), /BROADCAST_UNCERTAIN_USE_RECOVER/)
    const [entry] = await readLocalCreateIntents(context.journal)
    context.rpc = frozen
    const resumed = await inspect()
    assert.equal(resumed.next?.index, 1)
    assert.equal(resumed.originals[0].transactionHash, entry.transactionHash)
    assert.equal(signatures, 1)
    assert.equal(sends, 1)
  })

  it("leaves an unknown original as a permanent no-resend barrier even if submission failed before reaching the node", async () => {
    context.rpc = (method, params) =>
      method === "eth_sendRawTransaction"
        ? Promise.reject(Error("transport unavailable"))
        : frozen(method, params)
    await assert.rejects(send(), /BROADCAST_UNCERTAIN_USE_RECOVER/)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 1)
    context.rpc = frozen
    await assert.rejects(inspect(), /ORIGINAL_UNRESOLVED/)
    await assert.rejects(send(), /ORIGINAL_UNRESOLVED/)
    assert.equal(signatures, 1)
    assert.equal(sends, 0)
  })

  it("rejects failed, missing, pending, altered nonce/address/calldata, noncanonical and wrong-code originals before any next signature", async () => {
    await send()
    const faults: [string, (method: string, params: unknown[], value: any) => any, RegExp][] = [
      [
        "failed",
        (m, _p, v) => (m === "eth_getTransactionReceipt" ? { ...v, status: "0x0" } : v),
        /ORIGINAL_FAILED/,
      ],
      [
        "missing receipt",
        (m, _p, v) => (m === "eth_getTransactionReceipt" ? null : v),
        /ORIGINAL_UNRESOLVED/,
      ],
      [
        "missing original",
        (m, _p, v) => (m === "eth_getTransactionByHash" ? null : v),
        /ORIGINAL_UNRESOLVED/,
      ],
      [
        "pending original",
        (m, _p, v) => (m === "eth_getTransactionByHash" ? { ...v, blockNumber: null } : v),
        /ORIGINAL_UNRESOLVED/,
      ],
      [
        "nonce",
        (m, _p, v) => (m === "eth_getTransactionByHash" ? { ...v, nonce: "0x1" } : v),
        /ORIGINAL_CHANGED/,
      ],
      [
        "address",
        (m, _p, v) =>
          m === "eth_getTransactionReceipt" ? { ...v, contractAddress: PLATFORM_TUSDC } : v,
        /ORIGINAL_CHANGED/,
      ],
      [
        "calldata",
        (m, _p, v) => (m === "eth_getTransactionByHash" ? { ...v, input: "0x6000" } : v),
        /ORIGINAL_CHANGED/,
      ],
      [
        "canonical inclusion",
        (m, p, v) =>
          m === "eth_getBlockByNumber" && p[0] !== anchorTag && p[0] !== "0x0"
            ? { ...v, transactions: [] }
            : v,
        /CANONICAL_HISTORY_CHANGED/,
      ],
      [
        "runtime",
        (m, p, v) =>
          m === "eth_getCode" && p[0] === plan.steps[0].predictedAddress ? "0x6000" : v,
        /RUNTIME_CHANGED/,
      ],
    ]
    for (const [label, transform, error] of faults) {
      context.rpc = changed(transform)
      await assert.rejects(send(), error, label)
      assert.equal((await readLocalCreateIntents(context.journal)).length, 1, label)
    }
    assert.equal(signatures, 1)
    assert.equal(sends, 1)
  })

  it("distinguishes an original beyond the pinned latest cutoff from an unfinalized original", async () => {
    await send()
    context.rpc = (method, params) =>
      frozen(
        method,
        method === "eth_getBlockByNumber" && params[0] === "latest" ? [anchorTag, false] : params,
      )
    await assert.rejects(inspect(), /ORIGINAL_NOT_INCLUDED/)
  })

  it("checks both pinned and pending nonce, including after all four originals", async () => {
    await send()
    for (const target of ["pending", "numbered"]) {
      context.rpc = changed((m, p, v) =>
        m === "eth_getTransactionCount" &&
        (target === "pending" ? p[1] === "pending" : p[1] !== "pending")
          ? "0x2"
          : v,
      )
      await assert.rejects(send(), /NONCE_CHANGED/)
    }
    context.rpc = frozen
    for (let i = 1; i < 4; i++) await send()
    context.rpc = changed((m, _p, v) => (m === "eth_getTransactionCount" ? "0x5" : v))
    await assert.rejects(inspect(), /NONCE_CHANGED/)
    assert.equal(sends, 4)
  })

  it("revalidates before signing when pricing races a prior receipt disappearance", async () => {
    await send()
    let hidden = false
    context.rpc = changed((method, _params, value) => {
      if (method === "eth_estimateGas") hidden = true
      return hidden && method === "eth_getTransactionReceipt" ? null : value
    })
    await assert.rejects(send(), /ORIGINAL_UNRESOLVED/)
    assert.equal(signatures, 1)
    assert.equal(sends, 1)
  })

  it("halts after a real reorg removes a prior original during signing", async () => {
    const snapshot = await rpc("evm_snapshot", [])
    await send()
    await assert.rejects(
      sendNextIncludedExternalCashDeployment(context, async (tx) => {
        const signed = await sign(tx)
        await rpc("evm_revert", [snapshot])
        return signed
      }),
      /ORIGINAL_UNRESOLVED/,
    )
    assert.equal((await readLocalCreateIntents(context.journal)).length, 1)
    assert.equal(sends, 1)
  })

  it("rejects a prior original re-included at a different canonical position during signing", async () => {
    await send()
    const receipt = (await rpc("eth_getTransactionReceipt", [
      (await inspect()).entries[0].transactionHash,
    ])) as any
    let relocated = false
    const alternateHash = utils.id("alternate canonical block")
    context.rpc = changed((m, p, v) => {
      if (!relocated) return v
      if (m === "eth_getTransactionReceipt" || m === "eth_getTransactionByHash")
        return { ...v, blockHash: alternateHash }
      if (m === "eth_getBlockByNumber" && (p[0] === receipt.blockNumber || p[0] === "latest"))
        return { ...v, hash: alternateHash }
      return v
    })
    await assert.rejects(
      sendNextIncludedExternalCashDeployment(context, async (tx) => {
        const signed = await sign(tx)
        relocated = true
        return signed
      }),
      /CANONICAL_HISTORY_CHANGED/,
    )
    assert.equal(sends, 1)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 1)
  })

  it("rechecks all original receipts after attestation, before recording or broadcasting the next intent", async () => {
    await send()
    let signed = false,
      artifactReads = 0,
      missing = false
    context.artifacts = {
      readArtifact: async (name) => {
        if (signed && ++artifactReads === 5) missing = true // 4 in post-sign inspect, then attestation.
        return hre.artifacts.readArtifact(name)
      },
      getBuildInfo: (name) => hre.artifacts.getBuildInfo(name),
    }
    context.rpc = changed((m, _p, v) => (missing && m === "eth_getTransactionReceipt" ? null : v))
    await assert.rejects(
      sendNextIncludedExternalCashDeployment(context, async (tx) => {
        const result = await sign(tx)
        signed = true
        return result
      }),
      /ORIGINAL_UNRESOLVED/,
    )
    assert.ok(missing)
    assert.equal(sends, 1)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 1)
  })

  it("does not broadcast if a prior original disappears after durable intent persistence", async () => {
    await send()
    context.rpc = async (m, p) => {
      const result = await frozen(m, p)
      return m === "eth_getTransactionReceipt" &&
        (await readLocalCreateIntents(context.journal)).length === 2
        ? null
        : result
    }
    await assert.rejects(send(), /ORIGINAL_UNRESOLVED/)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 2)
    assert.equal(sends, 1)
    context.rpc = frozen
    await assert.rejects(send(), /ORIGINAL_UNRESOLVED/)
    assert.equal(signatures, 2)
    assert.equal(sends, 1)
  })

  it("rejects a cash proxy upgrade during signing although finalized identity is still unchanged", async () => {
    await send()
    await assert.rejects(
      sendNextIncludedExternalCashDeployment(context, async (tx) => {
        const signed = await sign(tx)
        await rpc("hardhat_setStorageAt", [
          PLATFORM_TUSDC,
          IMPLEMENTATION_SLOT,
          utils.hexZeroPad(PLATFORM_TUSDC, 32),
        ])
        await rpc("evm_mine", [])
        return signed
      }),
      /EXTERNAL_CASH_CHANGED/,
    )
    assert.equal((await readLocalCreateIntents(context.journal)).length, 1)
    assert.equal(sends, 1)
  })

  it("retains envelope, gas, fee, balance and empty CREATE-address checks", async () => {
    const invalid = Wallet.createRandom()
    await assert.rejects(
      sendNextIncludedExternalCashDeployment(context, (tx) => invalid.signTransaction(tx)),
      /ATTESTATION_FAILED/,
    )
    const cases: [(m: string, p: unknown[], v: any) => any, RegExp][] = [
      [(m, _p, v) => (m === "eth_getBalance" ? "0x0" : v), /GAS_BALANCE/],
      [(m, _p, v) => (m === "eth_estimateGas" ? "0x10000000" : v), /GAS_LIMIT/],
      [
        (m, p, v) =>
          m === "eth_getBlockByNumber" && p[0] === "latest"
            ? { ...v, baseFeePerGas: "0x10000000000" }
            : v,
        /FEE_LIMIT/,
      ],
      [
        (m, p, v) =>
          m === "eth_getCode" && p[0] === plan.steps[0].predictedAddress && p[1] === "pending"
            ? "0x6000"
            : v,
        /ADDRESS_OCCUPIED/,
      ],
    ]
    for (const [transform, error] of cases) {
      context.rpc = changed(transform)
      await assert.rejects(send(), error)
      assert.equal((await readLocalCreateIntents(context.journal)).length, 0)
    }
    assert.equal(sends, 0)
  })

  it("refuses v2 inclusion mode and preserves the original five-step finalized executor policy", async () => {
    const [, operator, faucetOperator] = await hre.ethers.getSigners()
    const v2 = await prepareStocksDeployment(
      {
        chainId: 91342,
        deployer: wallet.address,
        operator: operator.address,
        faucetOperator: faucetOperator.address,
        startingNonce: "0",
      },
      hre.artifacts,
    )
    context.plan = v2
    context.approval.expectedPlanDigest = v2.planDigest
    await assert.rejects(inspect(), /INCLUDED_REQUIRES_EXTERNAL_CASH/)
    await assert.rejects(send(), /INCLUDED_REQUIRES_EXTERNAL_CASH/)
    await sendNextLocalDeployment(context, sign)
    await assert.rejects(sendNextLocalDeployment(context, sign), /ORIGINAL_NOT_FINALIZED/)
    assert.equal(v2.steps.length, 5)
    assert.equal(sends, 1)
    assert.equal(signatures, 1)
  })
})
