// Real wallet controller + real submission gate (stocks-wallet-submissions) + this adapter, over an in-memory
// HTTP fake answering with server-shaped DTOs. No network, wallet, signature or chain: the wallet ports are
// explicit fakes that count requests.

import assert from "node:assert/strict"
import test from "node:test"
import { sha256, toHex, type Hex } from "viem"

import { createGiwaStocksHttpClient } from "../stocks-investor/client"
import { createStocksWalletController } from "../stocks-wallet/controller"
import { planOrder } from "../stocks-wallet/planner"
import type { AttemptRecord, ExecutionContext, Selection, Side, Transaction, WalletPorts } from "../stocks-wallet/types"
import type { HostSession } from "../stocks-host/session"
import { createSubmissionGate } from "../stocks-wallet-submissions/client"
import { createExecutionClock } from "./clock"
import { createStocksExecutionReads, type DeploymentEvidenceLease } from "./reads"
import { API, catalog, clocks, deferred, DIGEST, envelope, evidence, flush, json, manifest, ORDER_ID, orderRow, policy, START, TOKEN, WALLET } from "./test-support"

const SESSION_A: HostSession = Object.freeze({ id: "session-a", walletAddress: WALLET, chainId: 91342, accessToken: TOKEN, createdAt: START - 1_000, expiresAt: START + 900_000 })
const SESSION_B: HostSession = Object.freeze({ id: "session-b", walletAddress: "0x2222222222222222222222222222222222222222", chainId: 91342, accessToken: "other-header.other-payload.other-signature", createdAt: START - 1_000, expiresAt: START + 900_000 })

type Hold = "policy" | "catalog" | "order" | "wallet"

type WorldOptions = {
  /** Host passes createExecutionClock() as ports.now and the adapter clock (recommended), else the raw wall clock. */
  executionClock?: boolean
  /** Server policy lease; the real server grants at most 15 s. */
  policyLeaseMs?: number
  /** Answer like the real evidence port: the same cached evidence until its validUntil. */
  cachedEvidence?: boolean
}

