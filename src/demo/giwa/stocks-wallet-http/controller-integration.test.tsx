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

type Hold = "policy" | "catalog" | "order" | "wallet" | "claim"

type WorldOptions = {
  /** Host passes createExecutionClock() as ports.now and the adapter clock (recommended), else the raw wall clock. */
  executionClock?: boolean
  /** Server policy lease; the real server grants at most 15 s. */
  policyLeaseMs?: number
  /** Answer like the real evidence port: the same cached evidence until its validUntil. */
  cachedEvidence?: boolean
  /** Independent review R1: the clock is created 60 s slow and corrected forward before any read. */
  correctedClock?: boolean
  /** Give the controller the fake monotonic clock (WalletPorts.monotonicNow); otherwise it uses performance.now(). */
  controllerMonotonic?: boolean
  /** Runs when the fake server receives an execution policy request, before it answers. */
  onPolicyRequest?: () => void
}

function world(side: Side, options: WorldOptions = {}) {
  const clock = clocks(options.correctedClock ? START - 60_000 : START)
  const now = options.executionClock ? createExecutionClock({ now: clock.now, monotonicNow: clock.monotonicNow }) : clock.now
  if (options.correctedClock) clock.setWall(START)
  const m = manifest()
  const selection: Selection = Object.freeze({ side, order: Object.freeze(orderRow(side)) })
  const host = {
    session: SESSION_A as HostSession | null,
    walletAddress: WALLET as string,
    epoch: "injected:1",
    apiBase: API,
    chainId: 91342,
    lease: null as DeploymentEvidenceLease | null,
    /** Test-only: a deployment object for another manifest, bypassing the adapter. */
    deploymentOverride: null as ExecutionContext["deployment"],
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
  let allowanceRead = false
  let walletReadsAfterAllowance = 0
  let afterAllowanceWalletRead: (index: number) => void = () => undefined
  let onAllowance: () => void = () => undefined
  let cached: ReturnType<typeof evidence> | null = null

  const context = (): ExecutionContext => ({ session: host.session, walletAddress: host.walletAddress, chainId: host.chainId, walletEpoch: host.epoch, apiBase: host.apiBase, deployment: host.deploymentOverride ?? reads.currentDeployment(host.lease) })
  // The fake server's own derivation: independent of whatever the host shows right now.
  const plan = () => planOrder(selection, { session: SESSION_A, walletAddress: WALLET, chainId: 91342, walletEpoch: "server", apiBase: API, deployment: evidence() as never }, START)
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
      options.onPolicyRequest?.()
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
      await gate("claim")
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
    ...(options.controllerMonotonic ? { monotonicNow: clock.monotonicNow } : {}),
    async readWallet() {
      // Hooks run before the hold gate, so a hook can hold the very read it observes.
      if (claimed) afterClaimWalletRead(++walletReadsAfterClaim)
      else if (allowanceRead) afterAllowanceWalletRead(++walletReadsAfterAllowance)
      await gate("wallet")
      return { address: host.walletAddress, chainId: 91342, connectionEpoch: host.epoch, deploymentDigest: DIGEST, networkInstance: m.networkInstance, checkpointHash: m.checkpointHash }
    },
    readOrder: reads.readOrder,
    readCatalog: reads.readCatalog,
    readExecutionPolicy: reads.readExecutionPolicy,
    async readAllowance(request) {
      allowanceRead = true
      onAllowance()
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
    onAllowanceRead(hook: () => void) {
      onAllowance = hook
    },
    /** Wallet read 1 after the allowance read belongs to that read; read 2 is send()'s own read just before the claim. */
    onWalletReadAfterAllowance(hook: (index: number) => void) {
      allowanceRead = false // count from the next allowance read only
      walletReadsAfterAllowance = 0
      afterAllowanceWalletRead = hook
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
    // 003A-1: the same order and account stay on screen with the late hash; nothing continues automatically.
    assert.deepEqual([w.snapshot().status, w.snapshot().txHash, w.snapshot().error], ["APPROVAL_SUBMITTED", sha256(toHex("late-approval")), "EXECUTION_AUTHORITY_CHANGED"])
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
    test(`${side} ${action}: the execution clock keeps a forward correction as its floor (independent review R1)`, async () => {
      // Only the helper protects this run: the controller gets no fake monotonic clock.
      const w = world(side, { executionClock: true, correctedClock: true, policyLeaseMs: 4_000 })
      try {
        await w.refreshEvidence()
        if (action === "submit") w.setAllowance("999999999999")
        await w.controller.prepare()
        assert.equal(w.snapshot().status, action === "approve" ? "APPROVAL_REQUIRED" : "READY_TRANSFER")
        // After the claim, wallet read 2 belongs to the final order re-read: 6 s pass, the wall clock nets +1 s.
        w.onWalletReadAfterClaim((index) => {
          if (index !== 2) return
          w.clock.advanceMonotonic(6_000)
          w.clock.setWall(w.clock.now() + 1_000)
        })
        await w.controller[action]()
        await flush()
        assert.equal(w.requests.length, 0, "the 4 s policy aged 6 s: no wallet request")
        assert.equal(w.claims(), 1)
        const stage = action === "approve" ? "APPROVAL" : "TRANSFER"
        assert.ok(w.journal.get(`${w.plan().intentKey}:${stage}`), "the consumed claim is kept")
        assert.deepEqual([w.snapshot().status, w.snapshot().error], ["UNKNOWN", "EXECUTION_POLICY_EXPIRED"])
      } finally {
        w.controller.dispose()
      }
    })

    test(`${side} ${action}: the controller bounds the execution policy by monotonic time even with a raw wall clock`, async () => {
      type Variant = "expires-before-claim" | "rollback-after-final-read" | "slow-policy-response" | "signing-subscriber" | "monotonic-nan" | "monotonic-regression" | "monotonic-regression-above-start" | "wall-regression-above-start" | "server-observed-before-request" | "long-policy-control"
      const variants: Variant[] = ["expires-before-claim", "rollback-after-final-read", "slow-policy-response", "signing-subscriber", "monotonic-nan", "monotonic-regression", "monotonic-regression-above-start", "wall-regression-above-start", "server-observed-before-request", "long-policy-control"]
      for (const variant of variants) {
        let delayPolicy = false
        const w = world(side, {
          controllerMonotonic: true,
          policyLeaseMs: variant === "long-policy-control" ? 15_000 : 4_000,
          // The policy response itself takes 3 s while the wall clock stalls.
          onPolicyRequest: () => {
            if (delayPolicy) w.clock.advanceMonotonic(3_000)
          },
        })
        let unsubscribe = () => {}
        try {
          await w.refreshEvidence()
          if (action === "submit") w.setAllowance("999999999999")
          await w.controller.prepare()
          delayPolicy = variant === "slow-policy-response"
          // The server's observedAt is 3 s before this client's request (its clock is behind, or the policy was
          // cached): only 1 s of the 4 s lease is really left.
          if (variant === "server-observed-before-request") w.answers.policy = (body) => ({ ...(body as object), observedAt: w.clock.now() - 3_000, validUntil: w.clock.now() + 1_000 })
          if (variant === "expires-before-claim") {
            w.onWalletReadAfterAllowance((index) => {
              if (index === 2) w.clock.advanceMonotonic(6_000)
            })
          } else if (variant === "signing-subscriber") {
            unsubscribe = w.controller.subscribe(() => {
              if (w.snapshot().status !== "SIGNING") return
              w.clock.advanceMonotonic(6_000)
              w.clock.setWall(w.clock.now() + 1_000)
            })
          } else if (variant === "monotonic-regression-above-start" || variant === "wall-regression-above-start") {
            // Time moves forward during the final order read, then a SIGNING subscriber steps a clock back to a
            // value still after the policy request start.
            w.onWalletReadAfterClaim((index) => {
              if (index !== 2) return
              w.clock.advanceMonotonic(3_900)
              if (variant === "wall-regression-above-start") w.clock.setWall(w.clock.now() + 3_000)
            })
            unsubscribe = w.controller.subscribe(() => {
              if (w.snapshot().status !== "SIGNING") return
              if (variant === "monotonic-regression-above-start") w.clock.setMonotonic(w.clock.monotonicNow() - 3_800)
              else w.clock.setWall(w.clock.now() - 2_000)
            })
          } else {
            w.onWalletReadAfterClaim((index) => {
              if (index !== 2) return
              if (variant === "rollback-after-final-read" || variant === "long-policy-control") {
                w.clock.advanceMonotonic(6_000)
                w.clock.setWall(w.clock.now() + 1_000)
              }
              if (variant === "slow-policy-response" || variant === "server-observed-before-request") w.clock.advanceMonotonic(2_000)
              if (variant === "monotonic-nan") w.clock.setMonotonic(Number.NaN)
              if (variant === "monotonic-regression") w.clock.setMonotonic(0)
            })
          }
          await w.controller[action]()
          await flush()
          unsubscribe()
          if (variant === "long-policy-control") {
            assert.equal(w.requests.length, 1, "control: a policy still inside its lease reaches the wallet once")
            continue
          }
          assert.equal(w.requests.length, 0, `${variant}: no wallet request after the policy's monotonic lifetime`)
          if (variant === "expires-before-claim") {
            // Refused before a new claim: nothing is reserved.
            assert.equal(w.claims(), 0, variant)
            assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "EXECUTION_POLICY_EXPIRED"], variant)
            continue
          }
          assert.equal(w.claims(), 1, variant)
          assert.equal(w.snapshot().status, "UNKNOWN", variant)
          assert.equal(w.journal.get(`${w.plan().intentKey}:${action === "approve" ? "APPROVAL" : "TRANSFER"}`)?.status, "REQUEST_MAY_START", `${variant}: refused before dispatch, no uncertain outcome recorded`)
          // A later allowed policy with fresh evidence never reopens the consumed claim or retries automatically.
          w.clock.setMonotonic(200_000)
          w.clock.advance(1)
          await w.refreshEvidence()
          await w.controller.prepare()
          await w.controller[action]()
          await flush()
          assert.equal(w.requests.length, 0, `${variant}: still no request`)
          assert.equal(w.snapshot().status, "UNKNOWN", variant)
        } finally {
          unsubscribe()
          w.controller.dispose()
        }
      }
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

// 003A-1 §3: the displayed attempt belongs to the session/wallet/epoch/chain/API/order/manifest identity; the short
// evidence and policy leases are execution authority only.
function holdPrompt(w: ReturnType<typeof world>) {
  const prompt = deferred<Hex>()
  const original = w.ports.requestTransaction
  w.ports.requestTransaction = async (transaction) => {
    w.requests.push(transaction)
    return prompt.promise
  }
  return { prompt, restore: () => (w.ports.requestTransaction = original) }
}

for (const side of ["BUY", "SELL"] as const) {
  for (const stage of ["APPROVAL", "TRANSFER"] as const) {
    for (const mode of ["expiry", "renewal"] as const) {
      test(`${side} ${stage}: evidence ${mode} while the wallet prompt is open keeps the attempt; the late hash is recorded and shown; nothing continues on its own`, async () => {
        const w = world(side)
        const late = sha256(toHex(`late-${side}-${stage}-${mode}`)) as Hex
        try {
          await w.refreshEvidence()
          if (stage === "TRANSFER") w.setAllowance("999999999999")
          await w.controller.prepare()
          const held = holdPrompt(w)
          const sending = stage === "APPROVAL" ? w.controller.approve() : w.controller.submit()
          await flush()
          assert.equal(w.snapshot().status, "SIGNING")
          assert.equal(w.requests.length, 1)

          if (mode === "expiry") w.clock.advance(15_000)
          else {
            w.clock.advance(1_000)
            await w.refreshEvidence()
          }
          assert.equal(!!w.reads.currentDeployment(w.host.lease), mode === "renewal")
          const open = w.snapshot()
          assert.deepEqual([open.status, open.stage], ["SIGNING", stage], "the open wallet prompt stays on screen")
          assert.ok(open.plan)

          held.prompt.resolve(late)
          await sending
          await flush()
          held.restore()
          const intent = w.plan().intentKey
          assert.equal(w.journal.get(`${intent}:${stage}`)?.txHash, late, "recorded through the original gate")
          const shown = w.snapshot()
          // Nothing ever follows a transfer, so only the approval carries the "did not continue" code.
          assert.deepEqual([shown.status, shown.txHash, shown.error], stage === "APPROVAL" ? ["APPROVAL_SUBMITTED", late, "EXECUTION_AUTHORITY_CHANGED"] : ["SUBMITTED", late, null])
          assert.equal(w.requests.length, 1)
          assert.ok(!w.seen.some((request) => request.path.endsWith("/reconcile")), "no automatic verification step toward READY_TRANSFER")

          // Recovery is an explicit check with current evidence; nothing is sent again.
          if (mode === "expiry") await w.refreshEvidence()
          await w.controller.prepare()
          await flush()
          assert.equal(w.snapshot().status, stage === "APPROVAL" ? "READY_TRANSFER" : "SUBMITTED")
          assert.equal(w.requests.length, 1)
        } finally {
          w.controller.dispose()
        }
      })
    }
  }
}

test("pre-signing work is stopped by evidence renewal or expiry, and a preserved screen is never permission", async () => {
  for (const mode of ["expiry", "renewal"] as const) {
    const w = world("BUY")
    try {
      await w.refreshEvidence()
      const release = w.hold("catalog")
      const checking = w.controller.prepare()
      await flush()
      assert.equal(w.snapshot().status, "CHECKING")
      if (mode === "expiry") w.clock.advance(15_000)
      else {
        w.clock.advance(1_000)
        await w.refreshEvidence()
      }
      release()
      await checking
      await flush()
      assert.equal(w.snapshot().status, "IDLE", `${mode}: the check was stopped`)

      await w.refreshEvidence()
      await w.controller.prepare()
      assert.equal(w.snapshot().status, "APPROVAL_REQUIRED")
      if (mode === "expiry") w.clock.advance(15_000)
      else {
        w.clock.advance(1_000)
        await w.refreshEvidence()
      }
      assert.equal(w.snapshot().status, "IDLE", `${mode}: an unrecorded ready state does not survive the authority change`)
      await w.controller.approve()
      assert.equal(w.requests.length, 0)
      assert.equal(w.claims(), 0)

      // Authority lost after the claim but before SIGNING: no request, the claim stays reserved and visible.
      await w.refreshEvidence()
      await w.controller.prepare()
      let releaseFinalRead: (() => void) | null = null
      w.onWalletReadAfterClaim((index) => {
        if (index !== 1) return
        if (mode === "expiry") w.clock.advance(15_000)
        else releaseFinalRead = w.hold("order") // hold the final order re-read that follows the claim
      })
      const approving = w.controller.approve()
      if (mode === "renewal") {
        for (let i = 0; i < 50 && releaseFinalRead === null; i++) await flush()
        w.clock.advance(1_000)
        await w.refreshEvidence()
        ;(releaseFinalRead as (() => void) | null)?.()
      }
      await approving
      await flush()
      assert.equal(w.requests.length, 0, `${mode}: no wallet request`)
      assert.equal(w.claims(), 1)
      assert.equal(w.journal.get(`${w.plan().intentKey}:APPROVAL`)?.status, "REQUEST_MAY_START")
      assert.deepEqual([w.snapshot().status, w.snapshot().stage], ["UNKNOWN", "APPROVAL"], `${mode}: the reserved claim stays on screen`)
    } finally {
      w.controller.dispose()
    }
  }
})

test("identity boundaries still isolate an open wallet prompt: its late hash is recorded but never painted into the new scope", async () => {
  type Boundary = "logout" | "session" | "aba" | "epoch" | "api" | "chain" | "manifest" | "order" | "dispose" | "cancel"
  const boundaries: Boundary[] = ["logout", "session", "aba", "epoch", "api", "chain", "manifest", "order", "dispose", "cancel"]
  for (const boundary of boundaries) {
    const w = world("BUY")
    const late = sha256(toHex(`boundary-${boundary}`)) as Hex
    try {
      await w.refreshEvidence()
      await w.controller.prepare()
      const held = holdPrompt(w)
      const sending = w.controller.approve()
      await flush()
      assert.equal(w.snapshot().status, "SIGNING", boundary)
      const intent = w.plan().intentKey
      if (boundary === "logout") w.host.session = null
      if (boundary === "session") w.host.session = { ...SESSION_A, id: "session-a-2" }
      if (boundary === "aba") {
        w.host.session = SESSION_B
        w.host.walletAddress = SESSION_B.walletAddress
        w.host.epoch = "injected:2"
        w.controller.refreshContext()
        w.host.session = SESSION_A
        w.host.walletAddress = WALLET
        w.host.epoch = "injected:3"
      }
      if (boundary === "epoch") w.host.epoch = "injected:2"
      if (boundary === "api") w.host.apiBase = "https://other-stocks-api.test"
      if (boundary === "chain") w.host.chainId = 1
      if (boundary === "manifest") {
        const other = { ...manifest(), deploymentId: "other-deployment-1" }
        w.host.deploymentOverride = { ...evidence({ verifiedAt: w.clock.now(), validUntil: w.clock.now() + 15_000 }), manifest: other, manifestDigest: "e".repeat(64) } as never
      }
      if (boundary === "order") w.controller.select({ side: "BUY", order: { ...orderRow("BUY"), id: "order-2" } })
      if (boundary === "dispose") w.controller.dispose()
      if (boundary === "cancel") w.controller.cancel()
      w.controller.refreshContext()
      held.prompt.resolve(late)
      await sending
      await flush()
      held.restore()
      assert.equal(w.journal.get(`${intent}:APPROVAL`)?.txHash, late, `${boundary}: recorded through the original gate`)
      assert.equal(w.requests.length, 1, boundary)
      const shown = w.snapshot()
      if (boundary === "cancel") assert.deepEqual([shown.status, shown.txHash], ["APPROVAL_SUBMITTED", late], "cancel keeps the same scope and shows the late hash")
      else {
        assert.equal(shown.txHash, null, `${boundary}: never painted into the new scope`)
        assert.equal(shown.plan, null, boundary)
      }
    } finally {
      w.controller.dispose()
    }
  }
})

test("prepare never shows a ready screen when the policy lease ends during the allowance read", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    const w = world(side, { controllerMonotonic: true, policyLeaseMs: 4_000 })
    try {
      await w.refreshEvidence()
      w.onAllowanceRead(() => w.clock.advanceMonotonic(5_000))
      await w.controller.prepare()
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "EXECUTION_POLICY_EXPIRED"], side)
    } finally {
      w.controller.dispose()
    }
  }
})

