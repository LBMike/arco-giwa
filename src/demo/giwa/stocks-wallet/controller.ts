import { address, assertTransaction, canonical, digest, ensure, freeze, hash, integer, parseOrder, planOrder, record, StocksWalletError, validateContext } from "./planner"
import type { AttemptRecord, AuthenticatedRead, ExecutionContext, Plan, Selection, Stage, SubmissionGate, WalletPorts, WalletSnapshot } from "./types"

const IDLE: WalletSnapshot = Object.freeze({ status: "IDLE", orderId: null, intentKey: null, stage: null, txHash: null, error: null, plan: null })
type Attempt = {
  generation: number; scope: string; context: ExecutionContext; selection: Selection; plan: Plan; abort: AbortController; submissions: SubmissionGate; promise?: Promise<void>
  /** Digest of the execution context (session, wallet, evidence lease) this attempt was authorized under. */
  authority: string
  /** Set immediately before the wallet request: from then on the attempt must record and show its answer. */
  dispatched: boolean
  /** The authority changed or expired after dispatch: record and show the answer, but take no further step. */
  authorityLost: boolean
  /** Stopped by an authority change before dispatch; a claim that resolves afterwards is still shown. */
  fenced: boolean
  /** Highest wall-clock reading this attempt has seen: a later lower reading refuses the attempt. */
  wallHigh: number
}
/** An accepted execution policy: the server's validUntil plus a monotonic bound counted from before the request was sent. */
type PolicyLease = Readonly<{ validUntil: number; startedWall: number; startedMonotonic: number; monotonicUntil: number }>
/** Statuses that show a wallet request (open, answered or uncertain); they are never cleared by an authority change. */
const RECORDED: readonly WalletSnapshot["status"][] = ["SIGNING", "APPROVAL_SUBMITTED", "SUBMITTED", "UNKNOWN"]

