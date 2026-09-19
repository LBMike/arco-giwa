// Framework-independent state for the operator trading control panel (consumed via useSyncExternalStore).
//
// Guarantees:
// - Scope is (apiBase, session.id, deploymentKey), like the admin console. A scope change aborts every request,
//   including a command in flight, bumps the generation and clears everything: a late answer never lands on another
//   session and a command is never resent there. A token-only change keeps data and a pending command.
// - Reads: control state, runtime diagnostic and history pages; only the latest request per resource writes.
//   GET 401/403 clear the panel (access denied). A control 404 (no code) means the feature is not enabled.
// - A command can start only from a successful, current control read that the operator reviewed. It is frozen with a
//   fresh idempotency key and sent once; double clicks are ignored while it is in flight. A retry resends the
//   identical command and key. Nothing ever changes expectedVersion and resends by itself.
// - Only a verified 2xx proves the command's event. 409 version conflict re-reads and waits for a new command (on a
//   retry too: the server checks the key before the version, so it proves the key was never recorded on the deployment
//   that answered, which the 409 does not name; it stays unresolved unless a read taken after it shows the command's own
//   deployment and none showed another). A first attempt
//   refused with 400/401/403/404/idempotency conflict changed nothing. Anything else (503, 5xx, network, timeout,
//   invalid 200), and any refusal of a retry, is unknown: the earlier attempt may or may not have been recorded.
// - Every control value carries an order mark (the read's request sequence, or the POST answer's). A read started before
//   the shown value never replaces it; a POST answer never replaces a newer state of the same deployment, nor a state of
//   another deployment (that one is read again instead).
// - After an unknown outcome a retry needs a successful control read started after it, of the same deployment (keys are
//   deployment-scoped). An unresolved command (unknown, or an unresolved retry conflict) is never dropped silently:
//   discarding it, replacing it with a new command, or an access denial keeps it as an unresolved note.
// - History is confirmed against the shown control state whenever either one arrives: every entry is that deployment's
//   and the list is at least as new as its version. A history of another deployment is cleared (entries, pages, cursor)
//   and its first page read again, once per control state; an older list is read again. Unconfirmed entries are not
//   shown as this deployment's.
import { scopeKeyOf } from "../stocks-admin/store"
import type { StocksAdminError } from "../stocks-admin/types"
import { newIdempotencyKey, readRuntimeStatus, readTradingControl, readTradingControlHistory, sendTradingControlCommand } from "./client"
import { IDEMPOTENCY_KEY, MAX_VERSION, checkReason } from "./parse"
import type {
  AbandonedCommand,
  CommandPhase,
  CommandState,
  HistoryState,
  ResourceState,
  StocksAdminFetch,
  StocksAdminSession,
  TradingControlAccess,
  TradingControlSnapshot,
} from "./types"

export type TradingControlStoreConfig = {
  readonly apiBase: string
  readonly session: StocksAdminSession | null
  readonly deploymentKey?: string
  readonly fetch?: StocksAdminFetch
  readonly now?: () => number
  readonly newIdempotencyKey?: () => string
  readonly commandTimeoutMs?: number
}

export { scopeKeyOf }

export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000

const IDLE = Object.freeze({ phase: "idle", value: null, error: null }) as ResourceState<never>
const EMPTY_HISTORY: HistoryState = Object.freeze({ phase: "idle", items: [], nextBeforeVersion: null, complete: false, observedAt: null, error: null, failedPage: null, deploymentDigest: null })

function emptySnapshot(scopeKey: string, access: TradingControlAccess, abandoned: AbandonedCommand | null = null): TradingControlSnapshot {
  return { scopeKey, access, control: IDLE, runtime: IDLE, history: EMPTY_HISTORY, command: null, abandoned, controlReadSeq: null }
}

type ReadKey = "control" | "runtime" | "history"

/**
 * How a history list relates to a control state: all entries of that deployment and at least as new as its version
 * ("current"), of that deployment but older ("stale"), not of that deployment ("other"), or nothing read yet ("none").
 * Entries carry no key, so a list says nothing about who recorded them. An empty, complete list fits only version 0.
 */
export function historyFit(history: Pick<HistoryState, "items" | "complete">, control: { readonly deploymentDigest: string; readonly version: number }): "current" | "stale" | "other" | "none" {
  const newest = history.items[0]
  if (newest === undefined) return !history.complete ? "none" : control.version === 0 ? "current" : "stale"
  if (history.items.some((item) => item.deploymentDigest !== control.deploymentDigest)) return "other"
  return newest.version >= control.version ? "current" : "stale"
}

