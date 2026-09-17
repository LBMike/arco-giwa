// Self-tests of the TEST-ONLY in-process Stocks harness. They drive only real HTTP routes (app.inject), the fake
// chain and the fake EIP-1193 wallet. No browser controller, socket, database, public network, key or signature.

import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { getAddress } from "viem"

import { createStocksHostSession } from "../../stocks-host/session"
import { parsePortfolio } from "../../stocks-investor/validate"
import { planOrder } from "../../stocks-wallet/planner"
import type { Side } from "../../stocks-wallet/types"
import { createStocksExecutionReads } from "../../stocks-wallet-http/reads"
import { createSubmissionGate } from "../../stocks-wallet-submissions/client"
import { createFakeEip1193Wallet, providerError } from "./fake-wallet"
import { createInProcessStocks, type InProcessStocks } from "./in-process-stocks"
import { createMemorySql } from "./memory-sql"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL("../../../../../", import.meta.url))
const WALLET = getAddress("0x00000000000000000000000000000000000abc01")
const OTHER = getAddress("0x00000000000000000000000000000000000abc02")
const QUANTITY = 1_000_000_000n
const CASH = 120_000_000n

async function serverContracts() {
  const module = (await import(`${repo}server/src/stocks-submissions/contracts.ts`)) as AnyModule
  return { deriveOrder: module.deriveOrder, digest: module.digest }
}