function world(side: Side, options: WorldOptions = {}) {
  const clock = clocks()
  const now = options.executionClock ? createExecutionClock({ now: clock.now, monotonicNow: clock.monotonicNow }) : clock.now
  const m = manifest()
  const selection: Selection = Object.freeze({ side, order: Object.freeze(orderRow(side)) })
  const host = {
    session: SESSION_A as HostSession | null,
    walletAddress: WALLET as string,
    epoch: "injected:1",
    lease: null as DeploymentEvidenceLease | null,
    invalidations: [] as string[],
    invalidate(id: string) {
      this.invalidations.push(id)
      if (this.session?.id === id) this.session = null
    },
  }
  const journal = new Map<string, AttemptRecord>()
  const allowances = new Map<string, string>()
  const requests: Transaction[] = []
  const seen: { method: string; path: string; authorization: string | null }[] = []
  const held = new Map<Hold, ReturnType<typeof deferred<void>>>()
  const answers: { policy: (body: unknown) => unknown; status: Partial<Record<Hold, number>> } = { policy: (body) => body, status: {} }
  let claims = 0
  let hashes = 0
  let claimed = false
  let walletReadsAfterClaim = 0
  let afterClaimWalletRead: (index: number) => void = () => undefined
  let cached: ReturnType<typeof evidence> | null = null

  const context = (): ExecutionContext => ({ session: host.session, walletAddress: host.walletAddress, chainId: 91342, walletEpoch: host.epoch, apiBase: API, deployment: reads.currentDeployment(host.lease) })
  const plan = () => planOrder(selection, { ...context(), session: SESSION_A, walletAddress: WALLET, deployment: evidence() as never }, START)
  const allowanceKey = (owner: string, spender: string, token: string) => [owner, spender, token].map((value) => value.toLowerCase()).join(":")
  const tokens = new Set([SESSION_A.accessToken, SESSION_B.accessToken])

  async function gate(hold: Hold) {
    const wait = held.get(hold)
    if (wait) await wait.promise
  }

  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const target = new URL(url)
    const path = target.pathname
    const headers = (init.headers ?? {}) as Record<string, string>
    const authorization = headers.authorization ?? null
    seen.push({ method: init.method ?? "GET", path, authorization })
    if (path === "/api/v1/stocks/catalog") {
      await gate("catalog")
      if (answers.status.catalog) return json({ error: "BLOCKED_BY_PROXY" }, answers.status.catalog)
      return json(catalog(clock.now()))
    }
    if (!authorization || !tokens.has(authorization.replace(/^Bearer /, ""))) return json({ error: "UNAUTHORIZED" }, 401)
    if (path === "/api/v1/stocks/execution/deployment") {
      if (!options.cachedEvidence || !cached || clock.now() >= cached.validUntil) cached = evidence({ evidenceId: `evidence-${clock.now()}`, verifiedAt: clock.now(), validUntil: clock.now() + 15_000 })
      return json(envelope(cached, clock.now()))
    }
    if (path.startsWith("/api/v1/stocks/execution/")) {
      await gate("policy")
      if (answers.status.policy) return json({ error: "STOCKS_PAUSED" }, answers.status.policy)
      return json(envelope(answers.policy(policy(side, { observedAt: clock.now(), validUntil: clock.now() + (options.policyLeaseMs ?? 15_000) })), clock.now()))
    }
    if (path === `/api/v1/stocks/${side === "SELL" ? "sell-orders" : "orders"}/${ORDER_ID}`) {
      await gate("order")
      return json(envelope(orderRow(side), clock.now()))
    }
    const p = plan()
    if (path === `/api/v1/stocks/wallet-submissions/${side}/${ORDER_ID}`) {
      return json(envelope({ intentKey: p.intentKey, approval: journal.get(`${p.intentKey}:APPROVAL`) ?? null, transfer: journal.get(`${p.intentKey}:TRANSFER`) ?? null }, clock.now()))
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (path === "/api/v1/stocks/wallet-submissions/claims") {
      claims++
      claimed = true
      const key = `${body.intentKey}:${body.stage}`
      if (journal.has(key)) return json(envelope(null, clock.now()))
      const record: AttemptRecord = { claimId: `claim-${claims}`, intentKey: String(body.intentKey), stage: body.stage as AttemptRecord["stage"], transactionDigest: String(body.transactionDigest), status: "REQUEST_MAY_START" }
      journal.set(key, record)
      return json(envelope(record, clock.now()))
    }
    if (path === "/api/v1/stocks/wallet-submissions/outcomes") {
      const key = `${body.intentKey}:${body.stage}`
      const previous = journal.get(key)!
      const next = previous.txHash ? previous : ({ ...previous, status: body.status, ...(body.txHash ? { txHash: body.txHash } : {}) } as AttemptRecord)
      journal.set(key, next)
      return json(envelope(next, clock.now()))
    }
    if (path === "/api/v1/stocks/wallet-submissions/reconcile") {
      const key = `${body.intentKey}:${body.stage}`
      const confirmed: AttemptRecord = { ...journal.get(key)!, status: "CONFIRMED" }
      journal.set(key, confirmed)
      if (body.stage === "APPROVAL") allowances.set(allowanceKey(WALLET, p.spender, p.token), p.amount)
      return json(envelope(confirmed, clock.now()))
    }
    return json({ error: "NOT_FOUND" }, 404)
  }

  const reads = createStocksExecutionReads({ apiBase: API, fetch, now, monotonicNow: clock.monotonicNow, onSessionRejected: (id) => host.invalidate(id) })
  const ports: WalletPorts = {
    context,
    now,
    async readWallet() {
      await gate("wallet")
      if (claimed) afterClaimWalletRead(++walletReadsAfterClaim)
      return { address: host.walletAddress, chainId: 91342, connectionEpoch: host.epoch, deploymentDigest: DIGEST, networkInstance: m.networkInstance, checkpointHash: m.checkpointHash }
    },
    readOrder: reads.readOrder,
    readCatalog: reads.readCatalog,
    readExecutionPolicy: reads.readExecutionPolicy,
    async readAllowance(request) {
      return allowances.get(allowanceKey(request.owner, request.spender, request.token)) ?? "0"
    },
    async requestTransaction(transaction) {
      requests.push(transaction)
      return sha256(toHex(`integration-transaction-${++hashes}`)) as Hex
    },
    async waitApprovalReceipt() {
      throw new Error("legacy wallet receipt port is not used")
    },
    submissions: createSubmissionGate({ session: SESSION_A, side, orderId: ORDER_ID, deploymentDigest: DIGEST, apiBase: API, fetch: fetch as typeof globalThis.fetch, now, monotonicNow: clock.monotonicNow, onSessionRejected: (id) => host.invalidate(id) }),
    invalidateSession: (id) => host.invalidate(id),
  }
  const controller = createStocksWalletController(ports)
  controller.select(selection)

  return {
    clock,
    fetch,
    host,
    reads,
    ports,
    controller,
    selection,
    journal,
    requests,
    seen,
    answers,
    claims: () => claims,
    plan,
    setAllowance(value: string) {
      const p = plan()
      allowances.set(allowanceKey(WALLET, p.spender, p.token), value)
    },
    onWalletReadAfterClaim(hook: (index: number) => void) {
      afterClaimWalletRead = hook
    },
    hold(name: Hold) {
      const wait = deferred<void>()
      held.set(name, wait)
      return () => {
        held.delete(name)
        wait.resolve()
      }
    },
    /** Host step: explicit evidence read with the host session captured now; ignored if the scope changed meanwhile. */
    async refreshEvidence() {
      const session = host.session!
      const lease = await reads.readDeployment({ apiBase: API, token: session.accessToken, sessionId: session.id, signal: new AbortController().signal, deploymentDigest: DIGEST })
      if (host.session?.id === lease.sessionId && lease.apiBase === API) host.lease = lease
      controller.refreshContext()
      return lease
    },
    snapshot: () => controller.getSnapshot(),
  }
}

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: evidence read, check, exact approval, trusted reconciliation and a separate transfer over HTTP`, async () => {
    const w = world(side)
    try {
      assert.equal(w.seen.length, 0, "creating the adapter, gate and controller performs no request")
      await w.refreshEvidence()
      await w.controller.prepare()
      assert.equal(w.snapshot().status, "APPROVAL_REQUIRED", String(w.snapshot().error))
      assert.equal(w.requests.length, 0)
      await w.controller.approve()
      await flush()
      assert.equal(w.snapshot().status, "READY_TRANSFER", String(w.snapshot().error))
      assert.equal(w.requests.length, 1, "no automatic deposit/escrow")
      assert.deepEqual(w.requests[0], w.plan().approval)
      await w.controller.submit()
      await flush()
      assert.equal(w.snapshot().status, "SUBMITTED")
      assert.deepEqual(w.requests.map((tx) => tx.data), [w.plan().approval.data, w.plan().transfer.data])
      assert.equal(w.journal.get(`${w.plan().intentKey}:TRANSFER`)?.status, "SUBMITTED")
      // Every authenticated read carried the captured token; the public catalog carried none.
      for (const request of w.seen) {
        if (request.path === "/api/v1/stocks/catalog") assert.equal(request.authorization, null)
        else assert.equal(request.authorization, `Bearer ${TOKEN}`, request.path)
      }
      assert.ok(w.seen.some((request) => request.path === `/api/v1/stocks/execution/${side}/${ORDER_ID}`))
      assert.deepEqual(w.host.invalidations, [])
    } finally {
      w.controller.dispose()
    }
  })

  test(`${side}: PROFILE loss regression — the investor getOrder() result fails the controller, the adapter envelope passes`, async () => {
    const w = world(side)
    try {
      await w.refreshEvidence()
      const investor = createGiwaStocksHttpClient({ baseUrl: API, fetch: w.fetch })
      const readOrder = w.ports.readOrder
      w.ports.readOrder = (request) => investor.getOrder(request.side, request.orderId, request.token, request.signal)
      await w.controller.prepare()
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "ORDER_PROFILE_MISMATCH"])
      assert.equal(w.requests.length, 0)
      w.ports.readOrder = readOrder
      await w.controller.prepare()
      assert.equal(w.snapshot().status, "APPROVAL_REQUIRED")
    } finally {
      w.controller.dispose()
    }
  })
}

test("a late 401 for an account the host already left never signs out the new account or paints its screen", async () => {
  for (const synchronized of [true, false]) {
    const w = world("BUY")
    try {
      await w.refreshEvidence()
      const release = w.hold("policy")
      const checking = w.controller.prepare()
      await flush()
      assert.equal(w.snapshot().status, "CHECKING")
      // The host switches to account B; when synchronized the controller learns it before the answer.
      w.host.session = SESSION_B
      w.host.walletAddress = SESSION_B.walletAddress
      w.host.epoch = "injected:2"
      if (synchronized) w.controller.refreshContext()
      // The server now refuses A's token.
      w.answers.status.policy = 401
      release()
      await checking
      await flush()
      assert.equal(w.host.session?.id, "session-b", "B stays signed in")
      if (synchronized) assert.deepEqual(w.host.invalidations, [], "the aborted request's late answer is not even read")
      else {
        // Adapter callback and controller port both name the captured session; neither can touch B.
        assert.ok(w.host.invalidations.length >= 1, "the 401 was processed")
        assert.ok(w.host.invalidations.every((id) => id === "session-a"), `only A is invalidated: ${w.host.invalidations}`)
      }
      assert.equal(w.snapshot().plan, null, "no plan of A is painted for B")
      assert.equal(w.requests.length, 0)
    } finally {
      w.controller.dispose()
    }
  }
})

test("deployment evidence expiring during a check stops it; a refreshed lease never restarts or re-signs anything", async () => {
  const w = world("BUY")
  try {
    await w.refreshEvidence()
    const release = w.hold("catalog")
    const checking = w.controller.prepare()
    await flush()
    w.clock.advance(15_000)
    assert.equal(w.reads.currentDeployment(w.host.lease), null)
    release()
    await checking
    await flush()
    assert.notEqual(w.snapshot().status, "APPROVAL_REQUIRED")
    assert.equal(w.requests.length, 0)

    // Fresh evidence, explicit check, approval request left open while the evidence is refreshed again.
    await w.refreshEvidence()
    await w.controller.prepare()
    assert.equal(w.snapshot().status, "APPROVAL_REQUIRED")
    const prompt = deferred<Hex>()
    const request = w.ports.requestTransaction
    w.ports.requestTransaction = async (transaction) => {
      w.requests.push(transaction)
      return prompt.promise
    }
    const approving = w.controller.approve()
    await flush()
    assert.equal(w.requests.length, 1)
    w.clock.advance(1_000)
    await w.refreshEvidence()
    const seenBefore = w.seen.length
    prompt.resolve(sha256(toHex("late-approval")) as Hex)
    await approving
    await flush()
    w.ports.requestTransaction = request
    assert.equal(w.requests.length, 1, "no automatic re-approval or transfer after the refresh")
    assert.equal(w.snapshot().status, "IDLE", "the refreshed scope starts unchecked")
    assert.equal(w.journal.get(`${w.plan().intentKey}:APPROVAL`)?.txHash, sha256(toHex("late-approval")), "the late hash is kept on the original claim")
    assert.ok(w.seen.slice(seenBefore).every((request) => request.path === "/api/v1/stocks/wallet-submissions/outcomes"), "only the original claim's outcome was recorded")
    // Recovery is an explicit, read-only check.
    await w.controller.prepare()
    await flush()
    assert.equal(w.requests.length, 1)
    assert.ok(["READY_TRANSFER", "APPROVAL_SUBMITTED"].includes(w.snapshot().status), w.snapshot().status)
  } finally {
    w.controller.dispose()
  }
})

test("cross-deployment policy, paused policy and an unreachable policy route all block before any claim or wallet request", async () => {
  for (const variant of ["other-deployment", "other-order", "paused", "route-missing"] as const) {
    const w = world("SELL")
    try {
      await w.refreshEvidence()
      if (variant === "other-deployment") w.answers.policy = (body) => ({ ...(body as object), deploymentDigest: "e".repeat(64) })
      if (variant === "other-order") w.answers.policy = (body) => ({ ...(body as object), orderId: "order-2" })
      if (variant === "paused") w.answers.status.policy = 503
      if (variant === "route-missing") w.answers.status.policy = 404
      await w.controller.prepare()
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "EXECUTION_NOT_ALLOWED"], variant)
      assert.equal(w.claims(), 0)
      assert.equal(w.requests.length, 0)
    } finally {
      w.controller.dispose()
    }
  }
})

test("a 401 from the public catalog (for example a proxy) blocks the check but signs nobody out", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const w = world(side)
    try {
      await w.refreshEvidence()
      w.answers.status.catalog = 401
      await w.controller.prepare()
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "REQUEST_FAILED"])
      assert.deepEqual(w.host.invalidations, [], "neither the adapter nor the controller invalidates the session")
      assert.equal(w.host.session?.id, "session-a")
      assert.equal(w.requests.length, 0)
    } finally {
      w.controller.dispose()
    }
  }
})

for (const side of ["BUY", "SELL"] as const) {
  for (const action of ["approve", "submit"] as const) {
    test(`${side} ${action}: a wall clock stepped back after the final order read cannot stretch a 4 s policy past its lease (createExecutionClock)`, async () => {
      const outcomes: Record<string, { requests: number; status: string; error: string | null }> = {}
      for (const executionClock of [false, true]) {
        const w = world(side, { executionClock, policyLeaseMs: 4_000 })
        try {
          await w.refreshEvidence()
          if (action === "submit") w.setAllowance("999999999999")
          await w.controller.prepare()
          assert.equal(w.snapshot().status, action === "approve" ? "APPROVAL_REQUIRED" : "READY_TRANSFER")
          // After the claim: wallet read 1 belongs to the claim read, read 2 to the final order re-read. During
          // read 2, 6 s pass while the wall clock is stepped back 5 s (net +1 s, still after the read started).
          w.onWalletReadAfterClaim((index) => {
            if (index !== 2) return
            w.clock.advanceMonotonic(6_000)
            w.clock.setWall(w.clock.now() + 1_000)
          })
          await w.controller[action]()
          await flush()
          outcomes[String(executionClock)] = { requests: w.requests.length, status: w.snapshot().status, error: w.snapshot().error }
        } finally {
          w.controller.dispose()
        }
      }
      // Control: with the raw wall clock the unchanged controller still dispatches (its policy check is wall-clock
      // only; see README). This proves the scenario really exercises the rollback.
      assert.equal(outcomes.false!.requests, 1, JSON.stringify(outcomes))
      // With the recommended host clock the policy has expired by monotonic time: no wallet request.
      assert.deepEqual(outcomes.true, { requests: 0, status: "UNKNOWN", error: "EXECUTION_POLICY_EXPIRED" })
    })
  }
}

test("refreshing evidence that the server still caches changes nothing: the check in progress continues", async () => {
  const w = world("BUY", { cachedEvidence: true })
  try {
    const first = await w.refreshEvidence()
    const release = w.hold("catalog")
    const checking = w.controller.prepare()
    await flush()
    w.clock.advance(1_000)
    const again = await w.refreshEvidence()
    assert.deepEqual(again.deployment, first.deployment, "the real evidence port returns the same cached evidence")
    release()
    await checking
    await flush()
    assert.equal(w.snapshot().status, "APPROVAL_REQUIRED", "same evidence, same controller scope: not cancelled")
    // Once the cached evidence has ended, the next read is new evidence and does change the scope.
    w.clock.advance(14_000)
    assert.equal(w.reads.currentDeployment(w.host.lease), null)
    assert.equal(w.snapshot().status, "IDLE")
    const renewed = await w.refreshEvidence()
    assert.notEqual(renewed.deployment.evidenceId, first.deployment.evidenceId)
    assert.equal(w.snapshot().status, "IDLE")
    assert.equal(w.requests.length, 0)
  } finally {
    w.controller.dispose()
  }
})