/** "Load older" continues a list that was read successfully, or retries an older page that failed. */
export function canLoadOlder(history: HistoryState): boolean {
  if (history.complete || history.nextBeforeVersion === null) return false
  return history.phase === "ready" || (history.phase === "error" && history.failedPage === "older")
}

/** Why a start request was refused locally (nothing was sent). */
export type StartRefusal = "not_ready" | "busy" | "read_first" | "stale_review" | "invalid_reason" | "version_limit" | "invalid_key"
/** Why a retry was refused locally (nothing was sent). */
export type RetryRefusal = "not_unknown" | "not_retryable" | "read_first" | "deployment_changed"

/**
 * The outcome of one attempt that did not return a verified event. `attempt` is 1 for the first send; a refusal of a
 * later attempt only proves that this attempt changed nothing, so the command stays unknown.
 */
export function commandPhaseOf(error: StocksAdminError, timedOut: boolean, attempt = 1): Exclude<CommandPhase, "sending" | "accepted" | "replayed"> {
  if (timedOut) return "unknown"
  // The service looks the key up (per deployment) before it compares versions: a version conflict proves this key was
  // never recorded on the deployment that answered.
  if (error.kind === "request" && error.status === 409 && error.code === "CONTROL_VERSION_CONFLICT") return "conflict"
  if (attempt > 1) return "unknown"
  switch (error.kind) {
    case "forbidden":
    case "unauthorized":
    case "disabled":
    case "configuration":
    case "unauthenticated":
      return "rejected"
    case "request":
      if (error.status === 409 && error.code === "CONTROL_IDEMPOTENCY_CONFLICT") return "rejected"
      if (error.status === 400) return "rejected"
      return "unknown"
    default:
      // server (5xx incl. 503), network, invalid, aborted by timeout: no verifiable answer.
      return "unknown"
  }
}

export class TradingControlStore {
  private config: TradingControlStoreConfig
  private snapshot: TradingControlSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly controllers = new Map<ReadKey, AbortController>()
  private readonly latest = new Map<ReadKey, number>()
  private generation = 0
  private sequence = 0
  private active = true
  private commandController: AbortController | null = null
  private commandTimer: ReturnType<typeof setTimeout> | null = null
  private commandSequence = 0
  /** Which history page the latest history read asks for. */
  private historyPage: "first" | "older" | null = null
  /** The control mark for which the first history page was already read again after a mismatch (at most once each). */
  private historyRecheckMark: number | null = null

  constructor(config: TradingControlStoreConfig) {
    this.config = config
    this.snapshot = emptySnapshot(scopeKeyOf(config), config.session ? "ok" : "signed_out")
  }

  readonly getSnapshot = (): TradingControlSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A token-only change keeps data (and a pending command); a scope change resets everything. */
  configure(config: TradingControlStoreConfig): void {
    this.config = config
    const scopeKey = scopeKeyOf(config)
    if (scopeKey !== this.snapshot.scopeKey) this.reset(scopeKey, config.session ? "ok" : "signed_out")
  }

  activate(): void {
    if (this.active) return
    this.active = true
    this.reset(scopeKeyOf(this.config), this.config.session ? "ok" : "signed_out")
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.generation += 1
    this.abortAll()
  }

  /** Reads the control state, the runtime diagnostic and the newest history page. */
  refresh(): void {
    this.loadControl()
    this.loadRuntime()
    this.loadHistory(null)
  }

  loadControl(): void {
    if (!this.active || this.snapshot.access !== "ok") return
    const generation = this.generation
    const { sequence, signal } = this.begin("control")
    this.write({ control: { phase: "loading", value: this.snapshot.control.value, error: null } })
    void readTradingControl(this.request(signal)).then((result) => {
      if (!this.isLatest("control", generation, sequence)) return
      this.controllers.delete("control")
      if (result.ok) {
        const shown = this.snapshot.controlReadSeq
        let mark = sequence
        if (shown !== null && sequence < shown) {
          // Started before the shown value (a POST answer). It is still newer if it shows the same deployment at a higher
          // version (versions only increase); a read of another deployment is repeated; anything else is older.
          const current = this.snapshot.control.value?.data
          if (current && result.data.deploymentDigest !== current.deploymentDigest) return this.loadControl()
          if (!current || result.data.version <= current.version) return
          mark = ++this.sequence
        }
        this.write({ control: { phase: "ready", value: { data: result.data, meta: result.meta, loadedAt: this.now() }, error: null }, controlReadSeq: mark })
        // After a retry's version conflict, a read of another deployment means the 409 may have come from there, for good.
        const command = this.snapshot.command
        if (command?.phase === "conflict" && command.attempts > 1 && !command.otherDeploymentSeen && result.data.deploymentDigest !== command.basis.deploymentDigest) {
          this.write({ command: { ...command, otherDeploymentSeen: true } })
        }
        this.revalidateHistory()
      } else if (!this.denyOnAccessError(result.error)) {
        const shown = this.snapshot.controlReadSeq
        if (shown !== null && sequence < shown) return
        this.write({ control: { phase: "error", value: this.snapshot.control.value, error: result.error } })
      }
    })
  }