async function harness(side: Side) {
  const h = await createInProcessStocks()
  if (side === "SELL") h.seedStock(WALLET, QUANTITY)
  else h.seedCash(WALLET, CASH)
  const session = h.session(WALLET)
  const created = await h.createOrder(side, session)
  const { deriveOrder, digest } = await serverContracts()
  const plan = deriveOrder(h.manifest, created.order, side)
  const call = async (method: string, path: string, body?: unknown, token = session.accessToken) => {
    const response = await h.fetch(`${h.apiBase}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, json: (await response.json()) as Json }
  }
  const claimBody = (stage: "APPROVAL" | "TRANSFER") => {
    const transaction = stage === "APPROVAL" ? plan.approval : plan.transfer
    // Exactly the body stocks-wallet-submissions/client.ts sends.
    return { side, orderId: created.order.id, intentKey: plan.intentKey, stage, transactionDigest: digest(transaction), transaction, deploymentDigest: h.digest }
  }
  const send = (wallet: ReturnType<typeof createFakeEip1193Wallet>, stage: "APPROVAL" | "TRANSFER") => {
    const tx = stage === "APPROVAL" ? plan.approval : plan.transfer
    return wallet.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: "0x0" }] }) as Promise<string>
  }
  const outcome = (claim: Json, status: string, txHash: string) => call("POST", "/api/v1/stocks/wallet-submissions/outcomes", { claimId: claim.claimId, intentKey: claim.intentKey, stage: claim.stage, transactionDigest: claim.transactionDigest, status, txHash })
  const reconcile = (claim: Json, txHash: string) => call("POST", "/api/v1/stocks/wallet-submissions/reconcile", { claimId: claim.claimId, intentKey: claim.intentKey, stage: claim.stage, transactionDigest: claim.transactionDigest, txHash })
  return { h, session, order: created.order, plan, call, claimBody, send, outcome, reconcile }
}

async function closing<T>(h: InProcessStocks, work: () => Promise<T>) {
  try {
    return await work()
  } finally {
    await h.close()
  }
}

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: real routes carry an order from claim through approval and ${side === "BUY" ? "deposit" : "escrow"} to server-verified CONFIRMED`, async () => {
    const t = await harness(side)
    await closing(t.h, async () => {
      assert.equal(t.order.state, side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW")
      assert.equal(t.order.side, side === "SELL" ? "SELL" : undefined)

      const deployment = await t.call("GET", "/api/v1/stocks/execution/deployment")
      assert.equal(deployment.status, 200)
      assert.equal(deployment.json.data.status, "VERIFIED")
      assert.equal(deployment.json.data.manifestDigest, t.h.digest)
      assert.ok(deployment.json.data.validUntil - deployment.json.data.verifiedAt <= 15_000)

      const policy = await t.call("GET", `/api/v1/stocks/execution/${side}/${t.order.id}`)
      assert.deepEqual([policy.status, policy.json.data.allowed, policy.json.data.side, policy.json.data.orderId], [200, true, side, t.order.id])

      const inspected = await t.call("GET", `/api/v1/stocks/wallet-submissions/${side}/${t.order.id}`)
      assert.deepEqual(inspected.json.data, { intentKey: t.plan.intentKey, approval: null, transfer: null })

      const approval = await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("APPROVAL"))
      assert.deepEqual([approval.status, approval.json.data.status, approval.json.data.stage], [200, "REQUEST_MAY_START", "APPROVAL"])
      const repeated = await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("APPROVAL"))
      assert.deepEqual([repeated.status, repeated.json.data], [200, null])
      const early = await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("TRANSFER"))
      assert.deepEqual([early.status, early.json.error], [409, "SUBMISSION_STAGE_BLOCKED"])

      const wallet = createFakeEip1193Wallet(t.h.chain, { account: WALLET })
      const approvalHash = await t.send(wallet, "APPROVAL")
      assert.match(approvalHash, /^0x[0-9a-f]{64}$/)
      const token = side === "BUY" ? t.h.manifest.cashToken : t.h.manifest.stockToken
      const spender = side === "BUY" ? t.h.manifest.fundingVault : t.h.manifest.redemptionEscrow
      assert.equal(t.h.chain.allowance(token, WALLET, spender), side === "BUY" ? CASH : QUANTITY)

      const submitted = await t.outcome(approval.json.data, "SUBMITTED", approvalHash)
      assert.deepEqual([submitted.status, submitted.json.data.status, submitted.json.data.txHash], [200, "SUBMITTED", approvalHash])
      const confirmed = await t.reconcile(approval.json.data, approvalHash)
      assert.deepEqual([confirmed.status, confirmed.json.data.status], [200, "CONFIRMED"])
      const forged = await t.outcome(approval.json.data, "CONFIRMED", approvalHash)
      assert.deepEqual([forged.status, forged.json.error], [409, "RECEIPT_VERIFICATION_REQUIRED"])

      const transfer = await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("TRANSFER"))
      assert.deepEqual([transfer.status, transfer.json.data.status, transfer.json.data.stage], [200, "REQUEST_MAY_START", "TRANSFER"])
      const transferHash = await t.send(wallet, "TRANSFER")
      assert.equal((await t.outcome(transfer.json.data, "SUBMITTED", transferHash)).json.data.status, "SUBMITTED")
      const settled = await t.reconcile(transfer.json.data, transferHash)
      assert.deepEqual([settled.status, settled.json.data.status], [200, "CONFIRMED"])

      assert.equal(t.h.chain.balanceOf(token, spender), side === "BUY" ? CASH : QUANTITY)
      assert.equal(t.h.chain.balanceOf(token, WALLET), 0n)
      assert.equal(wallet.callsOf("eth_sendTransaction").length, 2)
      const final = await t.call("GET", `/api/v1/stocks/wallet-submissions/${side}/${t.order.id}`)
      assert.deepEqual([final.json.data.approval.status, final.json.data.transfer.status, final.json.data.transfer.txHash], ["CONFIRMED", "CONFIRMED", transferHash])
      const proofs = t.h.sql.snapshot().StocksWalletSubmissionProof
      assert.deepEqual(proofs.map((row) => [row.status, row.txHash]), [["CONFIRMED", approvalHash], ["CONFIRMED", transferHash]])
    })
  })
}

test("pending finality keeps reconcile SUBMITTED until the receipt block is finalized", async () => {
  const t = await harness("BUY")
  await closing(t.h, async () => {
    const claim = (await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("APPROVAL"))).json.data
    t.h.chain.setFinalizeImmediately(false)
    const hash = await t.send(createFakeEip1193Wallet(t.h.chain, { account: WALLET }), "APPROVAL")
    await t.outcome(claim, "SUBMITTED", hash)
    assert.ok(t.h.chain.finalizedBlock < t.h.chain.latestBlock)
    const pending = await t.reconcile(claim, hash)
    assert.deepEqual([pending.status, pending.json.data.status], [200, "SUBMITTED"])
    assert.equal(t.h.sql.snapshot().StocksWalletSubmissionProof.length, 0)
    t.h.chain.finalize()
    assert.equal((await t.reconcile(claim, hash)).json.data.status, "CONFIRMED")
  })
})