/** Explicit actions only. No transport, wallet or persistence implementation is selected implicitly. */
export function createStocksWalletController(ports: WalletPorts) {
  const now = ports.now ?? Date.now
  const monotonicSource = ports.monotonicNow ?? (() => performance.now())
  let lastMonotonic = Number.NEGATIVE_INFINITY, monotonicBroken = false
  /** Monotonic readings never decrease. A non-finite or regressing reading breaks this controller's clock for good (NaN). */
  function monotonicNow() {
    if (monotonicBroken) return Number.NaN
    let value: number
    try { value = monotonicSource() } catch { value = Number.NaN }
    if (!Number.isFinite(value) || value < lastMonotonic) { monotonicBroken = true; return Number.NaN }
    lastMonotonic = value
    return value
  }
  /** Wall reading for time checks of an attempt: non-finite or lower than an earlier reading of the same attempt refuses it. */
  function observeWall(a: Attempt, code: string) {
    const wall = now()
    ensure(Number.isFinite(wall) && wall >= a.wallHigh, code)
    a.wallHigh = wall
    return wall
  }
  let selected: Selection | null = null
  let generation = 0, disposed = false
  let scope = ""
  let snapshot = IDLE
  /** Authority under which the displayed (unrecorded) snapshot was produced. */
  let snapshotAuthority = ""
  let identity = ""
  let retainedDeployment: string | null = null
  let active: Attempt | null = null
  const listeners = new Set<() => void>()
  // Never erase uncertain/submitted results just because the displayed scope changed.
  const attempted = new Map<string, AttemptRecord>()
  function notify() { listeners.forEach(fn => fn()) }
  function publish(value: WalletSnapshot) { snapshot = freeze(value); notify() }
  const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : value ?? null
  /**
   * What is on screen: session, wallet (address, chain, source epoch), API base, the accepted order and the reviewed
   * deployment identity (manifest digest). Short evidence and policy leases are deliberately not part of it. While
   * evidence is momentarily absent the last manifest digest seen for the same identity is kept; another manifest,
   * like any other identity change, is another scope.
   */
  function displayScope(context: ExecutionContext | null) {
    const session = context?.session
    const next = digest([session ? [session.id, lower(session.walletAddress), session.chainId] : null, context ? [lower(context.walletAddress), context.chainId, context.walletEpoch, context.apiBase] : null, selected])
    if (next !== identity) { identity = next; retainedDeployment = null }
    const manifestDigest = context?.deployment?.manifestDigest
    if (typeof manifestDigest === "string") retainedDeployment = manifestDigest
    return digest([identity, retainedDeployment])
  }
  /** Execution authority: the exact current context, only while it is valid now. Never display identity. */
  function authorityOf(context: ExecutionContext | null) {
    if (!context) return null
    try { validateContext(context, now()); return digest(context) } catch { return null }
  }
  const recorded = (value: WalletSnapshot) => value.txHash !== null || RECORDED.includes(value.status) || (value.status === "BLOCKED" && value.stage !== null)
  function knownState(plan: Plan, known: AttemptRecord, error: string): WalletSnapshot {
    const status = known.status === "REVERTED" ? "BLOCKED" : known.txHash ? known.stage === "APPROVAL" ? "APPROVAL_SUBMITTED" : "SUBMITTED" : "UNKNOWN"
    return { ...IDLE, status, plan, orderId: plan.order.id, intentKey: plan.intentKey, stage: known.stage, txHash: known.txHash ?? null, error }
  }
  function synchronize() {
    let context: ExecutionContext | null
    try { context = ports.context() } catch { context = null }
    let next: string
    try { next = displayScope(context) } catch { next = "invalid-context" }
    if (next !== scope) {
      scope = next; generation++; active?.abort.abort(); active = null; snapshot = IDLE; snapshotAuthority = ""
      queueMicrotask(() => { if (!disposed) notify() })
      return snapshot
    }
    if (!active && !snapshot.plan) return snapshot
    // Same identity on screen: check execution authority separately.
    const authority = authorityOf(context)
    let changed = false
    if (active && authority !== active.authority) {
      if (active.dispatched) active.authorityLost = true // The wallet already has the request: keep it visible.
      else {
        // Work before a new signature stops. A claim it already reserved stays visible and recovery-only.
        const stopped = active
        stopped.fenced = true
        generation++; stopped.abort.abort(); active = null; changed = true
        const known = attempted.get(`${stopped.plan.intentKey}:TRANSFER`) ?? attempted.get(`${stopped.plan.intentKey}:APPROVAL`)
        if (known) snapshot = freeze(knownState(stopped.plan, known, "EXECUTION_AUTHORITY_CHANGED"))
        else if (!recorded(snapshot)) snapshot = IDLE
      }
    } else if (!active && snapshot.plan && !recorded(snapshot) && authority !== snapshotAuthority) {
      // A ready or checking screen is never permission under another or an expired authority.
      snapshot = IDLE; changed = true
    }
    if (changed) queueMicrotask(() => { if (!disposed) notify() })
    return snapshot
  }
  function current(a: Attempt) { synchronize(); return !disposed && active === a && a.generation === generation && a.scope === scope && !a.abort.signal.aborted }
  function guard(a: Attempt) {
    ensure(current(a), "CONTEXT_CHANGED")
    ensure(!a.authorityLost, "EXECUTION_AUTHORITY_CHANGED")
    validateContext(ports.context(), now())
    ensure(now() < a.plan.deadline, "ORDER_EXPIRED")
  }
  function policyLive(a: Attempt, lease: PolicyLease) {
    const wall = observeWall(a, "EXECUTION_POLICY_EXPIRED"), mono = monotonicNow()
    ensure(Number.isFinite(mono) && wall >= lease.startedWall && mono >= lease.startedMonotonic && wall < lease.validUntil && mono < lease.monotonicUntil, "EXECUTION_POLICY_EXPIRED")
  }
  function policyAlive(a: Attempt, lease: PolicyLease) {
    try { policyLive(a, lease); return true } catch { return false }
  }
  async function bounded<T>(a: Attempt, work: () => Promise<T>): Promise<T> {
    guard(a)
    const start = observeWall(a, "READ_TIMEOUT"), startedMono = monotonicNow(); let timer: ReturnType<typeof setTimeout> | undefined
    ensure(Number.isFinite(startedMono), "READ_TIMEOUT")
    let onAbort = () => {}
    const stop = new Promise<never>((_, reject) => {
      onAbort = () => reject(new StocksWalletError("CONTEXT_CHANGED"))
      a.abort.signal.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(() => reject(new StocksWalletError("READ_TIMEOUT")), 15_000)
    })
    try {
      const value = await Promise.race([Promise.resolve().then(() => { guard(a); return work() }), stop])
      guard(a)
      const endWall = observeWall(a, "READ_TIMEOUT"), endMono = monotonicNow()
      ensure(Number.isFinite(endMono) && endWall - start < 15_000 && endMono >= startedMono && endMono - startedMono < 15_000, "READ_TIMEOUT"); return value
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
    if (!current(a)) return
    // An attempt that lost its authority after dispatch never publishes a new ready or checking screen.
    if (a.authorityLost && !RECORDED.includes(status) && !(status === "BLOCKED" && extra.stage)) throw new StocksWalletError("EXECUTION_AUTHORITY_CHANGED")
    snapshotAuthority = a.authority
    publish({ ...IDLE, status, plan: a.plan, orderId: a.plan.order.id, intentKey: a.plan.intentKey, ...extra })
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
  async function preflight(a: Attempt, recoverApproval = false): Promise<{ allowance: bigint; policy: PolicyLease }> {
    await wallet(a)
    const req = request(a)
    const response = record(await read(a, () => ports.readOrder(req)))
    ensure(response.profile === "DEMO_TESTNET" && response.valuePolicy === "TEST_VALUE_ONLY" && response.brokerMode === "MOCK_BROKER" && response.chainId === 91342 && response.priceSource === "FIXED_MOCK_PRICE", "ORDER_PROFILE_MISMATCH")
    freshResponse(response)
    const currentOrder = parseOrder({ side: a.plan.side, order: response.data })
    ensure(canonical(currentOrder) === canonical(a.plan.order), "ORDER_CHANGED")
    planOrder({ side: a.plan.side, order: currentOrder }, a.context, now())
    const catalog = record(await read(a, () => ports.readCatalog(req)))
    ensure(catalog.profile === "DEMO_TESTNET" && catalog.valuePolicy === "TEST_VALUE_ONLY" && catalog.brokerMode === "MOCK_BROKER" && catalog.chainId === 91342 && catalog.priceSource === "FIXED_MOCK_PRICE" && catalog.deploymentId === a.plan.order.deploymentId && catalog.cashSymbol === a.plan.cashSymbol && Array.isArray(catalog.instruments), "CATALOG_MISMATCH")
    freshResponse(catalog)
    const instruments = catalog.instruments.map(record)
    ensure(instruments.length === 1 && instruments[0]!.symbol === "NVDA" && instruments[0]!.quantityScale === 9 && typeof instruments[0]!.price === "string" && /^(0|[1-9]\d{0,9})\.\d{6}$/.test(instruments[0]!.price) && /[1-9]/.test(instruments[0]!.price) && instruments[0]!.priceSource === "FIXED_MOCK_PRICE" && instruments[0]!.orderCapability === "CHECK_PAUSE_AT_ORDER", "CAPABILITY_UNAVAILABLE")
    ensure(typeof ports.readExecutionPolicy === "function", "CURRENT_POLICY_REQUIRED")
    // The policy's lifetime is counted from before its request was sent, so neither request delay nor a stalled or
    // stepped-back wall clock re-grants the server's TTL at receipt.
    const startedWall = observeWall(a, "EXECUTION_POLICY_EXPIRED"), startedMonotonic = monotonicNow()
    ensure(Number.isFinite(startedMonotonic), "EXECUTION_POLICY_EXPIRED")
    const policy = await read(a, () => ports.readExecutionPolicy(req))
    ensure(policy?.allowed === true && policy.deploymentDigest === a.plan.manifestDigest && policy.orderId === a.plan.order.id && policy.side === a.plan.side && Number.isFinite(policy.observedAt) && Number.isFinite(policy.validUntil) && policy.observedAt <= now() && now() < policy.validUntil && policy.validUntil - policy.observedAt <= 15_000, "EXECUTION_NOT_ALLOWED")
    const lease: PolicyLease = Object.freeze({ validUntil: policy.validUntil, startedWall, startedMonotonic, monotonicUntil: startedMonotonic + Math.min(policy.validUntil - policy.observedAt, policy.validUntil - startedWall) })
    policyLive(a, lease)
    const journal = await inspect(a, recoverApproval)
    ensure(journal !== "blocked", "RECOVERY_REQUIRED")
    if (journal === "reconciled") return preflight(a) // New verification requires entirely fresh authorization reads.
    const allowance = integer(await read(a, () => ports.readAllowance({ token: a.plan.token, owner: a.plan.order.wallet, spender: a.plan.spender, chainId: 91342, signal: a.abort.signal })), true)
    policyLive(a, lease)
    ensure(allowance >= BigInt(a.plan.amount) || !attempted.has(`${a.plan.intentKey}:APPROVAL`), "ALLOWANCE_RECOVERY_REQUIRED")
    return { allowance, policy: lease }
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
  // An approval only unlocks the transfer through trusted server reconciliation. Without it on the
  // attempt's captured gate, no new APPROVAL claim or wallet request may start.
  function reconcilable(a: Attempt, stage: Stage) {
    if (stage === "APPROVAL") ensure(typeof a.submissions.reconcile === "function", "TRUSTED_RECONCILIATION_REQUIRED")
  }
  async function send(a: Attempt, stage: Stage, policy: PolicyLease) {
    const tx = stage === "APPROVAL" ? a.plan.approval : a.plan.transfer
    assertTransaction(tx, stage === "APPROVAL" ? planOrder(a.selection, a.context, now()).approval : planOrder(a.selection, a.context, now()).transfer)
    await wallet(a)
    const claim = await read(a, async () => {
      reconcilable(a, stage); policyLive(a, policy)
      const won = await a.submissions.claim({ intentKey: a.plan.intentKey, stage, transactionDigest: digest(tx), transaction: tx, orderId: a.plan.order.id, deploymentDigest: a.plan.manifestDigest })
      ensure(won, "SUBMISSION_ALREADY_CLAIMED"); validateRecord(won, a, stage)
      ensure(won.status === "REQUEST_MAY_START" && !won.txHash, "SUBMISSION_ALREADY_CLAIMED")
      // Remember the reserved claim as soon as it is won, even if the check that follows is stopped.
      attempted.set(`${a.plan.intentKey}:${stage}`, freeze(won))
      // Stopped by an authority change while this claim was in flight: still show the reserved claim on the same screen.
      if (a.fenced && !disposed && scope === a.scope && active === null && !recorded(snapshot)) publish(knownState(a.plan, won, "EXECUTION_AUTHORITY_CHANGED"))
      return won
    })
    // Claim/allowance reads can take time. Re-authorize the accepted order immediately before signing.
    const finalResponse = record(await read(a, () => ports.readOrder(request(a))))
    ensure(finalResponse.profile === "DEMO_TESTNET" && finalResponse.valuePolicy === "TEST_VALUE_ONLY" && finalResponse.brokerMode === "MOCK_BROKER" && finalResponse.chainId === 91342 && finalResponse.priceSource === "FIXED_MOCK_PRICE", "ORDER_PROFILE_MISMATCH")
    freshResponse(finalResponse)
    ensure(canonical(parseOrder({ side: a.plan.side, order: finalResponse.data })) === canonical(a.plan.order), "ORDER_CHANGED")
    guard(a); policyLive(a, policy); reconcilable(a, stage)
    state(a, "SIGNING", { stage })
    // SIGNING subscribers run synchronously and may remove ports, change the context or consume the policy's
    // remaining lifetime. Every refusal here happens before any wallet request, so the claim stays
    // REQUEST_MAY_START and no uncertain outcome is recorded.
    reconcilable(a, stage); guard(a); policyLive(a, policy)
    a.dispatched = true
    let result: unknown
    try { result = await ports.requestTransaction(tx) }
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
    // Receipt/hash is not Stocks order completion, and nothing ever follows a transfer automatically.
    if (stage === "TRANSFER") { state(a, "SUBMITTED", { stage, txHash }); return }
    // An approval answered after its authority changed or its policy ended continues nothing on its own: an explicit
    // check with fresh reads is required before the separate transfer step can be offered.
    if (a.authorityLost) { state(a, "APPROVAL_SUBMITTED", { stage, txHash, error: "EXECUTION_AUTHORITY_CHANGED" }); return }
    if (!policyAlive(a, policy)) { state(a, "APPROVAL_SUBMITTED", { stage, txHash, error: "EXECUTION_POLICY_EXPIRED" }); return }
    state(a, "APPROVAL_SUBMITTED", { stage, txHash })
    try { await wallet(a) } catch {
      if (current(a) && a.authorityLost) state(a, "APPROVAL_SUBMITTED", { stage, txHash, error: "EXECUTION_AUTHORITY_CHANGED" })
      return
    }
    if (!await reconcileApproval(a, submitted)) return
    const fresh = await preflight(a)
    ensure(fresh.allowance >= BigInt(a.plan.amount), "ALLOWANCE_NOT_CONFIRMED")
    state(a, "READY_TRANSFER") // Requires a separate explicit submit() click.
  }
  async function run(a: Attempt, action: "prepare" | "approve" | "submit" | "deposit") {
    try {
      if (!snapshot.txHash && !["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status)) state(a, "CHECKING")
      const fresh = await preflight(a, action === "prepare")
      if (action === "prepare") { state(a, fresh.allowance >= BigInt(a.plan.amount) ? "READY_TRANSFER" : "APPROVAL_REQUIRED"); return }
      if (action === "approve") {
        if (fresh.allowance >= BigInt(a.plan.amount)) { state(a, "READY_TRANSFER"); return }
        await send(a, "APPROVAL", fresh.policy)
      } else {
        // A one-click deposit (or escrow) has no approval step of its own: without the allowance it stops before any claim.
        ensure(fresh.allowance >= BigInt(a.plan.amount), action === "deposit" ? "ALLOWANCE_REQUIRED" : "ALLOWANCE_CHANGED")
        await send(a, "TRANSFER", fresh.policy)
      }
    } catch (error) {
      const status = error && typeof error === "object" ? (error as { status?: unknown }).status : null
      if (status === 401) { try { ports.invalidateSession?.(a.context.session!.id) } catch { /* Notification failure never permits signing. */ } }
      if (current(a)) {
        // Keep a known hash/uncertain state; an ordinary error must not turn it into a retry button.
        const known = attempted.get(`${a.plan.intentKey}:TRANSFER`) ?? attempted.get(`${a.plan.intentKey}:APPROVAL`)
        if (known) { const shown = knownState(a.plan, known, error instanceof StocksWalletError ? error.code : "REQUEST_FAILED"); state(a, shown.status, shown) }
        else if (snapshot.error !== "RECOVERY_REQUIRED") state(a, "BLOCKED", { error: error instanceof StocksWalletError ? error.code : status === 401 ? "SESSION_REJECTED" : "REQUEST_FAILED" })
      }
    } finally { if (active === a) active = null }
  }
  function start(action: "prepare" | "approve" | "submit" | "deposit"): Promise<void> {
    synchronize()
    if (disposed) return Promise.resolve()
    if (active?.promise) return active.promise
    try {
      ensure(selected, "ORDER_REQUIRED")
      if (action === "approve") ensure(snapshot.status === "APPROVAL_REQUIRED", "PREPARE_REQUIRED")
      if (action === "submit") ensure(snapshot.status === "READY_TRANSFER", "PREPARE_REQUIRED")
      const context = freeze(ports.context())
      const a: Attempt = { context, selection: selected, plan: planOrder(selected, context, now()), scope, generation, abort: new AbortController(), submissions: ports.submissions, authority: digest(context), dispatched: false, authorityLost: false, fenced: false, wallHigh: Number.NEGATIVE_INFINITY }
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
    /**
     * The one-click Buy (deposit) or Sell (escrow): the same full, fresh preflight as submit() and then the one wallet
     * request, without a separate prepare() step first. It never approves: an allowance given beforehand (the trade
     * panel's one-time approval) is required, and without it the attempt stops as ALLOWANCE_REQUIRED before any claim.
     */
    deposit: () => start("deposit"),
    cancel() {
      if (!active && (snapshot.txHash || ["SUBMITTED", "APPROVAL_SUBMITTED", "UNKNOWN"].includes(snapshot.status))) return
      const previous = active; generation++; active?.abort.abort(); active = null
      const known = previous && (attempted.get(`${previous.plan.intentKey}:TRANSFER`) ?? attempted.get(`${previous.plan.intentKey}:APPROVAL`))
      publish(previous && known ? knownState(previous.plan, known, "RECOVERY_REQUIRED") : IDLE)
    },
    dispose() { disposed = true; generation++; active?.abort.abort(); active = null; snapshot = IDLE; listeners.clear() },
  }
}
