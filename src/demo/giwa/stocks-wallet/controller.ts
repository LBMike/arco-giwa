import { address, assertTransaction, canonical, digest, ensure, freeze, hash, integer, parseOrder, planOrder, record, StocksWalletError, validateContext } from "./planner"
import type { AttemptRecord, AuthenticatedRead, ExecutionContext, Plan, Selection, Stage, WalletPorts, WalletSnapshot } from "./types"

const IDLE: WalletSnapshot = Object.freeze({ status: "IDLE", orderId: null, intentKey: null, stage: null, txHash: null, error: null, plan: null })
type Attempt = { generation: number; scope: string; context: ExecutionContext; selection: Selection; plan: Plan; abort: AbortController; promise?: Promise<void> }

/** Explicit actions only. No transport, wallet or persistence implementation is selected implicitly. */
export function createStocksWalletController(ports: WalletPorts) {
  const now = ports.now ?? Date.now
  let selected: Selection | null = null
  let generation = 0, disposed = false
  let scope = ""
  let snapshot = IDLE
  let active: Attempt | null = null
  const listeners = new Set<() => void>()
  // Never erase uncertain/submitted results just because the displayed scope changed.
  const attempted = new Map<string, AttemptRecord>()
  function notify() { listeners.forEach(fn => fn()) }
  function publish(value: WalletSnapshot) { snapshot = freeze(value); notify() }
  function key(context: ExecutionContext) { return digest([context, selected]) }
  function synchronize() {
    let next: string
    try { next = key(ports.context()) } catch { next = "invalid-context" }
    if (next !== scope) {
      scope = next; generation++; active?.abort.abort(); active = null; snapshot = IDLE
      queueMicrotask(() => { if (!disposed) notify() })
    }
    if (snapshot.plan) {
      try { validateContext(ports.context(), now()) }
      catch { generation++; active?.abort.abort(); active = null; snapshot = Object.freeze({ ...IDLE, status: "BLOCKED", error: "CONTEXT_EXPIRED" }); queueMicrotask(() => { if (!disposed) notify() }) }
    }
    return snapshot
  }
  function current(a: Attempt) { synchronize(); return !disposed && active === a && a.generation === generation && a.scope === scope && !a.abort.signal.aborted }
  function guard(a: Attempt) {
    ensure(current(a), "CONTEXT_CHANGED")
    validateContext(ports.context(), now())
    ensure(now() < a.plan.deadline, "ORDER_EXPIRED")
  }
  async function bounded<T>(a: Attempt, work: () => Promise<T>): Promise<T> {
    guard(a)
    const start = now(); let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => reject(new StocksWalletError("CONTEXT_CHANGED"))
      a.abort.signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => reject(new StocksWalletError("READ_TIMEOUT")), 15_000)
    })
    try {
      const value = await Promise.race([Promise.resolve().then(() => { guard(a); return work() }), stop])
      guard(a); ensure(now() >= start && now() - start < 15_000, "READ_TIMEOUT"); return value
    } finally { if (timer) clearTimeout(timer); a.abort.signal.removeEventListener("abort", onAbort) }
  }
  async function wallet(a: Attempt) {
    const identity = await bounded(a, () => ports.readWallet())
    guard(a)
    ensure(identity.chainId === 91342 && address(identity.address).toLowerCase() === a.plan.order.wallet.toLowerCase() && identity.connectionEpoch === a.context.walletEpoch, "WALLET_CHANGED")
    ensure(identity.deploymentDigest === a.plan.manifestDigest && identity.networkInstance === a.context.deployment!.manifest.networkInstance && hash(identity.checkpointHash) === hash(a.context.deployment!.manifest.checkpointHash), "WALLET_NETWORK_INSTANCE_MISMATCH")
  }
  async function read<T>(a: Attempt, work: () => Promise<T>) {
    const result = await bounded(a, work)
    await wallet(a)
    return result
  }
  function request(a: Attempt): AuthenticatedRead {
    return { apiBase: a.context.apiBase, token: a.context.session!.accessToken, sessionId: a.context.session!.id, side: a.plan.side, orderId: a.plan.order.id, deploymentDigest: a.plan.manifestDigest, signal: a.abort.signal }
  }
  function state(a: Attempt, status: WalletSnapshot["status"], extra: Partial<WalletSnapshot> = {}) {
    if (current(a)) publish({ ...IDLE, status, plan: a.plan, orderId: a.plan.order.id, intentKey: a.plan.intentKey, ...extra })
  }
  function validateRecord(value: AttemptRecord, a: Attempt, stage: Stage) {
    ensure(value.intentKey === a.plan.intentKey && value.stage === stage && value.transactionDigest === digest(stage === "APPROVAL" ? a.plan.approval : a.plan.transfer) && typeof value.claimId === "string" && value.claimId.length > 0, "SUBMISSION_RECORD_MISMATCH")
    ensure(["REQUEST_MAY_START", "SUBMITTED", "UNKNOWN", "CONFIRMED", "REVERTED"].includes(value.status), "SUBMISSION_RECORD_MISMATCH")
    if (value.txHash) hash(value.txHash)
    if (value.status === "SUBMITTED" || value.status === "CONFIRMED") ensure(value.txHash, "SUBMISSION_RECORD_MISMATCH")
  }
  async function inspect(a: Attempt) {
    ensure(typeof ports.submissions?.inspect === "function" && typeof ports.submissions.claim === "function" && typeof ports.submissions.record === "function", "DURABLE_SUBMISSION_GATE_REQUIRED")
    const prior = await read(a, () => ports.submissions.inspect(a.plan.intentKey))
    for (const stage of ["APPROVAL", "TRANSFER"] as const) {
      const entry = stage === "APPROVAL" ? prior.approval : prior.transfer
      if (entry) validateRecord(entry, a, stage)
      const local = attempted.get(`${a.plan.intentKey}:${stage}`)
      // A disappearing durable record is not proof that a previous wallet request was never sent.
      if (local) {
        ensure(entry && entry.claimId === local.claimId, "SUBMISSION_HISTORY_MISSING")
        ensure(!local.txHash || entry.txHash === local.txHash, "SUBMISSION_HISTORY_MISMATCH")
      }
      else if (entry) attempted.set(`${a.plan.intentKey}:${stage}`, freeze(entry))
    }
    if (prior.transfer) {
      state(a, prior.transfer.txHash ? "SUBMITTED" : "UNKNOWN", { stage: "TRANSFER", txHash: prior.transfer.txHash ?? null, error: "RECOVERY_REQUIRED" })
      return false
    }
    if (prior.approval && prior.approval.status !== "CONFIRMED") {
      state(a, prior.approval.txHash ? "APPROVAL_SUBMITTED" : "UNKNOWN", { stage: "APPROVAL", txHash: prior.approval.txHash ?? null, error: "RECOVERY_REQUIRED" })
      return false
    }
    return true
  }
  function freshResponse(value: Record<string, unknown>) {
    const observed = typeof value.observedAt === "string" ? Date.parse(value.observedAt) : NaN
    ensure(Number.isFinite(observed) && observed <= now() && now() - observed < 15_000, "STALE_RESPONSE")
  }
  async function preflight(a: Attempt) {
    await wallet(a)
    const req = request(a)
    const response = record(await read(a, () => ports.readOrder(req)))
    ensure(response.profile === "DEMO_TESTNET" && response.valuePolicy === "TEST_VALUE_ONLY" && response.brokerMode === "MOCK_BROKER" && response.chainId === 91342 && response.priceSource === "FIXED_MOCK_PRICE", "ORDER_PROFILE_MISMATCH")
    freshResponse(response)
    const currentOrder = parseOrder({ side: a.plan.side, order: response.data })
    ensure(canonical(currentOrder) === canonical(a.plan.order), "ORDER_CHANGED")
    planOrder({ side: a.plan.side, order: currentOrder }, a.context, now())
    const catalog = record(await read(a, () => ports.readCatalog(req)))
    ensure(catalog.profile === "DEMO_TESTNET" && catalog.valuePolicy === "TEST_VALUE_ONLY" && catalog.brokerMode === "MOCK_BROKER" && catalog.chainId === 91342 && catalog.priceSource === "FIXED_MOCK_PRICE" && catalog.deploymentId === a.plan.order.deploymentId && catalog.cashSymbol === "ARCO_TEST_USDC" && Array.isArray(catalog.instruments), "CATALOG_MISMATCH")
    freshResponse(catalog)
    const instruments = catalog.instruments.map(record)
    ensure(instruments.length === 1 && instruments[0]!.symbol === "NVDA" && instruments[0]!.quantityScale === 9 && instruments[0]!.price === "120.000000" && instruments[0]!.priceSource === "FIXED_MOCK_PRICE" && instruments[0]!.orderCapability === "CHECK_PAUSE_AT_ORDER", "CAPABILITY_UNAVAILABLE")
    ensure(typeof ports.readExecutionPolicy === "function", "CURRENT_POLICY_REQUIRED")
    const policy = await read(a, () => ports.readExecutionPolicy(req))
    ensure(policy?.allowed === true && policy.deploymentDigest === a.plan.manifestDigest && policy.orderId === a.plan.order.id && policy.side === a.plan.side && Number.isFinite(policy.observedAt) && Number.isFinite(policy.validUntil) && policy.observedAt <= now() && now() < policy.validUntil && policy.validUntil - policy.observedAt <= 15_000, "EXECUTION_NOT_ALLOWED")
    ensure(await inspect(a), "RECOVERY_REQUIRED")
    const allowance = integer(await read(a, () => ports.readAllowance({ token: a.plan.token, owner: a.plan.order.wallet, spender: a.plan.spender, chainId: 91342, signal: a.abort.signal })), true)
    ensure(now() < policy.validUntil, "EXECUTION_POLICY_EXPIRED")
    ensure(allowance >= BigInt(a.plan.amount) || !attempted.has(`${a.plan.intentKey}:APPROVAL`), "ALLOWANCE_RECOVERY_REQUIRED")
    return { allowance, policyUntil: policy.validUntil }
  }
  async function persist(value: AttemptRecord) {
    // Durable outcome updates ALWAYS refer to the original claimed intent, even after scope changes.
    attempted.set(`${value.intentKey}:${value.stage}`, freeze(value))
    synchronize()
    // Cancellation stops further work, not a wallet request already sent. A late hash may
    // update the SAME displayed intent; it can never repopulate a different scope/order.
    if (!disposed && value.txHash && snapshot.intentKey === value.intentKey && snapshot.stage === value.stage) {
      publish({ ...snapshot, status: value.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED", txHash: value.txHash })
    }
    await ports.submissions.record(freeze(value))
  }
  async function send(a: Attempt, stage: Stage, policyUntil: number) {
    const tx = stage === "APPROVAL" ? a.plan.approval : a.plan.transfer
    assertTransaction(tx, stage === "APPROVAL" ? planOrder(a.selection, a.context, now()).approval : planOrder(a.selection, a.context, now()).transfer)
    await wallet(a)
    const claim = await read(a, () => ports.submissions.claim({ intentKey: a.plan.intentKey, stage, transactionDigest: digest(tx), transaction: tx, orderId: a.plan.order.id, deploymentDigest: a.plan.manifestDigest }))
    ensure(claim, "SUBMISSION_ALREADY_CLAIMED"); validateRecord(claim, a, stage)
    ensure(claim.status === "REQUEST_MAY_START" && !claim.txHash, "SUBMISSION_ALREADY_CLAIMED")
    attempted.set(`${a.plan.intentKey}:${stage}`, freeze(claim))
    // Claim/allowance reads can take time. Re-authorize the accepted order immediately before signing.
    const finalResponse = record(await read(a, () => ports.readOrder(request(a))))
    ensure(finalResponse.profile === "DEMO_TESTNET" && finalResponse.valuePolicy === "TEST_VALUE_ONLY" && finalResponse.brokerMode === "MOCK_BROKER" && finalResponse.chainId === 91342 && finalResponse.priceSource === "FIXED_MOCK_PRICE", "ORDER_PROFILE_MISMATCH")
    freshResponse(finalResponse)
    ensure(canonical(parseOrder({ side: a.plan.side, order: finalResponse.data })) === canonical(a.plan.order), "ORDER_CHANGED")
    guard(a); ensure(now() < policyUntil, "EXECUTION_POLICY_EXPIRED")
    state(a, "SIGNING", { stage })
    let result: unknown
    try { guard(a); result = await ports.requestTransaction(tx) }
    catch {
      const unknown = { ...claim, status: "UNKNOWN" as const }
      try { await persist(unknown) } catch { /* The pre-request claim still blocks re-signing. */ }
      state(a, "UNKNOWN", { stage, error: "WALLET_OUTCOME_UNKNOWN" }); return
    }
    let txHash: `0x${string}`
    try { txHash = hash(result) } catch {
      try { await persist({ ...claim, status: "UNKNOWN" }) } catch { /* Claimed already. */ }
      state(a, "UNKNOWN", { stage, error: "WALLET_OUTCOME_UNKNOWN" }); return
    }
    const submitted: AttemptRecord = { ...claim, status: "SUBMITTED", txHash }
    try { await persist(submitted) } catch {
      state(a, stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED", { stage, txHash, error: "RECOVERY_REQUIRED" }); return
    }
    // No further wallet request can follow an unchecked late result. Never paint it into a new scope.
    if (!current(a)) return
    state(a, stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED", { stage, txHash })
    try { await wallet(a) } catch { return }
    if (stage === "TRANSFER") return // Receipt/hash is not Stocks order completion.
    const receipt = await read(a, () => ports.waitApprovalReceipt({ txHash, transaction: tx, signal: a.abort.signal }))
    if (!receipt) return
    ensure(receipt.chainId === 91342 && receipt.canonical === true && hash(receipt.transactionHash) === txHash, "APPROVAL_RECEIPT_MISMATCH")
    hash(receipt.blockHash); integer(receipt.blockNumber, true); assertTransaction(receipt.transaction, tx)
    ensure(receipt.status === "success" || receipt.status === "reverted", "APPROVAL_RECEIPT_MISMATCH")
    await persist({ ...submitted, status: receipt.status === "success" ? "CONFIRMED" : "REVERTED" })
    await wallet(a)
    ensure(receipt.status === "success", "APPROVAL_REVERTED")
    const fresh = await preflight(a)
    ensure(fresh.allowance >= BigInt(a.plan.amount), "ALLOWANCE_NOT_CONFIRMED")
    state(a, "READY_TRANSFER") // Requires a separate explicit submit() click.
  }
  async function run(a: Attempt, action: "prepare" | "approve" | "submit") {
    try {
      if (!["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status)) state(a, "CHECKING")
      const fresh = await preflight(a)
      if (action === "prepare") { state(a, fresh.allowance >= BigInt(a.plan.amount) ? "READY_TRANSFER" : "APPROVAL_REQUIRED"); return }
      if (action === "approve") {
        if (fresh.allowance >= BigInt(a.plan.amount)) { state(a, "READY_TRANSFER"); return }
        await send(a, "APPROVAL", fresh.policyUntil)
      } else {
        ensure(fresh.allowance >= BigInt(a.plan.amount), "ALLOWANCE_CHANGED")
        await send(a, "TRANSFER", fresh.policyUntil)
      }
    } catch (error) {
      const status = error && typeof error === "object" ? (error as { status?: unknown }).status : null
      if (status === 401) { try { ports.invalidateSession?.(a.context.session!.id) } catch { /* Notification failure never permits signing. */ } }
      if (current(a)) {
        // Keep a known hash/uncertain state; an ordinary error must not turn it into a retry button.
        const known = attempted.get(`${a.plan.intentKey}:TRANSFER`) ?? attempted.get(`${a.plan.intentKey}:APPROVAL`)
        if (known) state(a, known.txHash ? known.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED" : "UNKNOWN", { stage: known.stage, txHash: known.txHash ?? null, error: error instanceof StocksWalletError ? error.code : "REQUEST_FAILED" })
        else if (snapshot.error !== "RECOVERY_REQUIRED") state(a, "BLOCKED", { error: error instanceof StocksWalletError ? error.code : status === 401 ? "SESSION_REJECTED" : "REQUEST_FAILED" })
      }
    } finally { if (active === a) active = null }
  }
  function start(action: "prepare" | "approve" | "submit"): Promise<void> {
    synchronize()
    if (disposed) return Promise.resolve()
    if (active?.promise) return active.promise
    try {
      ensure(selected, "ORDER_REQUIRED")
      if (action === "approve") ensure(snapshot.status === "APPROVAL_REQUIRED", "PREPARE_REQUIRED")
      if (action === "submit") ensure(snapshot.status === "READY_TRANSFER", "PREPARE_REQUIRED")
      const context = freeze(ports.context())
      const a: Attempt = { context, selection: selected, plan: planOrder(selected, context, now()), scope, generation, abort: new AbortController() }
      active = a
      a.promise = Promise.resolve().then(() => run(a, action))
      return a.promise
    } catch (error) {
      // Failed direct submit/approve cannot erase a prior submission hash.
      if (!["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status)) publish({ ...IDLE, status: "BLOCKED", error: error instanceof StocksWalletError ? error.code : "INVALID_CONTEXT" })
      return Promise.resolve()
    }
  }
  return {
    select(selection: Selection | null) { selected = selection ? freeze(selection) : null; synchronize() },
    refreshContext() { synchronize() },
    getSnapshot: () => synchronize(),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    prepare: () => start("prepare"), approve: () => start("approve"), submit: () => start("submit"),
    cancel() {
      if (!active && ["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status)) return
      const previous = active; generation++; active?.abort.abort(); active = null
      const known = previous && (attempted.get(`${previous.plan.intentKey}:TRANSFER`) ?? attempted.get(`${previous.plan.intentKey}:APPROVAL`))
      publish(known ? { ...snapshot, status: known.txHash ? known.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED" : "UNKNOWN", stage: known.stage, txHash: known.txHash ?? null, error: "RECOVERY_REQUIRED" } : IDLE)
    },
    dispose() { disposed = true; generation++; active?.abort.abort(); active = null; snapshot = IDLE; listeners.clear() },
  }
}