test("a reverted approval reconciles to REVERTED and keeps the transfer stage blocked", async () => {
  const t = await harness("SELL")
  await closing(t.h, async () => {
    const claim = (await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("APPROVAL"))).json.data
    t.h.chain.revertNextTransaction()
    const hash = await t.send(createFakeEip1193Wallet(t.h.chain, { account: WALLET }), "APPROVAL")
    assert.equal(t.h.chain.transactions[t.h.chain.transactions.length - 1]?.status, "reverted")
    await t.outcome(claim, "SUBMITTED", hash)
    assert.equal((await t.reconcile(claim, hash)).json.data.status, "REVERTED")
    const blocked = await t.call("POST", "/api/v1/stocks/wallet-submissions/claims", t.claimBody("TRANSFER"))
    assert.deepEqual([blocked.status, blocked.json.error], [409, "SUBMISSION_STAGE_BLOCKED"])
  })
})

test("a transfer without an approval allowance is mined as a revert with no logs", async () => {
  const t = await harness("BUY")
  await closing(t.h, async () => {
    const hash = await t.send(createFakeEip1193Wallet(t.h.chain, { account: WALLET }), "TRANSFER")
    const receipt = (await t.h.chain.rpc("eth_getTransactionReceipt", [hash])) as Json
    assert.deepEqual([receipt.status, receipt.logs], ["0x0", []])
    assert.equal(t.h.chain.balanceOf(t.h.manifest.cashToken, WALLET), CASH)
  })
})

test("another wallet's token cannot see, check or claim the order", async () => {
  const t = await harness("BUY")
  await closing(t.h, async () => {
    const other = t.h.session(OTHER).accessToken
    assert.equal((await t.call("GET", `/api/v1/stocks/orders/${t.order.id}`, undefined, other)).status, 404)
    assert.equal((await t.call("GET", `/api/v1/stocks/execution/BUY/${t.order.id}`, undefined, other)).status, 404)
    assert.equal((await t.call("GET", `/api/v1/stocks/wallet-submissions/BUY/${t.order.id}`, undefined, other)).status, 404)
    assert.equal((await t.call("GET", `/api/v1/stocks/orders/${t.order.id}`, undefined, "forged.token.value")).status, 401)
  })
})

test("fetch forwards method, headers and body, records requests, and honours an aborted signal", async () => {
  const t = await harness("BUY")
  await closing(t.h, async () => {
    const quotes = t.h.requests.filter((entry) => entry.path === "/api/v1/stocks/quotes")
    assert.equal(quotes.length, 1)
    assert.deepEqual([quotes[0]!.method, quotes[0]!.status, quotes[0]!.authorization], ["POST", 200, true])
    assert.deepEqual(JSON.parse(quotes[0]!.body!), { symbol: "NVDA", quantity: "1" })
    t.h.clearRequests()
    const extra = await t.call("POST", "/api/v1/stocks/quotes", { symbol: "NVDA", quantity: "1", extra: true })
    assert.deepEqual([extra.status, extra.json.error], [400, "UNEXPECTED_FIELDS"], "the server saw the forwarded body")
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(t.h.fetch(`${t.h.apiBase}/api/v1/stocks/catalog`, { signal: controller.signal }), (error: Error) => error.name === "AbortError")
    await assert.rejects(t.h.fetch("https://elsewhere.test/api/v1/stocks/catalog"), /HARNESS_ORIGIN_MISMATCH/)
    assert.equal(t.h.requests.length, 1)
  })
})