  loadRuntime(): void {
    if (!this.active || this.snapshot.access !== "ok") return
    const generation = this.generation
    const { sequence, signal } = this.begin("runtime")
    this.write({ runtime: { phase: "loading", value: this.snapshot.runtime.value, error: null } })
    void readRuntimeStatus(this.request(signal)).then((result) => {
      if (!this.isLatest("runtime", generation, sequence)) return
      this.controllers.delete("runtime")
      if (result.ok) this.write({ runtime: { phase: "ready", value: { data: result.data, meta: result.meta, loadedAt: this.now() }, error: null } })
      else if (!this.denyOnAccessError(result.error)) this.write({ runtime: { phase: "error", value: this.snapshot.runtime.value, error: result.error } })
    })
  }

  /** The newest page (null) or the page before `beforeVersion` ("load older"). */
  loadHistory(beforeVersion: number | null): void {
    if (!this.active || this.snapshot.access !== "ok") return
    const history = this.snapshot.history
    if (beforeVersion !== null && (!canLoadOlder(history) || history.nextBeforeVersion !== beforeVersion)) return
    const generation = this.generation
    const { sequence, signal } = this.begin("history")
    this.historyPage = beforeVersion === null ? "first" : "older"
    this.write({ history: { ...history, phase: "loading", error: null, failedPage: null } })
    void readTradingControlHistory({ ...this.request(signal), beforeVersion }).then((result) => {
      if (!this.isLatest("history", generation, sequence)) return
      this.controllers.delete("history")
      const current = this.snapshot.history
      if (result.ok) {
        const page = result.data
        const older = beforeVersion !== null
        const invalid = () => this.write({ history: { ...current, phase: "error", error: { kind: "invalid", status: 200, code: null }, failedPage: older ? "older" : "first" } })
        // One page is one deployment's (the parser checks it); an older page continues the list (and so its deployment).
        const last = current.items[current.items.length - 1]
        if (older && (last === undefined || !page.items.every((item) => item.version < last.version && item.deploymentDigest === last.deploymentDigest))) return invalid()
        const control = this.snapshot.control.value?.data
        let confirmed = current.deploymentDigest
        if (!older) {
          confirmed = null
          if (control) {
            // A first page must be the shown deployment's and at least as new as its state. If not, it is never shown:
            // read again once for this control state (the answer may predate a change), then report it.
            if (historyFit({ items: page.items, complete: page.nextBeforeVersion === null }, control) !== "current") {
              if (this.historyRecheckMark === this.snapshot.controlReadSeq) return invalid()
              this.write({ history: { ...(current.deploymentDigest === control.deploymentDigest ? current : EMPTY_HISTORY), phase: "loading", error: null, failedPage: null } })
              return this.recheckHistory()
            }
            confirmed = control.deploymentDigest
          }
        }
        this.write({
          history: {
            phase: "ready",
            items: older ? [...current.items, ...page.items] : page.items,
            nextBeforeVersion: page.nextBeforeVersion,
            complete: page.nextBeforeVersion === null,
            // "Newest page read at": an older page does not re-read the newest one.
            observedAt: older ? current.observedAt : result.meta.observedAt,
            error: null,
            failedPage: null,
            deploymentDigest: confirmed,
          },
        })
      } else if (!this.denyOnAccessError(result.error)) {
        this.write({ history: { ...current, phase: "error", error: result.error, failedPage: beforeVersion === null ? "first" : "older" } })
      }
    })
  }

