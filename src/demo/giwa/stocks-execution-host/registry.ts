// Execution owners for the /stocks page. React-free: the page provider creates one registry per host
// identity (session, wallet address, chain, wallet epoch, captured wallet source, API base) and disposes it
// when that identity ends. Each accepted order gets one owner holding the clock, read adapter, submission
// gate, wallet ports and wallet controller for its whole life; nothing here is recreated on render, on a
// display tick, on an order status refresh or on an evidence renewal.
//
// Nothing in this file reads, signs or sends on creation. Evidence is read only by refreshEvidence(), which
// the panel calls as the first part of an explicit check.

import type { HostSession } from "../stocks-host/session"
import { createStocksWalletController } from "../stocks-wallet/controller"
import { StocksWalletError } from "../stocks-wallet/planner"
import type { ExecutionContext, ReviewedDeployment, Selection, Side, SubmissionGate, WalletPorts, WalletSnapshot } from "../stocks-wallet/types"
import { createExecutionClock, createStocksExecutionReads, type DeploymentEvidenceLease } from "../stocks-wallet-http"
import { createSubmissionGate } from "../stocks-wallet-submissions/client"
import { captureKnownHashes } from "../stocks-known-hash-recovery/capture"
import { KNOWN_HASH_CHAIN_ID, type KnownHashStore } from "../stocks-known-hash-recovery/store"
import { captureWalletSource, createWalletSourcePorts, type ActiveWalletSource, type CapturedWalletSource, type WalletSourceView } from "../stocks-wallet-source"

/** What the host shows right now. Read synchronously by every context() call, so a scope change is seen before any effect runs. */
export type ExecutionHostView = Readonly<{ session: HostSession | null; wallet: WalletSourceView; apiBase: string | null }>

export type ExecutionRegistryOptions = {
  view: () => ExecutionHostView
  /** The host's invalidate: only ever called with the session ID captured for the failing request. */
  invalidate: (capturedSessionId: string) => void
  fetch?: typeof globalThis.fetch
  /** Wall clock (default Date.now), wrapped in createExecutionClock. */
  now?: () => number
  /** One monotonic source for the reads, the gate, the clock and the controller (default performance.now). */
  monotonicNow?: () => number
  /** The wallet module's current active source; a capture stops being current when it changes. */
  activeSource?: () => ActiveWalletSource | null
  /**
   * Where a hash the original wallet request returned is kept when the owner's original gate cannot record it
   * (for example after its session expired). Without it, or without an origin, nothing is kept.
   */
  knownHashes?: KnownHashStore
  /** The frontend origin, part of a kept hash's owner scope. */
  origin?: string | null
}

export type ExecutionCapability = Readonly<{ status: "READY" }> | Readonly<{ status: "UNAVAILABLE"; code: string }>

export type ExecutionOwner = Readonly<{
  key: string
  /** The first row this identity saw for the order. Later rows are server status only. */
  selection: Selection
  controller: ReturnType<typeof createStocksWalletController>
  ports: WalletPorts
  /** Explicit evidence read; shares one in-flight read. Never retries, polls or runs on a timer. */
  refreshEvidence(): Promise<void>
  evidenceFailure(): string | null
  /** False once the owner's clock reported an impossible time: only a new owner (explicit restart) can check again. */
  healthy(): boolean
  /** A wallet request of this owner was open, answered or uncertain at some point. */
  recordedAttempt(): boolean
  subscribe(listener: () => void): () => void
  version(): number
}>

export type OwnerLookup = Readonly<{ owner: ExecutionOwner; code: null }> | Readonly<{ owner: null; code: string }>

export type ExecutionRegistry = Readonly<{
  key: string
  capability: ExecutionCapability
  disposed(): boolean
  ownerFor(side: Side, row: unknown): OwnerLookup
  hasOwner(side: Side, orderId: string): boolean
  /** This identity has seen the order (an owner exists or existed): its panel stays, also after an explicit restart. */
  hasPinned(side: Side, orderId: string): boolean
  /** Explicit restart after a clock failure: the order's owner is disposed and the next lookup creates a new one. */
  restart(owner: ExecutionOwner): void
  /** A disposed or live owner of this registry had an open, answered or uncertain wallet request. */
  recordedAttempt(): boolean
  dispose(): void
}>

const RECORDED: ReadonlySet<WalletSnapshot["status"]> = new Set(["SIGNING", "APPROVAL_SUBMITTED", "SUBMITTED", "UNKNOWN"])
const READY: ExecutionCapability = Object.freeze({ status: "READY" })
const unavailable = (code: string): ExecutionCapability => Object.freeze({ status: "UNAVAILABLE", code })

const sourceIds = new WeakMap<object, number>()
let lastSourceId = 0

/** A stable per-object number, so a replaced provider or client object is another identity even at the same address. */
function sourceIdentity(source: ActiveWalletSource | null): string {
  if (source === null) return "none"
  const identity = (object: unknown) => {
    if (object === null || (typeof object !== "object" && typeof object !== "function")) return "none"
    let id = sourceIds.get(object as object)
    if (id === undefined) {
      id = ++lastSourceId
      sourceIds.set(object as object, id)
    }
    return String(id)
  }
  return source.mode === "injected" ? `injected:${identity(source.provider)}` : `dynamic:${identity(source.client)}:${identity(source.rawProvider)}`
}