test("observer emulation, pause and evidence availability change the real route answers", async () => {
  const t = await harness("SELL")
  await closing(t.h, async () => {
    t.h.setPaused(true)
    assert.deepEqual([(await t.call("GET", `/api/v1/stocks/execution/SELL/${t.order.id}`)).json.error], ["STOCKS_PAUSED"])
    assert.equal((await t.call("GET", "/api/v1/stocks/execution/deployment")).status, 200, "pause does not revoke deployment evidence")
    t.h.setPaused(false)
    t.h.setEvidenceAvailable(false)
    const unavailable = await t.call("GET", "/api/v1/stocks/execution/deployment")
    assert.deepEqual([unavailable.status, unavailable.json.error], [503, "EXECUTION_UNAVAILABLE"])
    t.h.setEvidenceAvailable(true)
    const moved = await t.h.setOrderState("SELL", t.order.id as string, "ESCROW_HELD")
    assert.deepEqual([moved.state, moved.version], ["ESCROW_HELD", 1])
    const denied = await t.call("GET", `/api/v1/stocks/execution/SELL/${t.order.id}`)
    assert.deepEqual([denied.status, denied.json.error], [409, "ORDER_NOT_PAYABLE"])
    await assert.rejects(t.h.setOrderState("SELL", t.order.id as string, "NOT_A_STATE"), /violates check constraint/)
    assert.equal((await t.call("GET", `/api/v1/stocks/sell-orders/${t.order.id}`)).json.data.state, "ESCROW_HELD", "a failed transition rolled back")
  })
})

test("portfolio route returns holdings and pending orders the investor parser accepts", async () => {
  const t = await harness("SELL")
  await closing(t.h, async () => {
    const portfolio = await t.call("GET", "/api/v1/stocks/portfolio")
    assert.equal(portfolio.status, 200)
    const parsed = parsePortfolio(portfolio.json.data)
    assert.equal(parsed.holdings.length, 1)
    assert.deepEqual([parsed.holdings[0]!.walletQuantity, parsed.holdings[0]!.reservedQuantity, parsed.holdings[0]!.availableQuantity], ["1000000000", "1000000000", "0"])
    assert.deepEqual(portfolio.json.data.pending.map((row: Json) => [row.id, row.side, row.state]), [[t.order.id, "SELL", "AWAITING_ESCROW"]])
    const insufficient = await t.call("POST", "/api/v1/stocks/sell-orders", { quoteId: (await t.call("POST", "/api/v1/stocks/sell-quotes", { symbol: "NVDA", quantity: "1" })).json.data.id, idempotencyKey: "harness-insufficient-1" })
    assert.deepEqual([insufficient.status, insufficient.json.error], [409, "INSUFFICIENT_AVAILABLE_STOCK"])
  })
})

test("browser submission client and execution reads interoperate with the real server DTOs", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const t = await harness(side)
    await closing(t.h, async () => {
      const reads = createStocksExecutionReads({ apiBase: t.h.apiBase, fetch: t.h.fetch })
      const signal = new AbortController().signal
      const request = { apiBase: t.h.apiBase, token: t.session.accessToken, sessionId: t.session.id, side, orderId: t.order.id as string, deploymentDigest: t.h.digest, signal }
      const lease = await reads.readDeployment({ apiBase: t.h.apiBase, token: t.session.accessToken, sessionId: t.session.id, signal, deploymentDigest: t.h.digest })
      assert.ok(reads.currentDeployment(lease))
      assert.equal((await reads.readExecutionPolicy(request)).allowed, true)
      const order = (await reads.readOrder(request)) as Json
      assert.equal(order.data.id, t.order.id)
      assert.equal(((await reads.readCatalog(request)) as Json).deploymentId, t.h.manifest.deploymentId)

      const context = { session: t.session, walletAddress: WALLET, chainId: 91342, walletEpoch: "harness:1", apiBase: t.h.apiBase, deployment: lease.deployment }
      const plan = planOrder({ side, order: order.data }, context, Date.now())
      assert.deepEqual([plan.intentKey, plan.approval, plan.transfer], [t.plan.intentKey, t.plan.approval, t.plan.transfer], "browser plan equals server derivation")

      const rejected: string[] = []
      const gate = createSubmissionGate({ session: t.session, side, orderId: t.order.id as string, deploymentDigest: t.h.digest, apiBase: t.h.apiBase, fetch: t.h.fetch, onSessionRejected: (id) => rejected.push(id) })
      assert.deepEqual(await gate.inspect(plan.intentKey), { approval: null, transfer: null })
      const approvalDigest = (await serverContracts()).digest(plan.approval)
      const claim = await gate.claim({ intentKey: plan.intentKey, stage: "APPROVAL", transactionDigest: approvalDigest, transaction: plan.approval, orderId: t.order.id as string, deploymentDigest: t.h.digest })
      assert.equal(claim?.status, "REQUEST_MAY_START")
      const hash = (await t.send(createFakeEip1193Wallet(t.h.chain, { account: WALLET }), "APPROVAL")) as `0x${string}`
      await gate.record({ ...claim!, status: "SUBMITTED", txHash: hash })
      const confirmed = await gate.reconcile!({ claimId: claim!.claimId, intentKey: claim!.intentKey, stage: "APPROVAL", transactionDigest: claim!.transactionDigest, txHash: hash })
      assert.equal(confirmed.status, "CONFIRMED")
      assert.equal((await gate.inspect(plan.intentKey)).approval?.status, "CONFIRMED")
      assert.deepEqual(rejected, [])
    })
  }
})