  /**
   * Freezes and sends one new command, based on the state the operator reviewed. Returns why it was refused
   * locally (nothing sent), or null when it was sent.
   */
  start(input: { readonly paused: boolean; readonly reason: string; readonly reviewed: { readonly version: number; readonly paused: boolean; readonly observedAt: string } }): StartRefusal | null {
    const control = this.snapshot.control
    if (!this.active || this.snapshot.access !== "ok" || control.phase !== "ready" || control.error !== null || control.value === null) return "not_ready"
    const phase = this.snapshot.command?.phase
    if (phase === "sending" || phase === "unknown") return "busy"
    // A state read before an unresolved command may be outdated: read again first.
    if (readBeforeUnresolved(this.snapshot)) return "read_first"
    const state = control.value.data
    // The operator confirmed what they reviewed; if the shown state has moved since, they must review again.
    if (state.version !== input.reviewed.version || state.paused !== input.reviewed.paused || control.value.meta.observedAt !== input.reviewed.observedAt) return "stale_review"
    const reason = checkReason(input.reason)
    if (!reason.ok || reason.reason !== input.reason) return "invalid_reason"
    if (state.version >= MAX_VERSION) return "version_limit"
    const idempotencyKey = (this.config.newIdempotencyKey ?? newIdempotencyKey)()
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return "invalid_key"
    // A retry conflict that is still unresolved is kept as a note, never replaced silently.
    const previous = this.snapshot.command
    const abandoned = previous && unresolvedOnClose(this.snapshot, previous) ? abandonedOf(previous, previous.unknownSeq ?? ++this.sequence) : this.snapshot.abandoned
    this.write({
      abandoned,
      command: {
        phase: "sending",
        command: Object.freeze({ paused: input.paused, expectedVersion: state.version, idempotencyKey, reason: reason.reason }),
        basis: { paused: state.paused, version: state.version, observedAt: control.value.meta.observedAt, deploymentDigest: state.deploymentDigest },
        attempts: 0,
        result: null,
        error: null,
        timedOut: false,
        retryRefused: false,
        unknownSeq: null,
        otherDeploymentSeen: false,
      },
    })
    this.send()
    return null
  }

  /**
   * Resends the identical command with the same key. Only for an unknown outcome, and only while the server serves the
   * deployment the command was reviewed for: on another deployment the key is unknown and it would be a new command.
   */
  retry(): RetryRefusal | null {
    if (!this.active) return "not_unknown"
    const refusal = retryReadiness(this.snapshot)
    if (refusal !== null) return refusal
    this.send()
    return null
  }

  /**
   * Closes the command panel. A command in flight cannot be discarded (its answer is awaited). An unresolved command
   * (see unresolvedOnClose) stays as an unresolved note (it may have been recorded) and the state is read again.
   */
  discard(): boolean {
    const command = this.snapshot.command
    if (!command || command.phase === "sending") return false
    if (unresolvedOnClose(this.snapshot, command)) {
      this.write({ command: null, abandoned: abandonedOf(command, command.unknownSeq ?? ++this.sequence) })
      this.refresh()
    } else this.write({ command: null })
    return true
  }

  /** Closes the notice about a command abandoned by an access denial. */
  dismissAbandoned(): void {
    if (this.snapshot.abandoned) this.write({ abandoned: null })
  }

  /** After 401/403: forget the denial and read again with the current props. */
  retryAccess(): void {
    if (!this.active) return
    this.reset(this.snapshot.scopeKey, this.config.session ? "ok" : "signed_out", this.snapshot.abandoned)
  }