for (const side of ["BUY", "SELL"] as const) {
  test(`${side}: an approval answered after only its policy expired stops at the hash; an explicit check is required`, async () => {
    const w = world(side, { controllerMonotonic: true, policyLeaseMs: 4_000 })
    const late = sha256(toHex(`policy-only-${side}`)) as Hex
    try {
      await w.refreshEvidence()
      await w.controller.prepare()
      const held = holdPrompt(w)
      const approving = w.controller.approve()
      await flush()
      assert.equal(w.snapshot().status, "SIGNING")
      w.clock.advance(6_000)
      assert.ok(w.reads.currentDeployment(w.host.lease), "the evidence is still current: only the policy ended")
      held.prompt.resolve(late)
      await approving
      await flush()
      held.restore()
      assert.deepEqual([w.snapshot().status, w.snapshot().txHash, w.snapshot().error], ["APPROVAL_SUBMITTED", late, "EXECUTION_POLICY_EXPIRED"])
      assert.ok(!w.seen.some((request) => request.path.endsWith("/reconcile")), "no automatic verification toward READY_TRANSFER")
      await w.controller.prepare()
      await flush()
      assert.equal(w.snapshot().status, "READY_TRANSFER", "an explicit check with fresh reads recovers")
      assert.equal(w.requests.length, 1)
    } finally {
      w.controller.dispose()
    }
  })

  test(`${side}: authority lost while the claim or the wallet read after the approval hash is in flight is still shown`, async () => {
    for (const moment of ["claim-in-flight", "wallet-read-after-hash"] as const) {
      const w = world(side)
      try {
        await w.refreshEvidence()
        await w.controller.prepare()
        if (moment === "claim-in-flight") {
          const releaseClaim = w.hold("claim")
          const approving = w.controller.approve()
          for (let i = 0; i < 50 && !w.seen.some((request) => request.path.endsWith("/claims")); i++) await flush()
          w.clock.advance(1_000)
          await w.refreshEvidence() // renewed evidence while the claim request is outstanding
          assert.equal(w.snapshot().status, "IDLE")
          releaseClaim()
          await approving
          await flush()
          assert.equal(w.requests.length, 0)
          assert.equal(w.journal.get(`${w.plan().intentKey}:APPROVAL`)?.status, "REQUEST_MAY_START")
          assert.deepEqual([w.snapshot().status, w.snapshot().stage, w.snapshot().error], ["UNKNOWN", "APPROVAL", "EXECUTION_AUTHORITY_CHANGED"], moment)
        } else {
          let releaseRead: (() => void) | null = null
          // The first wallet read after the hash outcome was recorded is the follow-up read before verification.
          w.onWalletReadAfterClaim(() => {
            if (releaseRead === null && w.seen.some((request) => request.path.endsWith("/outcomes"))) releaseRead = w.hold("wallet")
          })
          const approving = w.controller.approve()
          for (let i = 0; i < 50 && releaseRead === null; i++) await flush()
          assert.ok(releaseRead, "the wallet read after the hash is held")
          w.clock.advance(1_000)
          await w.refreshEvidence()
          ;(releaseRead as unknown as () => void)()
          await approving
          await flush()
          const shown = w.snapshot()
          assert.deepEqual([shown.status, shown.error], ["APPROVAL_SUBMITTED", "EXECUTION_AUTHORITY_CHANGED"], moment)
          assert.ok(shown.txHash)
          assert.ok(!w.seen.some((request) => request.path.endsWith("/reconcile")))
          assert.equal(w.requests.length, 1)
        }
      } finally {
        w.controller.dispose()
      }
    }
  })
}