test("the host session signs in through the fixture auth routes and its token is accepted by the real resolver", async () => {
  const h = await createInProcessStocks()
  await closing(h, async () => {
    const dependencies = h.signInDependencies()
    const host = createStocksHostSession({ walletAddress: WALLET, chainId: 91342, frontendOrigin: h.frontendOrigin, apiBase: h.apiBase }, dependencies)
    try {
      const session = await host.signIn()
      assert.ok(session)
      assert.equal(dependencies.messages.length, 1)
      const response = await h.fetch(`${h.apiBase}/api/v1/stocks/orders`, { headers: { authorization: `Bearer ${session.accessToken}` } })
      assert.equal(response.status, 200)
    } finally {
      host.dispose()
    }
  })
})

test("memory SQL: a failed statement aborts the transaction and ROLLBACK restores every table", async () => {
  const sql = createMemorySql()
  const digest = "a".repeat(64)
  await sql.pool.query('INSERT INTO arco_evm."StocksLiquidityBinding" ("scopeKey","deploymentDigest") VALUES($1,$2) ON CONFLICT DO NOTHING', ["scope-1", digest])
  const before = sql.snapshot()
  const client = await sql.pool.connect()
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
  await client.query('INSERT INTO arco_evm."StocksAudit" (id,subject,action,detail,"deploymentDigest") VALUES ($1,$2,$3,$4,$5)', ["audit-1", "subject", "ACTION", "{}", digest])
  const enroll = 'INSERT INTO arco_evm."StocksWalletSubmissionEnrollment" (side,"orderId","intentKey","actorId",wallet,"deploymentDigest","orderBinding") VALUES($1,$2,$3,$4,$5,$6,$7)'
  const values = ["BUY", "order-1", "b".repeat(64), "actor", "0x" + "1".repeat(40), digest, "c".repeat(64)]
  await client.query(enroll, values)
  await assert.rejects(client.query(enroll, values), /duplicate key value violates unique constraint/)
  await assert.rejects(client.query('SELECT "deploymentDigest" FROM arco_evm."StocksLiquidityBinding" WHERE "scopeKey"=$1', ["scope-1"]), /current transaction is aborted/)
  await client.query("ROLLBACK")
  client.release()
  assert.deepEqual(sql.snapshot(), before)

  // A trigger safety net: terminal status needs a proof row; hash and status never regress.
  const writer = await sql.pool.connect()
  await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED")
  await writer.query(enroll, values)
  const claim = await writer.query(`INSERT INTO arco_evm."StocksWalletSubmission" ("claimId","intentKey",stage,"transactionDigest",transaction,"actorId",wallet,side,"orderId","deploymentDigest",status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUEST_MAY_START') ON CONFLICT("intentKey",stage) DO NOTHING RETURNING *`, ["claim-1", "b".repeat(64), "APPROVAL", "d".repeat(64), JSON.stringify({ chainId: 91342 }), "actor", "0x" + "1".repeat(40), "BUY", "order-1", digest])
  assert.deepEqual(claim.rows[0]!.transaction, { chainId: 91342 }, "JSONB is returned parsed")
  assert.ok(claim.rows[0]!.createdAt instanceof Date)
  await writer.query("COMMIT")
  writer.release()
  const update = 'UPDATE arco_evm."StocksWalletSubmission" SET status=$2,"txHash"=$3,"updatedAt"=clock_timestamp() WHERE "claimId"=$1 RETURNING *'
  const hash = `0x${"e".repeat(64)}`
  await sql.pool.query(update, ["claim-1", "SUBMITTED", hash])
  await assert.rejects(sql.pool.query(update, ["claim-1", "UNKNOWN", hash]), /SUBMISSION_STATUS_REGRESSION/)
  await assert.rejects(sql.pool.query(update, ["claim-1", "SUBMITTED", `0x${"f".repeat(64)}`]), /SUBMISSION_HASH_IMMUTABLE/)
  await assert.rejects(sql.pool.query(update, ["claim-1", "CONFIRMED", hash]), /SUBMISSION_TRUSTED_PROOF_REQUIRED/)
  assert.equal(sql.snapshot().StocksWalletSubmission[0]!.status, "SUBMITTED")
  const conflict = await sql.pool.query(`INSERT INTO arco_evm."StocksWalletSubmission" ("claimId","intentKey",stage,"transactionDigest",transaction,"actorId",wallet,side,"orderId","deploymentDigest",status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUEST_MAY_START') ON CONFLICT("intentKey",stage) DO NOTHING RETURNING *`, ["claim-2", "b".repeat(64), "APPROVAL", "d".repeat(64), "{}", "alias", "0x" + "1".repeat(40), "BUY", "order-1", digest])
  assert.deepEqual(conflict.rows, [], "UNIQUE(intentKey, stage) is DO NOTHING")

  const reader = await sql.pool.connect()
  await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
  await assert.rejects(reader.query('INSERT INTO arco_evm."StocksAudit" (id,subject,action,detail,"deploymentDigest") VALUES ($1,$2,$3,$4,$5)', ["audit-2", "s", "A", "{}", digest]), /read-only transaction/)
  await reader.query("ROLLBACK")
  reader.release()
})