  private send(): void {
    const current = this.snapshot.command
    if (!current) return
    const generation = this.generation
    const sequence = ++this.commandSequence
    this.clearCommandTransport()
    const controller = new AbortController()
    this.commandController = controller
    const frozen = current.command
    const attempt = current.attempts + 1
    this.commandTimer = setTimeout(() => {
      // No verified answer in time: unknown now, whatever the transport does later (its answer is ignored).
      if (!this.active || generation !== this.generation || sequence !== this.commandSequence) return
      this.commandSequence += 1
      controller.abort()
      this.clearCommandTransport()
      const command = this.snapshot.command
      if (command && command.command === frozen && command.phase === "sending") {
        this.write({ command: { ...command, phase: "unknown", result: null, error: { kind: "aborted", status: null, code: null }, timedOut: true, retryRefused: false, unknownSeq: ++this.sequence } })
      }
    }, this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
    this.write({ command: { ...current, phase: "sending", attempts: attempt, error: null, timedOut: false, retryRefused: false, unknownSeq: null } })
    void sendTradingControlCommand({ ...this.request(controller.signal), command: frozen }).then((result) => {
      if (!this.active || generation !== this.generation || sequence !== this.commandSequence) return
      this.clearCommandTransport()
      const command = this.snapshot.command
      if (!command || command.command !== frozen) return
      if (result.ok) {
        const shown = this.snapshot.control.value?.data
        const state = result.data.state
        // The response state becomes the current value, unless a newer state of the same deployment is already shown, or
        // the shown state belongs to another deployment (then that deployment is read again instead).
        const otherDeployment = shown !== undefined && shown.deploymentDigest !== state.deploymentDigest
        const newerShown = shown !== undefined && !otherDeployment && shown.version > state.version
        const keep = otherDeployment || newerShown
        this.write({
          command: { ...command, phase: result.data.replayed ? "replayed" : "accepted", result: { change: result.data, meta: result.meta }, error: null, timedOut: false, retryRefused: false, unknownSeq: null },
          ...(keep ? {} : { control: { phase: "ready" as const, value: { data: state, meta: result.meta, loadedAt: this.now() }, error: null }, controlReadSeq: ++this.sequence }),
        })
        // A new control state revalidates the history (the change makes it older, so it is read again). A state of another
        // deployment is read again first; the history follows that state.
        if (!keep) this.revalidateHistory()
        if (otherDeployment) this.loadControl()
        this.loadRuntime()
        return
      }
      if (result.error.kind === "aborted") return
      const phase = commandPhaseOf(result.error, false, attempt)
      const retryRefused = phase === "unknown" && attempt > 1 && result.error.kind !== "server" && result.error.kind !== "network" && result.error.kind !== "invalid"
      const marked = phase === "unknown" || (phase === "conflict" && attempt > 1)
      this.write({ command: { ...command, phase, result: null, error: result.error, timedOut: false, retryRefused, unknownSeq: marked ? ++this.sequence : null } })
      if (phase === "conflict" || retryRefused || (phase === "rejected" && result.error.code === "CONTROL_IDEMPOTENCY_CONFLICT")) this.refresh()
    })
  }

  /**
   * After the shown control state is established or changes. Entries of another deployment are cleared with their pages
   * and cursor, and the first page is read again (a late answer of the superseded read never lands); an older list of the
   * same deployment is read again; a list that fits is confirmed. A first-page read already in flight is checked when it
   * arrives instead.
   */
  private revalidateHistory(): void {
    const control = this.snapshot.control.value?.data
    const history = this.snapshot.history
    if (!control || history.phase === "idle") return
    const firstInFlight = history.phase === "loading" && this.historyPage === "first"
    const fit = historyFit(history, control)
    if (fit === "other" || (history.deploymentDigest !== null && history.deploymentDigest !== control.deploymentDigest)) {
      this.write({ history: { ...EMPTY_HISTORY, phase: firstInFlight ? "loading" : history.phase, error: firstInFlight ? null : history.error, failedPage: firstInFlight ? null : history.failedPage } })
      if (!firstInFlight) this.recheckHistory()
    } else if (fit === "stale" || (fit === "none" && history.phase === "error")) {
      // An older list, or a first page that failed or was rejected: read it for this state.
      if (!firstInFlight) this.recheckHistory()
    } else if (fit === "current" && history.deploymentDigest !== control.deploymentDigest) {
      this.write({ history: { ...history, deploymentDigest: control.deploymentDigest } })
    }
  }

  /** Reads the first history page again for the shown control state. */
  private recheckHistory(): void {
    this.historyRecheckMark = this.snapshot.controlReadSeq
    this.loadHistory(null)
  }

  private clearCommandTransport(): void {
    if (this.commandTimer !== null) clearTimeout(this.commandTimer)
    this.commandTimer = null
    this.commandController = null
  }

  private request(signal: AbortSignal) {
    return {
      apiBase: this.config.apiBase,
      // Read at send time so a rotated token (same session id) is used without a reset.
      accessToken: this.config.session?.accessToken ?? null,
      fetch: this.config.fetch,
      signal,
    }
  }

  private now(): number {
    return (this.config.now ?? Date.now)()
  }

  private begin(key: ReadKey): { sequence: number; signal: AbortSignal } {
    this.controllers.get(key)?.abort()
    const controller = new AbortController()
    this.controllers.set(key, controller)
    this.sequence += 1
    this.latest.set(key, this.sequence)
    return { sequence: this.sequence, signal: controller.signal }
  }

  private isLatest(key: ReadKey, generation: number, sequence: number): boolean {
    return this.active && generation === this.generation && this.latest.get(key) === sequence
  }

  private denyOnAccessError(error: StocksAdminError): boolean {
    const access: TradingControlAccess | null = error.kind === "forbidden" ? "forbidden" : error.kind === "unauthorized" ? "unauthorized" : error.kind === "unauthenticated" ? "signed_out" : null
    if (!access) return false
    // Same scope: a command whose result is not known is not forgotten silently (its key is never resent).
    const command = this.snapshot.command
    const abandoned = command && unresolvedOnClose(this.snapshot, command) ? abandonedOf(command, ++this.sequence) : this.snapshot.abandoned
    this.reset(this.snapshot.scopeKey, access, abandoned)
    return true
  }

  private reset(scopeKey: string, access: TradingControlAccess, abandoned: AbandonedCommand | null = null): void {
    this.generation += 1
    this.historyPage = null
    this.historyRecheckMark = null
    this.abortAll()
    this.snapshot = emptySnapshot(scopeKey, access, abandoned)
    this.emit()
  }

  private abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.latest.clear()
    // A command in flight is abandoned with its scope: never resent, its answer never shown.
    this.commandController?.abort()
    this.clearCommandTransport()
    this.commandSequence += 1
  }

