import assert from "assert/strict"
import { randomUUID } from "crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, symlink } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { createServer } from "http"
import { spawn } from "child_process"
import hre from "hardhat"
import { Wallet, utils } from "ethers"
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
import { unlockLocalDeploymentWallet } from "../../scripts/stocks/local-keystore"
import { verifyStocksDeploymentEvidence } from "../../scripts/stocks/verify-deployment"

describe("GIWA local encrypted-key deployment executor", () => {
  let root: string, context: LocalDeploymentContext, wallet: Wallet, sends: number
  const direct = (method: string, params: unknown[]) => hre.network.provider.send(method, params)
  const sign = (transaction: any) => wallet.signTransaction(transaction)
  beforeEach(async () => {
    await hre.network.provider.send("hardhat_reset")
    wallet = Wallet.createRandom()
    await direct("hardhat_setBalance", [wallet.address, "0x56bc75e2d63100000"])
    root = await mkdtemp(path.join(tmpdir(), "stocks-local-deploy-test-"))
    const journal = path.join(root, "journal")
    await mkdir(journal, { mode: 0o700 })
    const [, operator, faucet] = await hre.ethers.getSigners()
    const plan = await prepareStocksDeployment(
      {
        chainId: 91342,
        deployer: wallet.address,
        operator: operator.address,
        faucetOperator: faucet.address,
        startingNonce: "0",
      },
      hre.artifacts,
    )
    sends = 0
    context = {
      plan,
      expectedDeployer: wallet.address,
      journal,
      artifacts: hre.artifacts,
      approval: {
        expectedPlanDigest: plan.planDigest,
        genesisHash: (await direct("eth_getBlockByNumber", ["0x0", false])).hash,
        maxGas: "5000000",
        maxPriorityFeePerGas: "1000000000",
        maxFeePerGas: "3000000000",
        maxTotalFeeWei: "15000000000000000",
      },
      rpc: async (method, params) => {
        if (method === "eth_sendRawTransaction") sends++
        return direct(method, params)
      },
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("unlocks only a private encrypted file and signs five actual CREATEs before final verification", async () => {
    const password = randomUUID(),
      keystore = path.join(root, "test-wallet.json")
    await writeFile(keystore, await wallet.encrypt(password, { scrypt: { N: 16384 } }), {
      mode: 0o600,
    })
    const signer = await unlockLocalDeploymentWallet(keystore, wallet.address, async () => password)
    for (let index = 0; index < 5; index++) {
      const sent = await sendNextLocalDeployment(context, (transaction) =>
        signer.signTransaction(transaction),
      )
      assert.equal(sent.index, index)
      assert.equal(sends, index + 1)
      const restored = await inspectLocalDeployment({ ...context })
      assert.equal(restored.next?.index ?? null, index === 4 ? null : index + 1)
    }
    const entries = await readLocalCreateIntents(context.journal)
    const result = await verifyStocksDeploymentEvidence(
      {
        plan: context.plan,
        expectedPlanDigest: context.approval.expectedPlanDigest,
        abiDigest: "a".repeat(64),
        transactionHashes: entries.map((e) => e.transactionHash),
      },
      hre.artifacts,
      context.rpc,
    )
    assert.equal(result.manifest.signerAddress, (context.plan as any).input.operator)
    await assert.rejects(() => sendNextLocalDeployment(context, sign), /ALREADY_COMPLETE/)
    assert.equal(sends, 5)
    for (const name of await readdir(context.journal)) {
      const text = await readFile(path.join(context.journal, name), "utf8")
      assert.ok(
        !text.includes(password) &&
          !text.includes(wallet.privateKey) &&
          !text.includes("signedTransaction"),
      )
      assert.ok(text.length < 1024)
    }
  })

  it("keystore errors, wrong identity, symlinks, permissions and excessive KDF fail with no secret in errors", async () => {
    const password = randomUUID(),
      file = path.join(root, "test-wallet.json")
    const encrypted = await wallet.encrypt(password, { scrypt: { N: 16384 } })
    await writeFile(file, encrypted, { mode: 0o600 })
    const reject = async (candidate: string, address = wallet.address, pass = password) =>
      assert.rejects(
        () => unlockLocalDeploymentWallet(candidate, address, async () => pass),
        (error: any) => error.message === "LOCAL_DEPLOYMENT_KEYSTORE_UNAVAILABLE",
      )
    await reject(file, wallet.address, randomUUID())
    await reject(file, Wallet.createRandom().address)
    await chmod(file, 0o644)
    await reject(file)
    await chmod(file, 0o600)
    await symlink(file, path.join(root, "link.json"))
    await reject(path.join(root, "link.json"))
    const changed = JSON.parse(encrypted)
    changed.crypto.kdfparams.n = 2 ** 30
    await writeFile(file, JSON.stringify(changed))
    let prompted = false
    await assert.rejects(() =>
      unlockLocalDeploymentWallet(file, wallet.address, async () => {
        prompted = true
        return password
      }),
    )
    assert.equal(prompted, false)
  })

  it("rejects modified plan, approval, chain, genesis, nonce, fees and insufficient balance before signing", async () => {
    const plan = structuredClone(context.plan) as any
    plan.steps[0].transaction.value = "0x1"
    const variants: LocalDeploymentContext[] = [
      { ...context, plan },
      { ...context, expectedDeployer: Wallet.createRandom().address },
      { ...context, approval: { ...context.approval, expectedPlanDigest: "a".repeat(64) } },
      { ...context, approval: { ...context.approval, genesisHash: "0x" + "1".repeat(64) } },
      { ...context, approval: { ...context.approval, maxGas: "1" } },
      { ...context, approval: { ...context.approval, maxFeePerGas: "1000000000" } },
      { ...context, approval: { ...context.approval, maxTotalFeeWei: "1" } },
      ...[
        ["eth_chainId", "0x1"],
        ["eth_getTransactionCount", "0x1"],
        ["eth_getBalance", "0x0"],
        ["eth_getCode", "0x6000"],
      ].map(([method, result]) => ({
        ...context,
        rpc: (m: string, p: unknown[]) =>
          m === method ? Promise.resolve(result) : context.rpc(m, p),
      })),
    ]
    let signatures = 0
    for (const candidate of variants)
      await assert.rejects(() =>
        sendNextLocalDeployment(candidate, async (tx) => {
          signatures++
          return sign(tx)
        }),
      )
    assert.equal(signatures, 0)
    assert.equal(sends, 0)
    assert.deepEqual(await readLocalCreateIntents(context.journal), [])
  })

  it("refreshes nonce and original signed gas cost after the signing delay", async () => {
    let signed = false
    const changedNonce = {
      ...context,
      rpc: (m: string, p: unknown[]) =>
        signed && m === "eth_getTransactionCount" ? Promise.resolve("0x1") : context.rpc(m, p),
    }
    await assert.rejects(() =>
      sendNextLocalDeployment(changedNonce, async (tx) => {
        signed = true
        return sign(tx)
      }),
    )
    signed = false
    let originalCost = 0n
    const changedBalance = {
      ...context,
      rpc: async (m: string, p: unknown[]) => {
        if (signed && m === "eth_getBalance") return `0x${(originalCost - 1n).toString(16)}`
        const result = await context.rpc(m, p)
        return signed && m === "eth_estimateGas"
          ? `0x${(BigInt(result as string) / 2n).toString(16)}`
          : result
      },
    }
    await assert.rejects(
      () =>
        sendNextLocalDeployment(changedBalance, async (tx) => {
          originalCost = BigInt(tx.gasLimit as string) * BigInt(tx.maxFeePerGas as string)
          signed = true
          return sign(tx)
        }),
      /GAS_BALANCE/,
    )
    assert.equal(sends, 0)
    assert.deepEqual(await readLocalCreateIntents(context.journal), [])
  })

  it("rejects signer-altered gas or price despite values being below the approved ceilings", async () => {
    for (const change of [
      { gasLimit: "3000000" },
      { maxPriorityFeePerGas: "1" },
      { maxFeePerGas: "2000000000" },
    ]) {
      await assert.rejects(
        () => sendNextLocalDeployment(context, (tx) => sign({ ...tx, ...change })),
        /SIGNED_PRICING_CHANGED/,
      )
    }
    assert.equal(sends, 0)
  })

  it("checks the actual signed gas against a lower block gas limit even when estimates decrease", async () => {
    let signed = false,
      signedGas = 0n
    const changed = {
      ...context,
      rpc: async (m: string, p: unknown[]) => {
        const value: any = await context.rpc(m, p)
        if (signed && m === "eth_estimateGas") return `0x${(BigInt(value) / 2n).toString(16)}`
        if (signed && m === "eth_getBlockByNumber" && p[0] === "latest")
          return { ...value, gasLimit: `0x${(signedGas - 1n).toString(16)}` }
        return value
      },
    }
    await assert.rejects(
      () =>
        sendNextLocalDeployment(changed, async (tx) => {
          signedGas = BigInt(tx.gasLimit as string)
          signed = true
          return sign(tx)
        }),
      /GAS_LIMIT/,
    )
    assert.equal(sends, 0)
    assert.deepEqual(await readLocalCreateIntents(context.journal), [])
  })

  it("exclusive durable intent permits only one broadcast under concurrent execution", async () => {
    let arrived = 0,
      release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const signing = async (tx: any) => {
      const raw = await sign(tx)
      if (++arrived === 2) release()
      await barrier
      return raw
    }
    const outcomes = await Promise.allSettled([
      sendNextLocalDeployment(context, signing),
      sendNextLocalDeployment(context, signing),
    ])
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1)
    assert.equal(sends, 1)
    assert.equal((await readLocalCreateIntents(context.journal)).length, 1)
  })

  it("journal write failure prevents broadcast and incomplete intent cannot be repaired implicitly", async () => {
    await assert.rejects(
      () =>
        sendNextLocalDeployment(context, async (tx) => {
          await writeFile(path.join(context.journal, "step-0.json"), "{", { mode: 0o600 })
          return sign(tx)
        }),
      /JOURNAL_INVALID/,
    )
    assert.equal(sends, 0)
    await assert.rejects(() => inspectLocalDeployment(context), /JOURNAL_INVALID/)
  })

  it("crash after durable intent but before send stays unresolved and never signs or sends again", async () => {
    let attempts = 0
    const stopped = {
      ...context,
      rpc: (m: string, p: unknown[]) => {
        if (m === "eth_sendRawTransaction") {
          attempts++
          return Promise.reject(Error("test process interruption"))
        }
        return context.rpc(m, p)
      },
    }
    await assert.rejects(() => sendNextLocalDeployment(stopped, sign), /BROADCAST_UNCERTAIN/)
    assert.equal(attempts, 1)
    assert.equal(sends, 0)
    let signedAgain = false
    await assert.rejects(
      () =>
        sendNextLocalDeployment(context, async (tx) => {
          signedAgain = true
          return sign(tx)
        }),
      /ORIGINAL_UNRESOLVED/,
    )
    assert.equal(signedAgain, false)
    const [entry] = await readLocalCreateIntents(context.journal)
    await assert.rejects(() => persistLocalCreateIntent(context.journal, entry), /JOURNAL_INVALID/)
  })

  it("a fresh child process recovers an accepted transaction after its response was lost without sending", async () => {
    const lost = {
      ...context,
      rpc: async (m: string, p: unknown[]) => {
        const result = await context.rpc(m, p)
        if (m === "eth_sendRawTransaction") throw Error("test dropped response")
        return result
      },
    }
    await assert.rejects(() => sendNextLocalDeployment(lost, sign), /BROADCAST_UNCERTAIN/)
    assert.equal(sends, 1)
    const input = path.join(root, "public-context.json")
    await writeFile(
      input,
      JSON.stringify({
        plan: context.plan,
        approval: context.approval,
        expectedDeployer: context.expectedDeployer,
        journal: context.journal,
      }),
    )
    let childWrites = 0
    const server = createServer(async (request, response) => {
      try {
        let body = ""
        for await (const part of request) body += part.toString()
        const message = JSON.parse(body)
        if (/send|sign/.test(message.method)) {
          childWrites++
          throw Error()
        }
        const result = await direct(message.method, message.params)
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
      } catch {
        response.statusCode = 500
        response.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as any).port
      const child = spawn(
        process.execPath,
        [
          "-r",
          "ts-node/register",
          "test/stocks/local-recovery-child.ts",
          input,
          `http://127.0.0.1:${port}`,
        ],
        { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
      )
      let stdout = "",
        stderr = ""
      child.stdout.on("data", (data) => {
        stdout += data
      })
      child.stderr.on("data", (data) => {
        stderr += data
      })
      const code = await new Promise((resolve) => child.on("close", resolve))
      assert.equal(code, 0, stderr)
      assert.deepEqual(JSON.parse(stdout), { next: 1, count: 1 })
      assert.equal(childWrites, 0)
      assert.equal(sends, 1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("recovery rejects changed receipt, missing canonical inclusion, runtime and finality before later signing", async () => {
    await sendNextLocalDeployment(context, sign)
    for (const mutate of [
      (m: string, _p: unknown[], v: any) =>
        m === "eth_getTransactionReceipt" ? { ...v, status: "0x0" } : v,
      (m: string, _p: unknown[], v: any) =>
        m === "eth_getTransactionByHash" ? { ...v, nonce: "0x8" } : v,
      (m: string, p: unknown[], v: any) =>
        m === "eth_getBlockByNumber" && p[0] === "0x1" ? { ...v, transactions: [] } : v,
      (m: string, _p: unknown[], v: any) => (m === "eth_getCode" ? "0x6000" : v),
      (m: string, p: unknown[], v: any) =>
        m === "eth_getBlockByNumber" && p[0] === "finalized" ? { ...v, number: "0x0" } : v,
    ]) {
      await assert.rejects(() =>
        inspectLocalDeployment({
          ...context,
          rpc: async (m, p) => mutate(m, p, await context.rpc(m, p)),
        }),
      )
    }
    assert.equal(sends, 1)
  })
})