test("memory SQL: unsupported statements throw instead of returning rows", async () => {
  const sql = createMemorySql()
  await assert.rejects(sql.pool.query("SELECT 1"), /^Error: UNSUPPORTED_SQL: SELECT 1$/)
  await assert.rejects(sql.pool.query('SELECT * FROM arco_evm."StocksWalletSubmissionProof"'), /UNSUPPORTED_SQL: SELECT \* FROM arco_evm."StocksWalletSubmissionProof"/)
  const client = await sql.pool.connect()
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
  await assert.rejects(client.query("DELETE FROM arco_evm.\"StocksOrder\""), /UNSUPPORTED_SQL/)
  await client.query("ROLLBACK")
  client.release()
})

test("memory SQL: transactions are serialized", async () => {
  const sql = createMemorySql()
  const order: string[] = []
  const first = await sql.pool.connect()
  await first.query("BEGIN ISOLATION LEVEL READ COMMITTED")
  const second = (async () => {
    const client = await sql.pool.connect()
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    order.push("second")
    await client.query("COMMIT")
    client.release()
  })()
  await new Promise((resolve) => setTimeout(resolve, 10))
  order.push("first")
  await first.query("COMMIT")
  first.release()
  await second
  assert.deepEqual(order, ["first", "second"])
})