  private write(patch: Partial<TradingControlSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function abandonedOf(command: CommandState, sinceSeq: number): AbandonedCommand {
  const { paused, expectedVersion, idempotencyKey, reason } = command.command
  return { paused, expectedVersion, idempotencyKey, reason, sinceSeq, deploymentDigest: command.basis.deploymentDigest }
}

/**
 * Whether this command's result is not known, so closing or replacing it must keep an unresolved note: it is in flight,
 * unknown, or a retry that met a version conflict (the 409 names no deployment) that no read after it has tied to the
 * command's own deployment, or after which a read showed another deployment.
 */
function unresolvedOnClose(snapshot: TradingControlSnapshot, command: CommandState): boolean {
  if (command.phase === "sending" || command.phase === "unknown") return true
  return command.phase === "conflict" && command.attempts > 1 && (command.otherDeploymentSeen || !readSinceOnDeployment(snapshot, command))
}

/** True when a control read taken after the command's outcome mark shows, without error, the deployment it was reviewed for. */
function readSinceOnDeployment(snapshot: TradingControlSnapshot, command: CommandState): boolean {
  const control = snapshot.control
  return (
    control.phase === "ready" &&
    control.error === null &&
    control.value?.data.deploymentDigest === command.basis.deploymentDigest &&
    command.unknownSeq !== null &&
    snapshot.controlReadSeq !== null &&
    snapshot.controlReadSeq > command.unknownSeq
  )
}

/**
 * The order mark after which a control read reflects every command whose result this page does not know: a command in
 * flight (any shown value predates it), an unknown command, or an unresolved note.
 */
function unresolvedMark(snapshot: TradingControlSnapshot): number | null {
  const command = snapshot.command
  if (command?.phase === "sending") return Number.POSITIVE_INFINITY
  const marks = [command?.phase === "unknown" ? command.unknownSeq : null, snapshot.abandoned?.sinceSeq ?? null].filter((mark): mark is number => mark !== null)
  return marks.length > 0 ? Math.max(...marks) : null
}

/** True when the shown control value was read before a command whose result this page does not know. */
export function readBeforeUnresolved(snapshot: TradingControlSnapshot): boolean {
  const mark = unresolvedMark(snapshot)
  if (mark === null || snapshot.control.value === null) return false
  return snapshot.controlReadSeq === null || snapshot.controlReadSeq <= mark
}

/**
 * Whether an unknown command may be retried now (null) or why not. A retry needs a successful control read started after
 * the unknown outcome, of the deployment the command was reviewed for; the identical command refused as invalid (400) or
 * as an idempotency conflict cannot succeed by retrying.
 */
export function retryReadiness(snapshot: TradingControlSnapshot): RetryRefusal | null {
  const command = snapshot.command
  if (snapshot.access !== "ok" || command?.phase !== "unknown") return "not_unknown"
  if (command.retryRefused && (command.error?.status === 400 || command.error?.code === "CONTROL_IDEMPOTENCY_CONFLICT")) return "not_retryable"
  const control = snapshot.control
  if (control.phase !== "ready" || control.error !== null || control.value === null || command.unknownSeq === null || snapshot.controlReadSeq === null || snapshot.controlReadSeq <= command.unknownSeq) return "read_first"
  if (control.value.data.deploymentDigest !== command.basis.deploymentDigest) return "deployment_changed"
  return null
}