test("remounting a controller while the wallet prompt is open sends nothing twice and recovers only through an explicit check", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    for (const stage of ["APPROVAL", "TRANSFER"] as const) {
      const w = world(side)
      const late = sha256(toHex(`remount-${side}-${stage}`)) as Hex
      let second: ReturnType<typeof createStocksWalletController> | null = null
      try {
        await w.refreshEvidence()
        if (stage === "TRANSFER") w.setAllowance("999999999999")
        await w.controller.prepare()
        const held = holdPrompt(w)
        const sending = stage === "APPROVAL" ? w.controller.approve() : w.controller.submit()
        await flush()
        assert.equal(w.snapshot().status, "SIGNING")
        // The screen is remounted: the owner disposes the controller and builds a new gate and controller for the same scope.
        w.controller.dispose()
        second = createStocksWalletController({ ...w.ports, submissions: createSubmissionGate({ session: SESSION_A, side, orderId: ORDER_ID, deploymentDigest: DIGEST, apiBase: API, fetch: w.fetch as typeof globalThis.fetch, now: w.clock.now, monotonicNow: w.clock.monotonicNow }) })
        second.select(w.selection)
        await second.prepare()
        assert.deepEqual([second.getSnapshot().status, second.getSnapshot().txHash], ["UNKNOWN", null], "the new screen shows the reserved claim, no hash yet")
        await second.approve()
        await second.submit()
        assert.equal(w.requests.length, 1)
        held.prompt.resolve(late)
        await sending
        await flush()
        held.restore()
        assert.equal(w.journal.get(`${w.plan().intentKey}:${stage}`)?.txHash, late, "recorded through the original gate")
        assert.equal(second.getSnapshot().txHash, null, "the old controller never paints the new one")
        await second.prepare()
        await flush()
        assert.equal(second.getSnapshot().status, stage === "APPROVAL" ? "READY_TRANSFER" : "SUBMITTED")
        if (stage === "TRANSFER") assert.equal(second.getSnapshot().txHash, late)
        assert.equal(w.requests.length, 1)
        assert.equal(w.claims(), 1)
      } finally {
        second?.dispose()
        w.controller.dispose()
      }
    }
  }
})