test("fake wallet: supported methods, network views, scripted answers, holds and events", async () => {
  const h = await createInProcessStocks()
  await closing(h, async () => {
    h.seedCash(WALLET, CASH)
    const wallet = createFakeEip1193Wallet(h.chain, { account: WALLET })
    assert.equal(await wallet.request({ method: "eth_chainId" }), "0x164ce")
    assert.deepEqual(await wallet.request({ method: "eth_accounts" }), [WALLET])
    assert.equal(((await wallet.request({ method: "eth_getBlockByNumber", params: ["0x1", false] })) as Json).hash, h.manifest.checkpointHash)
    for (const method of ["wallet_sendTransaction", "eth_sendRawTransaction", "eth_requestAccounts", "wallet_switchEthereumChain", "eth_estimateGas"]) {
      await assert.rejects(wallet.request({ method, params: [] }), (error: Json) => error.code === 4200)
    }
    assert.equal(wallet.calls.filter((call) => call.method === "wallet_sendTransaction").length, 1, "unsupported calls are recorded")
    const approve = { from: OTHER, to: h.manifest.cashToken, data: "0x", value: "0x0" }
    await assert.rejects(wallet.request({ method: "eth_sendTransaction", params: [approve] }), (error: Json) => error.code === 4100)

    wallet.failNext("eth_chainId", providerError(-32603, "internal"))
    await assert.rejects(wallet.request({ method: "eth_chainId" }), (error: Json) => error.code === -32603)
    wallet.answerNext("eth_chainId", "0x164CE")
    assert.equal(await wallet.request({ method: "eth_chainId" }), "0x164CE")

    const events: string[] = []
    const listener = (value: unknown) => events.push(JSON.stringify(value))
    wallet.on("chainChanged", listener)
    wallet.on("accountsChanged", listener)
    assert.equal(wallet.listenerCount("chainChanged"), 1)
    wallet.setNetwork("other-checkpoint")
    assert.notEqual(((await wallet.request({ method: "eth_getBlockByNumber", params: ["0x1", false] })) as Json).hash, h.manifest.checkpointHash)
    wallet.setNetwork("missing-checkpoint")
    assert.equal(await wallet.request({ method: "eth_getBlockByNumber", params: ["0x1", false] }), null)
    wallet.setNetwork("other-chain")
    assert.equal(await wallet.request({ method: "eth_chainId" }), "0x1")
    const { deriveOrder } = await serverContracts()
    const t = await harness("BUY")
    await closing(t.h, async () => {
      const foreign = createFakeEip1193Wallet(t.h.chain, { account: WALLET, network: "other-chain" })
      const foreignHash = await t.send(foreign, "APPROVAL")
      assert.equal(await t.h.chain.rpc("eth_getTransactionReceipt", [foreignHash]), null, "another network's transaction never reaches the reviewed chain")
      assert.equal(t.h.chain.foreignTransactions.length, 1)
    })
    wallet.setNetwork("reviewed")
    wallet.setAccount(OTHER)
    wallet.removeListener("chainChanged", listener)
    assert.equal(wallet.listenerCount("chainChanged"), 0)
    assert.deepEqual(events, ['"0x164ce"', '"0x164ce"', '"0x1"', '"0x164ce"', `["${OTHER}"]`])
    wallet.setAccount(WALLET)

    // A held eth_sendTransaction is applied only on release; a hook runs synchronously before the answer.
    const quote = await h.createOrder("BUY", h.session(WALLET))
    const plan = deriveOrder(h.manifest, quote.order, "BUY")
    const hooked: string[] = []
    const unhook = wallet.onCall("eth_sendTransaction", (call) => hooked.push(call.method))
    const hold = wallet.holdNext("eth_sendTransaction")
    const pending = wallet.request({ method: "eth_sendTransaction", params: [{ from: WALLET, to: plan.approval.to, data: plan.approval.data, value: "0x0" }] })
    assert.deepEqual(hooked, ["eth_sendTransaction"], "recorded and hooked synchronously")
    await hold.arrived
    const blocks = h.chain.latestBlock
    assert.equal(h.chain.latestBlock, blocks)
    hold.release()
    const hash = (await pending) as string
    assert.equal(h.chain.latestBlock, blocks + 1n)
    assert.equal(((await h.chain.rpc("eth_getTransactionReceipt", [hash])) as Json).status, "0x1")
    const custom = wallet.holdNext("eth_sendTransaction")
    const late = wallet.request({ method: "eth_sendTransaction", params: [{ from: WALLET, to: plan.approval.to, data: plan.approval.data, value: "0x0" }] })
    await custom.arrived
    custom.release("0xnot-a-hash")
    assert.equal(await late, "0xnot-a-hash")
    assert.equal(h.chain.latestBlock, blocks + 1n, "a custom release applies nothing")
    unhook()
    wallet.disconnect()
    await assert.rejects(wallet.request({ method: "eth_chainId" }), (error: Json) => error.code === 4900)
  })
})
