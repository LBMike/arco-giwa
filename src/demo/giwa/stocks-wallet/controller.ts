import { address, assertTransaction, canonical, digest, ensure, freeze, hash, integer, parseOrder, planOrder, record, StocksWalletError, validateContext } from "./planner"
import type { AttemptRecord, AuthenticatedRead, ExecutionContext, Plan, Selection, Stage, SubmissionGate, WalletPorts, WalletSnapshot } from "./types"

const IDLE: WalletSnapshot = Object.freeze({ status: "IDLE", orderId: null, intentKey: null, stage: null, txHash: null, error: null, plan: null })
type Attempt = { generation: number; scope: string; context: ExecutionContext; selection: Selection; plan: Plan; abort: AbortController; submissions: SubmissionGate; promise?: Promise<void> }

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
    const start = now(), startedMono = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => reject(new StocksWalletError("CONTEXT_CHANGED"))
      a.abort.signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => reject(new StocksWalletError("READ_TIMEOUT")), 15_000)
    })
    try {
      const value = await Promise.race([Promise.resolve().then(() => { guard(a); return work() }), stop])
      guard(a); ensure(now() >= start && now() - start < 15_000 && performance.now() - startedMono >= 0 && performance.now() - startedMono < 15_000, "READ_TIMEOUT"); return value
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
    if (value.status === "SUBMITTED" || value.status === "CONFIRMED" || value.status === "REVERTED") ensure(value.txHash, "SUBMISSION_RECORD_MISMATCH")
  }
  const terminal = (value: AttemptRecord) => value.status === "CONFIRMED" || value.status === "REVERTED"
  function rememberRecord(value: AttemptRecord, a: Attempt, stage: Stage) {
    validateRecord(value, a, stage)
    const key = `${a.plan.intentKey}:${stage}`, previous = attempted.get(key)
    if (previous) {
      ensure(value.claimId === previous.claimId, "SUBMISSION_HISTORY_MISMATCH")
      ensure(!previous.txHash || value.txHash === previous.txHash, "SUBMISSION_HISTORY_MISMATCH")
      if (terminal(previous)) {
        if (terminal(value)) ensure(value.status === previous.status, "SUBMISSION_TERMINAL_MISMATCH")
        return previous
      }
      if (previous.status === "SUBMITTED" && !terminal(value) && value.status !== "SUBMITTED") return previous
    }
    const result = freeze(value); attempted.set(key, result); return result
  }
  async function reconcileApproval(a: Attempt, value: AttemptRecord) {
    ensure(value.txHash && typeof a.submissions.reconcile === "function", "TRUSTED_RECONCILIATION_REQUIRED")
    const result = await read(a, () => a.submissions.reconcile!({ claimId: value.claimId, intentKey: value.intentKey, stage: value.stage, transactionDigest: value.transactionDigest, txHash: value.txHash! }))
    guard(a)
    ensure(result.claimId === value.claimId && result.txHash === value.txHash, "SUBMISSION_HISTORY_MISMATCH")
    const known = rememberRecord(result, a, "APPROVAL")
    ensure(known.status !== "REVERTED", "APPROVAL_REVERTED")
    if (known.status !== "CONFIRMED") {
      state(a, "APPROVAL_SUBMITTED", { stage: "APPROVAL", txHash: known.txHash ?? null, error: "RECEIPT_PENDING" })
      return false
    }
    return true
  }
  async function inspect(a: Attempt, recoverApproval: boolean): Promise<"ready" | "reconciled" | "blocked"> {
    ensure(typeof a.submissions?.inspect === "function" && typeof a.submissions.claim === "function" && typeof a.submissions.record === "function", "DURABLE_SUBMISSION_GATE_REQUIRED")
    const prior = { ...await read(a, () => a.submissions.inspect(a.plan.intentKey)) }
    guard(a)
    for (const stage of ["APPROVAL", "TRANSFER"] as const) {
      const entry = stage === "APPROVAL" ? prior.approval : prior.transfer
      if (entry) {
        const known = rememberRecord(entry, a, stage)
        if (stage === "APPROVAL") prior.approval = known
        else prior.transfer = known
      } else ensure(!attempted.has(`${a.plan.intentKey}:${stage}`), "SUBMISSION_HISTORY_MISSING")
    }
    if (prior.transfer) {
      state(a, prior.transfer.status === "REVERTED" ? "BLOCKED" : prior.transfer.txHash ? "SUBMITTED" : "UNKNOWN", { stage: "TRANSFER", txHash: prior.transfer.txHash ?? null, error: prior.transfer.status === "REVERTED" ? "TRANSFER_REVERTED" : "RECOVERY_REQUIRED" })
      return "blocked" // Even server-confirmed transfer is not Stocks order completion.
    }
    if (prior.approval) {
      ensure(prior.approval.status !== "REVERTED", "APPROVAL_REVERTED")
      if (prior.approval.status === "CONFIRMED") return "ready"
      if (recoverApproval && prior.approval.txHash) return await reconcileApproval(a, prior.approval) ? "reconciled" : "blocked"
      state(a, prior.approval.txHash ? "APPROVAL_SUBMITTED" : "UNKNOWN", { stage: "APPROVAL", txHash: prior.approval.txHash ?? null, error: "RECOVERY_REQUIRED" })
      return "blocked"
    }
    return "ready"
  }
  function freshResponse(value: Record<string, unknown>) {
    const observed = typeof value.observedAt === "string" ? Date.parse(value.observedAt) : NaN
    ensure(Number.isFinite(observed) && observed <= now() && now() - observed < 15_000, "STALE_RESPONSE")
  }
  async function preflight(a: Attempt, recoverApproval = false): Promise<{ allowance: bigint; policyUntil: number }> {
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
    const journal = await inspect(a, recoverApproval)
    ensure(journal !== "blocked", "RECOVERY_REQUIRED")
    if (journal === "reconciled") return preflight(a) // New verification requires entirely fresh authorization reads.
    const allowance = integer(await read(a, () => ports.readAllowance({ token: a.plan.token, owner: a.plan.order.wallet, spender: a.plan.spender, chainId: 91342, signal: a.abort.signal })), true)
    ensure(now() < policy.validUntil, "EXECUTION_POLICY_EXPIRED")
    ensure(allowance >= BigInt(a.plan.amount) || !attempted.has(`${a.plan.intentKey}:APPROVAL`), "ALLOWANCE_RECOVERY_REQUIRED")
    return { allowance, policyUntil: policy.validUntil }
  }
  async function persist(a: Attempt, value: AttemptRecord) {
    // Durable outcome updates ALWAYS refer to the original claimed intent, even after scope changes.
    ensure(!terminal(value), "CLIENT_TERMINAL_REPORT_FORBIDDEN")
    const known = rememberRecord(value, a, value.stage)
    synchronize()
    // Cancellation stops further work, not a wallet request already sent. A late hash may
    // update the SAME displayed intent; it can never repopulate a different scope/order.
    if (!disposed && !terminal(known) && scope === a.scope && value.txHash && snapshot.intentKey === value.intentKey && snapshot.stage === value.stage) {
      publish({ ...snapshot, status: value.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED", txHash: value.txHash })
    }
    await a.submissions.record(freeze(value))
  }
  async function send(a: Attempt, stage: Stage, policyUntil: number) {
    const tx = stage === "APPROVAL" ? a.plan.approval : a.plan.transfer
    assertTransaction(tx, stage === "APPROVAL" ? planOrder(a.selection, a.context, now()).approval : planOrder(a.selection, a.context, now()).transfer)
    await wallet(a)
    const claim = await read(a, () => a.submissions.claim({ intentKey: a.plan.intentKey, stage, transactionDigest: digest(tx), transaction: tx, orderId: a.plan.order.id, deploymentDigest: a.plan.manifestDigest }))
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
    // SIGNING subscribers run synchronously and may consume the policy's remaining lifetime.
    try { guard(a); ensure(now() < policyUntil, "EXECUTION_POLICY_EXPIRED"); result = await ports.requestTransaction(tx) }
    catch {
      const unknown = { ...claim, status: "UNKNOWN" as const }
      try { await persist(a, unknown) } catch { /* The pre-request claim still blocks re-signing. */ }
      state(a, "UNKNOWN", { stage, error: "WALLET_OUTCOME_UNKNOWN" }); return
    }
    let txHash: `0x${string}`
    try { txHash = hash(result) } catch {
      try { await persist(a, { ...claim, status: "UNKNOWN" }) } catch { /* Claimed already. */ }
      state(a, "UNKNOWN", { stage, error: "WALLET_OUTCOME_UNKNOWN" }); return
    }
    const submitted: AttemptRecord = { ...claim, status: "SUBMITTED", txHash }
    try { await persist(a, submitted) } catch {
      state(a, stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED", { stage, txHash, error: "RECOVERY_REQUIRED" }); return
    }
    // No further wallet request can follow an unchecked late result. Never paint it into a new scope.
    if (!current(a)) return
    state(a, stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED", { stage, txHash })
    try { await wallet(a) } catch { return }
    if (stage === "TRANSFER") return // Receipt/hash is not Stocks order completion.
    if (!await reconcileApproval(a, submitted)) return
    const fresh = await preflight(a)
    ensure(fresh.allowance >= BigInt(a.plan.amount), "ALLOWANCE_NOT_CONFIRMED")
    state(a, "READY_TRANSFER") // Requires a separate explicit submit() click.
  }
  async function run(a: Attempt, action: "prepare" | "approve" | "submit") {
    try {
      if (!snapshot.txHash && !["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status)) state(a, "CHECKING")
      const fresh = await preflight(a, action === "prepare")
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
        if (known) state(a, known.status === "REVERTED" ? "BLOCKED" : known.txHash ? known.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED" : "UNKNOWN", { stage: known.stage, txHash: known.txHash ?? null, error: error instanceof StocksWalletError ? error.code : "REQUEST_FAILED" })
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
      const a: Attempt = { context, selection: selected, plan: planOrder(selected, context, now()), scope, generation, abort: new AbortController(), submissions: ports.submissions }
      active = a
      a.promise = Promise.resolve().then(() => run(a, action))
      return a.promise
    } catch (error) {
      // Failed direct submit/approve cannot erase a prior submission hash.
      if (!["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status) && !snapshot.txHash) publish({ ...IDLE, status: "BLOCKED", error: error instanceof StocksWalletError ? error.code : "INVALID_CONTEXT" })
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
      if (!active && (snapshot.txHash || ["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status))) return
      const previous = active; generation++; active?.abort.abort(); active = null
      const known = previous && (attempted.get(`${previous.plan.intentKey}:TRANSFER`) ?? attempted.get(`${previous.plan.intentKey}:APPROVAL`))
      publish(known ? { ...snapshot, status: known.status === "REVERTED" ? "BLOCKED" : known.txHash ? known.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED" : "UNKNOWN", stage: known.stage, txHash: known.txHash ?? null, error: "RECOVERY_REQUIRED" } : IDLE)
    },
    dispose() { disposed = true; generation++; active?.abort.abort(); active = null; snapshot = IDLE; listeners.clear() },
  }
}
