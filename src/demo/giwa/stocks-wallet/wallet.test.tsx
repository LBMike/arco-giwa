import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { decodeFunctionData, encodeFunctionData, parseAbi, sha256, toHex, type Abi, type Address, type Hex } from "viem"
import { APPROVAL_ABI, STOCKS_ABI, STOCKS_ABI_DIGEST } from "./abi"
import { assertTransaction, digest, freeze, planOrder } from "./planner"
import { createStocksWalletController } from "./controller"
import type { AttemptRecord, ExecutionContext, ManifestV2, Order, Selection, Side, SubmissionGate, Transaction, WalletPorts } from "./types"

const A = "0x1111111111111111111111111111111111111111" as Address
const B = "0x2222222222222222222222222222222222222222" as Address
const h = (digit: string) => `0x${digit.repeat(64)}` as Hex
const START = Date.UTC(2026, 8, 17)
const PROFILE = { observedAt: new Date(START).toISOString(), profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 120; i++) await Promise.resolve() }
function gate() {
  const data = new Map<string, AttemptRecord>(); let id = 0
  const submissions: SubmissionGate = {
    async inspect(key) { return { approval: data.get(`${key}:APPROVAL`) ?? null, transfer: data.get(`${key}:TRANSFER`) ?? null } },
    async claim(request) {
      const key = `${request.intentKey}:${request.stage}`
      if (data.has(key)) return null
      const claim: AttemptRecord = { claimId: `claim-${++id}`, intentKey: request.intentKey, stage: request.stage, transactionDigest: request.transactionDigest, status: "REQUEST_MAY_START" }
      data.set(key, freeze(claim)); return claim
    },
    async record(value) { assert.equal(data.get(`${value.intentKey}:${value.stage}`)?.claimId, value.claimId); data.set(`${value.intentKey}:${value.stage}`, freeze(value)) },
  }
  return { data, submissions }
}
function fixture(side: Side = "BUY", shared = gate()) {
  const contracts = [3, 4, 5, 6, 7].map(n => `0x${String(n).repeat(40)}` as Address)
  const manifest: ManifestV2 = { schemaVersion: 2, redemptionEscrow: contracts[4]!, deploymentId: "deployment-test-1", profile: "DEMO_TESTNET", chainId: 91342, networkInstance: "local-test-network-1", checkpointNumber: "1", checkpointHash: h("a"), abiDigest: STOCKS_ABI_DIGEST, finalityPolicy: "FINALIZED", cashToken: contracts[0]!, cashSymbol: "ARCO_TEST_USDC", cashScale: 6, stockToken: contracts[1]!, quantityScale: 9, fundingVault: contracts[2]!, mintController: contracts[3]!, signerAddress: "0x8888888888888888888888888888888888888888", codeHashes: Object.fromEntries(contracts.map(a => [a, h("b")])), restrictedTransfers: true, nonUpgradeable: true }
  let context: ExecutionContext = { session: { id: "session-a-1", walletAddress: A, chainId: 91342, accessToken: "fake-test-token", createdAt: START, expiresAt: START + 900000 }, walletAddress: A, chainId: 91342, walletEpoch: "injected:1", apiBase: "https://api.example", deployment: { status: "VERIFIED", evidenceId: "review-1", manifestDigest: digest(manifest), manifest, verifiedAt: START, validUntil: START + 900000 } }
  const order: Order = { id: "order-1", orderKey: sha256(toHex(`${side === "SELL" ? "sell:" : ""}${manifest.networkInstance}:order-1`)), quoteId: "quote-1", actorId: "actor-a", wallet: A, symbol: "NVDA", quantity: "1000000000", cashAmount: "120000000", deploymentId: manifest.deploymentId, deploymentDigest: digest(manifest), quoteExpiresAt: new Date(START + 60000).toISOString(), state: side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW", version: 0, idempotencyKey: "request-1" }
  const selected: Selection = { side, order }
  let time = START, allowance = "0"
  const walletCalls: Transaction[] = [], orderReads: unknown[] = []
  const ports: WalletPorts = {
    context: () => context,
    now: () => time,
    async readWallet() { return { address: context.walletAddress!, chainId: context.chainId!, connectionEpoch: context.walletEpoch, deploymentDigest: context.deployment!.manifestDigest, networkInstance: context.deployment!.manifest.networkInstance, checkpointHash: context.deployment!.manifest.checkpointHash } },
    async readOrder(request) { orderReads.push(request); assert.equal(request.token, context.session!.accessToken); return { ...PROFILE, observedAt: new Date(time).toISOString(), data: order } },
    async readCatalog() { return { ...PROFILE, observedAt: new Date(time).toISOString(), deploymentId: manifest.deploymentId, cashSymbol: "ARCO_TEST_USDC", instruments: [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER" }] } },
    async readExecutionPolicy() { return { allowed: true, deploymentDigest: digest(manifest), orderId: order.id, side, observedAt: time, validUntil: time + 15000 } },
    async readAllowance(request) { const p = planOrder(selected, context, time); assert.equal(request.token, p.token); assert.equal(request.owner, A); assert.equal(request.spender, p.spender); return allowance },
    async requestTransaction(tx) { walletCalls.push(tx); return h(walletCalls.length === 1 ? "c" : "d") },
    async waitApprovalReceipt({ txHash, transaction }) { allowance = planOrder(selected, context, time).amount; return { transactionHash: txHash, transaction, chainId: 91342, status: "success", canonical: true, blockHash: h("e"), blockNumber: "2" } },
    submissions: shared.submissions,
  }
  const controller = createStocksWalletController(ports); controller.select(selected)
  return { ports, controller, selected, order, manifest, walletCalls, orderReads, shared,
    context: () => context, setContext(value: ExecutionContext) { context = value; controller.refreshContext() },
    setTime(value: number) { time = value }, setAllowance(value: string) { allowance = value },
  }
}

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: exact approval, matching receipt and separate explicit transfer`, async () => {
    const f = fixture(side); const plan = planOrder(f.selected, f.context(), START)
    assert.equal(f.walletCalls.length, 0)
    await f.controller.prepare(); assert.equal(f.controller.getSnapshot().status, "APPROVAL_REQUIRED")
    await f.controller.approve(); assert.equal(f.controller.getSnapshot().status, "READY_TRANSFER")
    assert.equal(f.walletCalls.length, 1, "approval must not automatically submit payment/custody")
    assert.deepEqual(decodeFunctionData({ abi: APPROVAL_ABI, data: f.walletCalls[0]!.data }), { functionName: "approve", args: [plan.spender, BigInt(plan.amount)] })
    assert.deepEqual(f.walletCalls[0], plan.approval)
    await f.controller.submit(); assert.deepEqual(f.walletCalls[1], plan.transfer)
    assert.equal(f.controller.getSnapshot().status, "SUBMITTED")
    assert.equal(f.controller.getSnapshot().txHash, h("d"))
    assert.ok(f.orderReads.length >= 5, "fresh authenticated checks include the final pre-sign order read")
    assert.equal(f.shared.data.get(`${plan.intentKey}:TRANSFER`)?.status, "SUBMITTED")
    assert.equal(f.controller.getSnapshot().status === ("COMPLETED" as string), false)
    f.controller.dispose()
  })
  test(`${side}: existing sufficient allowance omits approve and submitted order never re-signs`, async () => {
    const f = fixture(side); f.setAllowance("1000000000000000000000000000000")
    await f.controller.prepare(); assert.equal(f.controller.getSnapshot().status, "READY_TRANSFER")
    const first = f.controller.submit(), second = f.controller.submit(); assert.equal(first, second)
    await first; assert.equal(f.walletCalls.length, 1)
    await f.controller.submit(); f.controller.cancel(); await f.controller.prepare()
    assert.equal(f.walletCalls.length, 1); assert.equal(f.controller.getSnapshot().status, "SUBMITTED")
    assert.equal(f.controller.getSnapshot().txHash, h("c")); f.controller.dispose()
  })
}

test("browser ABI digest matches actual backend ABI definition; contracts require both allowances", () => {
  const source = readFileSync(new URL("../../../../server/src/stocks/contracts.ts", import.meta.url), "utf8")
  const abiSection = /export const ABI = parseAbi\(\[([\s\S]+?)\]\)/.exec(source)![1]!
  const signatures = [...abiSection.matchAll(/'([^']+)'/g)].map(match => match[1]!)
  assert.deepEqual(STOCKS_ABI, parseAbi(signatures))
  assert.equal(STOCKS_ABI_DIGEST, sha256(toHex(JSON.stringify(parseAbi(signatures)))).slice(2))
  const vault = readFileSync(new URL("../../../../packages/contracts/contracts/stocks/StocksFundingVault.sol", import.meta.url), "utf8")
  const stock = readFileSync(new URL("../../../../packages/contracts/contracts/stocks/StocksToken.sol", import.meta.url), "utf8")
  assert.match(vault, /safeTransferFrom\(msg.sender, address\(this\), amount\)/)
  assert.match(stock, /_spendAllowance\(payer, redemptionEscrow, quantity\)/)
})

test("calldata round-trips through existing compiled Solidity artifacts", { skip: !process.env.GIWA_STOCKS_ARTIFACTS }, () => {
  const root = process.env.GIWA_STOCKS_ARTIFACTS!
  for (const side of ["BUY", "SELL"] as const) {
    const f = fixture(side), p = planOrder(f.selected, f.context(), START)
    const name = side === "BUY" ? "StocksFundingVault" : "StocksRedemptionEscrow"
    const artifact = JSON.parse(readFileSync(join(root, `contracts/stocks/${name}.sol/${name}.json`), "utf8")) as { abi: Abi }
    const decoded = decodeFunctionData({ abi: artifact.abi, data: p.transfer.data })
    assert.equal(decoded.functionName, side === "BUY" ? "depositForOrder" : "escrowForOrder")
    assert.deepEqual(decoded.args, side === "BUY" ? [p.order.orderKey, BigInt(p.amount)] : [p.order.orderKey, p.token, BigInt(p.amount)])
    assert.equal(encodeFunctionData({ abi: artifact.abi, functionName: decoded.functionName, args: decoded.args }), p.transfer.data)
    const tokenName = side === "BUY" ? "StocksTestCash" : "StocksToken"
    const tokenAbi = JSON.parse(readFileSync(join(root, `contracts/stocks/${tokenName}.sol/${tokenName}.json`), "utf8")).abi as Abi
    assert.deepEqual(decodeFunctionData({ abi: tokenAbi, data: p.approval.data }).args, [p.spender, BigInt(p.amount)])
    f.controller.dispose()
  }
})

test("large and smallest units retain exact bigint amount; malformed quantity/cash rejected", () => {
  const f = fixture()
  for (const quantity of [1n, 10n ** 30n - 1n]) {
    const cash = (quantity * 120000000n + 999999999n) / 1000000000n
    const plan = planOrder({ side: "BUY", order: { ...f.order, quantity: quantity.toString(), cashAmount: cash.toString() } }, f.context(), START)
    assert.deepEqual(decodeFunctionData({ abi: STOCKS_ABI, data: plan.transfer.data }).args, [f.order.orderKey, cash])
  }
  for (const value of [1, "1.0", "01", "-1", "0", (1n << 256n).toString()]) assert.throws(() => planOrder({ side: "BUY", order: { ...f.order, quantity: value } }, f.context(), START))
  assert.throws(() => planOrder({ side: "BUY", order: { ...f.order, cashAmount: "120000001" } }, f.context(), START), /ORDER_PRICE_MISMATCH/)
  const p = planOrder(f.selected, f.context(), START)
  for (const change of [{ value: "1" }, { from: B }, { to: B }, { chainId: 1 }, { data: "0x" }, { arbitrary: true }]) assert.throws(() => assertTransaction({ ...p.transfer, ...change } as Transaction, p.transfer))
  f.controller.dispose()
})

test("unreviewed, altered or expired deployment and wrong network never request wallet", async () => {
  for (const change of [
    { deployment: null }, { chainId: 1 }, { walletAddress: B }, { walletEpoch: "" }, { session: null },
  ]) {
    const f = fixture(); f.setContext({ ...f.context(), ...change }); await f.controller.prepare(); assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().status, "BLOCKED"); f.controller.dispose()
  }
  const f = fixture()
  const deployment = f.context().deployment!
  for (const mutation of [{ abiDigest: "unknown" }, { cashToken: B }, { cashSymbol: "USDC" }, { cashScale: 18 }]) {
    assert.throws(() => planOrder(f.selected, { ...f.context(), deployment: { ...deployment, manifest: { ...deployment.manifest, ...mutation } as ManifestV2 } }, START))
  }
  assert.throws(() => planOrder(f.selected, { ...f.context(), deployment: { ...deployment, validUntil: START } }, START))
  f.controller.dispose()
})

test("missing durable submission gate or current execution policy cannot be replaced by catalog", async () => {
  for (const field of ["submissions", "readExecutionPolicy"] as const) {
    const f = fixture(); Reflect.deleteProperty(f.ports, field)
    await f.controller.prepare(); await f.controller.submit(); assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().status, "BLOCKED"); f.controller.dispose()
  }
})

test("stale order, unavailable capability, denied policy and expired quote fail closed", async () => {
  for (const condition of ["state", "amount", "version", "catalog", "policy", "deadline", "readDeadline", "staleResponse"]) {
    const f = fixture(); f.setAllowance("999999999999")
    if (condition === "state") f.ports.readOrder = async () => ({ ...PROFILE, data: { ...f.order, state: "BROKER_PENDING" } })
    if (condition === "amount") f.ports.readOrder = async () => ({ ...PROFILE, data: { ...f.order, cashAmount: "120000001" } })
    if (condition === "version") f.ports.readOrder = async () => ({ ...PROFILE, data: { ...f.order, version: 1 } })
    if (condition === "catalog") f.ports.readCatalog = async () => ({ ...PROFILE, instruments: [] })
    if (condition === "policy") f.ports.readExecutionPolicy = async () => ({ allowed: false } as never)
    if (condition === "staleResponse") f.ports.readOrder = async () => ({ ...PROFILE, observedAt: new Date(START - 15000).toISOString(), data: f.order })
    if (condition === "deadline") f.setTime(START + 60000)
    if (condition === "readDeadline") f.ports.readOrder = async () => { f.setTime(START + 15000); return { ...PROFILE, data: f.order } }
    await f.controller.prepare(); assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().status, "BLOCKED", condition); f.controller.dispose()
  }
})

test("order changed during claim is re-read before the first wallet request", async () => {
  const f = fixture(); f.setAllowance("999999999999")
  await f.controller.prepare()
  const claim = f.ports.submissions.claim
  f.ports.submissions.claim = async req => { const result = await claim(req); f.ports.readOrder = async () => ({ ...PROFILE, data: { ...f.order, version: 1 } }); return result }
  await f.controller.submit()
  assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().status, "UNKNOWN", "durable reserved claim requires recovery even if this invocation did not prompt")
  f.controller.dispose()
})

test("approval revert and mismatched receipt never issue transfer or erase the hash", async () => {
  for (const kind of ["revert", "wrong-hash", "wrong-call", "null"]) {
    const f = fixture(); const original = f.ports.waitApprovalReceipt
    f.ports.waitApprovalReceipt = async req => {
      const receipt = (await original(req))!
      return kind === "revert" ? { ...receipt, status: "reverted" } : kind === "wrong-hash" ? { ...receipt, transactionHash: h("f") } : kind === "wrong-call" ? { ...receipt, transaction: { ...receipt.transaction, to: B } } : null
    }
    await f.controller.prepare(); await f.controller.approve(); await f.controller.submit()
    assert.equal(f.walletCalls.length, 1); assert.equal(f.controller.getSnapshot().txHash, h("c")); assert.equal(f.controller.getSnapshot().status, "APPROVAL_SUBMITTED"); f.controller.dispose()
  }
})

test("approval receipt does not authorize payment after deadline or order change", async () => {
  for (const change of ["deadline", "state", "allowance"]) {
    const f = fixture(); const original = f.ports.waitApprovalReceipt
    f.ports.waitApprovalReceipt = async req => { const result = await original(req); if (change === "deadline") f.setTime(START + 60000); if (change === "state") f.ports.readOrder = async () => ({ ...PROFILE, data: { ...f.order, state: "REVIEW_REQUIRED" } }); if (change === "allowance") f.setAllowance("0"); return result }
    await f.controller.prepare(); await f.controller.approve(); await f.controller.submit()
    assert.equal(f.walletCalls.length, 1); assert.equal(f.controller.getSnapshot().status, "APPROVAL_SUBMITTED"); assert.equal(f.controller.getSnapshot().txHash, h("c")); f.controller.dispose()
  }
})

test("wallet chain/account drift during any read prevents all signatures", async () => {
  for (const field of ["chainId", "address", "connectionEpoch", "deploymentDigest", "networkInstance", "checkpointHash"]) {
    const f = fixture(); const identity = await f.ports.readWallet()
    f.ports.readWallet = async () => ({ ...identity, [field]: field === "chainId" ? 1 : field === "address" ? B : "replaced" })
    await f.controller.prepare(); assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().status, "BLOCKED"); f.controller.dispose()
  }
})

test("A→B→A, disconnect, API and input changes fence a late read/401", async () => {
  for (const change of ["aba", "disconnect", "api", "input", "deployment"]) {
    const f = fixture(); const pending = deferred<unknown>(); const invalidations: string[] = []
    f.ports.readOrder = () => pending.promise; f.ports.invalidateSession = id => invalidations.push(id)
    const attempt = f.controller.prepare(); await flush()
    const original = f.context()
    if (change === "aba") { f.setContext({ ...original, walletAddress: B, walletEpoch: "2" }); f.setContext({ ...original, walletEpoch: "3" }) }
    if (change === "disconnect") f.setContext({ ...original, session: null, walletAddress: null })
    if (change === "api") f.setContext({ ...original, apiBase: "https://other-api.example" })
    if (change === "input") f.controller.select(null)
    if (change === "deployment") f.setContext({ ...original, deployment: null })
    pending.reject(Object.assign(new Error("private token message"), { status: 401 })); await attempt; await flush()
    assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().plan, null)
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes("private"))
    assert.ok(invalidations.every(id => id === original.session!.id)); f.controller.dispose()
  }
})

test("late wallet hash belongs to the original durable intent after account switch and cancel", async () => {
  for (const change of ["scope", "cancel", "dispose"]) {
    const f = fixture(); f.setAllowance("999999999999"); const pending = deferred<unknown>()
    f.ports.requestTransaction = async tx => { f.walletCalls.push(tx); return pending.promise }
    await f.controller.prepare(); const sending = f.controller.submit(); await flush(); assert.equal(f.walletCalls.length, 1)
    const p = planOrder(f.selected, f.context(), START)
    if (change === "scope") f.setContext({ ...f.context(), walletAddress: B, walletEpoch: "2" })
    else if (change === "cancel") f.controller.cancel()
    else f.controller.dispose()
    pending.resolve(h("f")); await sending
    assert.equal(f.shared.data.get(`${p.intentKey}:TRANSFER`)?.txHash, h("f"))
    if (change === "scope") assert.equal(f.controller.getSnapshot().plan, null)
    if (change === "cancel") { assert.equal(f.controller.getSnapshot().status, "SUBMITTED"); assert.equal(f.controller.getSnapshot().txHash, h("f")) }
    const recreated = fixture("BUY", f.shared); recreated.setAllowance("999999999999")
    await recreated.controller.prepare(); await recreated.controller.submit()
    assert.equal(recreated.walletCalls.length, 0); assert.equal(recreated.controller.getSnapshot().status, "SUBMITTED"); assert.equal(recreated.controller.getSnapshot().txHash, h("f"))
    recreated.controller.dispose(); f.controller.dispose()
  }
})

test("unknown wallet outcomes, user rejection and invalid hashes never permit automatic retry", async () => {
  for (const failure of ["reject", "4001", "bad-hash"]) {
    const f = fixture(); f.setAllowance("999999999999")
    f.ports.requestTransaction = async tx => { f.walletCalls.push(tx); if (failure === "bad-hash") return "0x123"; throw Object.assign(new Error("secret provider result"), { code: failure === "4001" ? 4001 : -1 }) }
    await f.controller.prepare(); await f.controller.submit(); assert.equal(f.controller.getSnapshot().status, "UNKNOWN")
    await f.controller.submit(); f.controller.cancel(); await f.controller.prepare(); await f.controller.submit()
    assert.equal(f.walletCalls.length, 1); assert.equal(f.controller.getSnapshot().status, "UNKNOWN")
    assert.ok(!JSON.stringify(f.controller.getSnapshot()).includes("secret")); f.controller.dispose()
  }
})

test("shared atomic claim prevents two independent controllers from depositing the same BUY order", async () => {
  const shared = gate(); const a = fixture("BUY", shared), b = fixture("BUY", shared)
  a.setAllowance("999999999999"); b.setAllowance("999999999999")
  await Promise.all([a.controller.prepare(), b.controller.prepare()])
  await Promise.all([a.controller.submit(), b.controller.submit()])
  assert.equal(a.walletCalls.length + b.walletCalls.length, 1)
  a.controller.dispose(); b.controller.dispose()
})

test("journal failure after hash preserves local result and prevents re-sign even if the record disappears", async () => {
  const f = fixture(); f.setAllowance("999999999999")
  f.ports.submissions.record = async () => { throw new Error("private storage URL") }
  await f.controller.prepare(); await f.controller.submit()
  assert.equal(f.controller.getSnapshot().status, "SUBMITTED"); assert.equal(f.controller.getSnapshot().txHash, h("c"))
  const seenHashes: unknown[] = []
  const unsubscribe = f.controller.subscribe(() => seenHashes.push(f.controller.getSnapshot().txHash))
  await f.controller.prepare() // stale durable REQUEST_MAY_START lacks the locally known hash
  f.shared.data.clear()
  await f.controller.prepare(); await f.controller.submit()
  assert.ok(seenHashes.every(value => value === h("c")))
  unsubscribe()
  assert.equal(f.walletCalls.length, 1); assert.equal(f.controller.getSnapshot().txHash, h("c"))
  f.controller.dispose()
})

test("expiration after submission never relabels transaction as order completion or loses its hash", async () => {
  const f = fixture(); f.setAllowance("999999999999")
  await f.controller.prepare(); await f.controller.submit(); f.setTime(START + 60000)
  await f.controller.prepare(); assert.equal(f.controller.getSnapshot().status, "SUBMITTED"); assert.equal(f.controller.getSnapshot().txHash, h("c")); assert.equal(f.walletCalls.length, 1)
  f.controller.dispose()
})

test("approval that resolves after scope replacement cannot prompt for payment", async () => {
  const f = fixture(); const pending = deferred<unknown>()
  f.ports.requestTransaction = async tx => { f.walletCalls.push(tx); return pending.promise }
  await f.controller.prepare(); const approval = f.controller.approve(); await flush()
  assert.equal(f.walletCalls.length, 1)
  const plan = planOrder(f.selected, f.context(), START)
  f.setContext({ ...f.context(), walletAddress: B, walletEpoch: "injected:2" })
  pending.resolve(h("f")); await approval
  assert.equal(f.controller.getSnapshot().plan, null)
  assert.equal(f.shared.data.get(`${plan.intentKey}:APPROVAL`)?.txHash, h("f"))
  await f.controller.submit(); assert.equal(f.walletCalls.length, 1)
  f.controller.dispose()
})

test("allowance is rechecked before submit and accepted input cannot mutate the frozen plan", async () => {
  const f = fixture(); f.setAllowance("999999999999")
  await f.controller.prepare()
  const snapshot = f.controller.getSnapshot()
  assert.ok(Object.isFrozen(snapshot.plan)); assert.ok(Object.isFrozen(snapshot.plan!.transfer))
  f.setAllowance("0")
  await f.controller.submit(); assert.equal(f.walletCalls.length, 0); assert.equal(f.controller.getSnapshot().error, "ALLOWANCE_CHANGED")
  f.controller.dispose()
})

test("synchronous cancellation/context replacement from signing notification cannot open the wallet", async () => {
  for (const mode of ["cancel", "scope"]) {
    const f = fixture(); f.setAllowance("999999999999")
    await f.controller.prepare()
    const unsubscribe = f.controller.subscribe(() => {
      if (f.controller.getSnapshot().status !== "SIGNING") return
      if (mode === "cancel") f.controller.cancel()
      else f.setContext({ ...f.context(), walletAddress: B, walletEpoch: "replacement" })
    })
    await f.controller.submit()
    assert.equal(f.walletCalls.length, 0)
    unsubscribe(); f.controller.dispose()
  }
})

test("a consumed confirmed approval is recovery-only, not another approval prompt", async () => {
  const f = fixture()
  await f.controller.prepare(); await f.controller.approve(); assert.equal(f.controller.getSnapshot().status, "READY_TRANSFER")
  f.setAllowance("0")
  await f.controller.prepare(); assert.equal(f.controller.getSnapshot().status, "APPROVAL_SUBMITTED")
  await f.controller.approve(); assert.equal(f.walletCalls.length, 1)
  f.controller.dispose()
})

for (const windowMs of [1, 15000]) for (const action of ["approve", "submit"] as const) {
  test(`${action} rechecks ${windowMs}ms policy expiry after synchronous signing subscribers`, async () => {
    const f = fixture()
    if (action === "submit") f.setAllowance("999999999999")
    const readPolicy = f.ports.readExecutionPolicy
    f.ports.readExecutionPolicy = async request => ({ ...await readPolicy(request), validUntil: START + windowMs })
    const plan = planOrder(f.selected, f.context(), START)
    const stage = action === "approve" ? "APPROVAL" : "TRANSFER"
    let unsubscribe = () => {}
    try {
      await f.controller.prepare()
      unsubscribe = f.controller.subscribe(() => {
        if (f.controller.getSnapshot().status === "SIGNING") f.setTime(START + windowMs)
      })
      await f.controller[action]()
      assert.equal(f.walletCalls.length, 0)
      assert.equal(f.controller.getSnapshot().status, "UNKNOWN")
      const claim = f.shared.data.get(`${plan.intentKey}:${stage}`)
      assert.equal(claim?.status, "UNKNOWN")
      assert.equal(claim?.txHash, undefined)
      assert.equal(f.shared.data.size, 1)
      unsubscribe()
      // Even a fresh policy cannot silently release the durable claim or reopen the wallet.
      f.ports.readExecutionPolicy = readPolicy
      await f.controller[action](); f.controller.cancel(); await f.controller.prepare(); await f.controller[action]()
      assert.equal(f.walletCalls.length, 0)
      assert.equal(f.shared.data.get(`${plan.intentKey}:${stage}`)?.claimId, claim?.claimId)
      assert.equal(f.controller.getSnapshot().status, "UNKNOWN")
    } finally { unsubscribe(); f.controller.dispose() }
  })
}