export function executionIdentityKey(view: ExecutionHostView): string {
  const wallet = view.wallet
  return JSON.stringify([view.session?.id ?? null, wallet.address?.toLowerCase() ?? null, wallet.chainId, wallet.epoch, sourceIdentity(wallet.source), view.apiBase])
}

function orderIdOf(row: unknown): string | null {
  const id = row !== null && typeof row === "object" ? (row as { id?: unknown }).id : null
  return typeof id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(id) ? id : null
}

function sameEvidence(a: ReviewedDeployment, b: ReviewedDeployment): boolean {
  return a.evidenceId === b.evidenceId && a.manifestDigest === b.manifestDigest && a.verifiedAt === b.verifiedAt && a.validUntil === b.validUntil
}

function capabilityOf(view: ExecutionHostView, capture: ReturnType<typeof captureWalletSource> | null): ExecutionCapability {
  if (view.apiBase === null) return unavailable("API_BASE_NOT_CONFIGURED")
  // A Dynamic client alone is retrying; only the explicitly selected raw extension can execute.
  if (view.wallet.source?.mode === "dynamic" && !view.wallet.source.rawProvider) return unavailable("WALLET_SOURCE_UNSUPPORTED")
  if (view.session === null) return unavailable("SESSION_REQUIRED")
  if (capture === null) return unavailable("WALLET_SOURCE_MISSING")
  if (capture.status !== "READY") return unavailable(capture.code)
  if (capture.source.address.toLowerCase() !== view.session.walletAddress.toLowerCase()) return unavailable("WALLET_MISMATCH")
  return READY
}

export function createExecutionRegistry(options: ExecutionRegistryOptions): ExecutionRegistry {
  const initial = options.view()
  const key = executionIdentityKey(initial)
  // No capture (and so no provider subscription) without a session and API base: nothing can run anyway.
  const capture = initial.apiBase !== null && initial.session !== null ? captureWalletSource(initial.wallet, { activeSource: options.activeSource }) : null
  const capability = capabilityOf(initial, capture)
  const source: CapturedWalletSource | null = capability.status === "READY" && capture?.status === "READY" ? capture.source : null
  const owners = new Map<string, ExecutionOwner & { dispose(): void }>()
  /** Pinned first rows, kept across an explicit restart of the same order's owner. */
  const pinned = new Map<string, unknown>()
  /** An order whose owner cannot be built stays unavailable for this identity (no rebuild on every render). */
  const failures = new Map<string, string>()
  let disposed = false
  let recorded = false

  function invalidate(capturedSessionId: string) {
    try {
      options.invalidate(capturedSessionId)
    } catch {
      /* A failing host notification never permits anything. */
    }
  }

  function createOwner(ownerKey: string, side: Side, row: unknown, session: HostSession, apiBase: string, captured: CapturedWalletSource): OwnerLookup {
    const orderId = orderIdOf(row)!
    const deploymentDigest = (row as { deploymentDigest?: unknown }).deploymentDigest
    const monotonicNow = options.monotonicNow ?? (() => performance.now())
    let clock: () => number
    let reads: ReturnType<typeof createStocksExecutionReads>
    let gate: SubmissionGate
    try {
      clock = createExecutionClock({ now: options.now, monotonicNow })
    } catch {
      return { owner: null, code: "EXECUTION_CLOCK_UNAVAILABLE" }
    }
    try {
      reads = createStocksExecutionReads({ apiBase, fetch: options.fetch, now: clock, monotonicNow, onSessionRejected: invalidate })
      const original = createSubmissionGate({ session, side, orderId, deploymentDigest: String(deploymentDigest), apiBase, walletAddress: captured.address, fetch: options.fetch, now: clock, monotonicNow, onSessionRejected: invalidate })
      // The controller keeps using this original gate (same session, same refusals); the wrapper only keeps a hash
      // the original wallet request returned when this gate could not record it.
      gate = options.knownHashes && options.origin
        ? captureKnownHashes(original, { side, orderId, deploymentDigest: String(deploymentDigest), wallet: captured.address, chainId: KNOWN_HASH_CHAIN_ID, apiBase, origin: options.origin }, options.knownHashes)
        : original
    } catch (error) {
      return { owner: null, code: error instanceof StocksWalletError ? error.code : "INVALID_ORDER" }
    }

    let lease: DeploymentEvidenceLease | null = null
    let evidenceFailure: string | null = null
    let ownerDisposed = false
    let ownerRecorded = false
    let version = 0
    let inflight: Promise<void> | null = null
    const aborts = new Set<AbortController>()
    const listeners = new Set<() => void>()
    const notify = () => {
      version++
      listeners.forEach((listener) => listener())
    }

    function context(): ExecutionContext {
      const live = options.view()
      return {
        // The owner's session only while the host still shows that exact session.
        session: live.session !== null && live.session.id === session.id ? live.session : null,
        walletAddress: live.wallet.address,
        chainId: live.wallet.chainId,
        walletEpoch: live.wallet.epoch,
        apiBase: live.apiBase ?? "",
        deployment: reads.currentDeployment(lease),
      }
    }

    const walletPorts = createWalletSourcePorts({ source: captured, deployment: () => context().deployment })
    const ports: WalletPorts = {
      context,
      now: clock,
      monotonicNow,
      readWallet: walletPorts.readWallet,
      readAllowance: walletPorts.readAllowance,
      requestTransaction: walletPorts.requestTransaction,
      waitApprovalReceipt: walletPorts.waitApprovalReceipt,
      readOrder: reads.readOrder,
      readCatalog: reads.readCatalog,
      readExecutionPolicy: reads.readExecutionPolicy,
      submissions: gate,
      invalidateSession: invalidate,
    }
    const controller = createStocksWalletController(ports)
    const selection: Selection = Object.freeze({ side, order: row })
    // The owner's controller always shows the pinned order; the panel's own select() of the same selection is a no-op.
    controller.select(selection)
    controller.subscribe(() => {
      // Remember (never forget) that a wallet request was open, answered or uncertain, for the session-end notice.
      const shown = controller.getSnapshot()
      if (RECORDED.has(shown.status) || shown.txHash !== null) {
        ownerRecorded = true
        recorded = true
      }
    })

    function refreshEvidence(): Promise<void> {
      if (ownerDisposed) return Promise.resolve()
      if (inflight) return inflight
      const live = options.view().session
      if (live === null || live.id !== session.id) return Promise.resolve()
      const abort = new AbortController()
      aborts.add(abort)
      const run = async () => {
        try {
          const next = await reads.readDeployment({ apiBase, token: live.accessToken, sessionId: live.id, signal: abort.signal, deploymentDigest: String(deploymentDigest) })
          // Ignore an answer for a scope the host has already left.
          if (ownerDisposed || abort.signal.aborted || options.view().session?.id !== next.sessionId || next.apiBase !== reads.apiBase) return
          evidenceFailure = null
          const current = reads.currentDeployment(lease)
          // The same cached evidence changes nothing: the current lease (and its window) is kept.
          if (current === null || !sameEvidence(current, next.deployment)) lease = next
        } catch (error) {
          if (!ownerDisposed && !abort.signal.aborted) {
            evidenceFailure = error instanceof StocksWalletError ? error.code : "REQUEST_FAILED"
            // The server no longer confirms the review: earlier evidence is not used for anything else.
            lease = null
          }
        } finally {
          aborts.delete(abort)
          inflight = null
          if (!ownerDisposed) notify()
        }
      }
      inflight = run()
      return inflight
    }

    const owner = {
      key: ownerKey,
      selection,
      controller,
      ports,
      refreshEvidence,
      evidenceFailure: () => evidenceFailure,
      healthy: () => !ownerDisposed && Number.isFinite(clock()),
      recordedAttempt: () => ownerRecorded,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      version: () => version,
      dispose() {
        ownerDisposed = true
        aborts.forEach((abort) => abort.abort())
        aborts.clear()
        listeners.clear()
        // Cannot close an open wallet prompt: its late answer still goes to this owner's gate, never to a new screen.
        controller.dispose()
      },
    }
    return { owner: Object.freeze(owner), code: null }
  }

  return Object.freeze({
    key,
    capability,
    disposed: () => disposed,
    ownerFor(side: Side, row: unknown): OwnerLookup {
      if (disposed) return { owner: null, code: "CONTEXT_CHANGED" }
      if (capability.status !== "READY" || source === null) return { owner: null, code: capability.status === "UNAVAILABLE" ? capability.code : "NOT_CONFIGURED" }
      if (side !== "BUY" && side !== "SELL") return { owner: null, code: "INVALID_SIDE" }
      const orderId = orderIdOf(row)
      if (orderId === null) return { owner: null, code: "INVALID_ORDER" }
      const ownerKey = `${side}:${orderId}`
      const existing = owners.get(ownerKey)
      if (existing) return { owner: existing, code: null }
      const failed = failures.get(ownerKey)
      if (failed !== undefined) return { owner: null, code: failed }
      if (!pinned.has(ownerKey)) pinned.set(ownerKey, structuredClone(row))
      const created = createOwner(ownerKey, side, pinned.get(ownerKey), initial.session!, initial.apiBase!, source)
      if (created.owner) owners.set(ownerKey, created.owner as ExecutionOwner & { dispose(): void })
      else failures.set(ownerKey, created.code)
      return created
    },
    hasOwner: (side: Side, orderId: string) => !disposed && owners.has(`${side}:${orderId}`),
    hasPinned: (side: Side, orderId: string) => !disposed && pinned.has(`${side}:${orderId}`),
    restart(owner: ExecutionOwner) {
      const existing = owners.get(owner.key)
      if (disposed || existing !== owner) return
      owners.delete(owner.key)
      existing.dispose()
    },
    recordedAttempt: () => recorded,
    dispose() {
      if (disposed) return
      disposed = true
      owners.forEach((owner) => owner.dispose())
      owners.clear()
      if (capture?.status === "READY") capture.source.dispose()
    },
  })
}
