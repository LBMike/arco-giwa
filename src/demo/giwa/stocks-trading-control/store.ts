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
//   retry too: the server checks the key before the version, so it proves the key was never recorded). A first attempt
//   refused with 400/401/403/404/idempotency conflict changed nothing. Anything else (503, 5xx, network, timeout,
//   invalid 200), and any refusal of a retry, is unknown: the earlier attempt may or may not have been recorded.
// - A POST answer never replaces a newer state that is already shown. A retry is refused once the server serves another
//   deployment than the one the command was reviewed for (keys are deployment-scoped).
import { scopeKeyOf } from "../stocks-admin/store"
import type { StocksAdminError } from "../stocks-admin/types"
import { newIdempotencyKey, readRuntimeStatus, readTradingControl, readTradingControlHistory, sendTradingControlCommand } from "./client"
import { IDEMPOTENCY_KEY, MAX_VERSION, checkReason } from "./parse"
import type {
  AbandonedCommand,
  CommandPhase,
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
const EMPTY_HISTORY: HistoryState = Object.freeze({ phase: "idle", items: [], nextBeforeVersion: null, complete: false, observedAt: null, error: null, failedPage: null })

function emptySnapshot(scopeKey: string, access: TradingControlAccess, abandoned: AbandonedCommand | null = null): TradingControlSnapshot {
  return { scopeKey, access, control: IDLE, runtime: IDLE, history: EMPTY_HISTORY, command: null, abandoned }
}

type ReadKey = "control" | "runtime" | "history"

/** "Load older" continues a list that was read successfully, or retries an older page that failed. */
export function canLoadOlder(history: HistoryState): boolean {
  if (history.complete || history.nextBeforeVersion === null) return false
  return history.phase === "ready" || (history.phase === "error" && history.failedPage === "older")
}

/** Why a start request was refused locally (nothing was sent). */
export type StartRefusal = "not_ready" | "busy" | "stale_review" | "invalid_reason" | "version_limit" | "invalid_key"
/** Why a retry was refused locally (nothing was sent). */
export type RetryRefusal = "not_unknown" | "deployment_changed"

/**
 * The outcome of one attempt that did not return a verified event. `attempt` is 1 for the first send; a refusal of a
 * later attempt only proves that this attempt changed nothing, so the command stays unknown.
 */
export function commandPhaseOf(error: StocksAdminError, timedOut: boolean, attempt = 1): Exclude<CommandPhase, "sending" | "accepted" | "replayed"> {
  if (timedOut) return "unknown"
  // The service looks the key up before it compares versions: a version conflict proves this key was never recorded.
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
      if (result.ok) this.write({ control: { phase: "ready", value: { data: result.data, meta: result.meta, loadedAt: this.now() }, error: null } })
      else if (!this.denyOnAccessError(result.error)) this.write({ control: { phase: "error", value: this.snapshot.control.value, error: result.error } })
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
    this.write({ history: { ...history, phase: "loading", error: null, failedPage: null } })
    void readTradingControlHistory({ ...this.request(signal), beforeVersion }).then((result) => {
      if (!this.isLatest("history", generation, sequence)) return
      this.controllers.delete("history")
      const current = this.snapshot.history
      if (result.ok) {
        const page = result.data
        const digest = this.snapshot.control.value?.data.deploymentDigest
        const older = beforeVersion !== null
        const last = current.items[current.items.length - 1]
        // Every page belongs to the deployment whose state is shown, and older pages continue the list.
        const consistent =
          page.items.every((item) => digest === undefined || item.deploymentDigest === digest) &&
          (!older || (last !== undefined && page.items.every((item) => item.version < last.version && item.deploymentDigest === last.deploymentDigest)))
        if (!consistent) {
          this.write({ history: { ...current, phase: "error", error: { kind: "invalid", status: 200, code: null }, failedPage: older ? "older" : "first" } })
          return
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
    const state = control.value.data
    // The operator confirmed what they reviewed; if the shown state has moved since, they must review again.
    if (state.version !== input.reviewed.version || state.paused !== input.reviewed.paused || control.value.meta.observedAt !== input.reviewed.observedAt) return "stale_review"
    const reason = checkReason(input.reason)
    if (!reason.ok || reason.reason !== input.reason) return "invalid_reason"
    if (state.version >= MAX_VERSION) return "version_limit"
    const idempotencyKey = (this.config.newIdempotencyKey ?? newIdempotencyKey)()
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return "invalid_key"
    this.write({
      command: {
        phase: "sending",
        command: Object.freeze({ paused: input.paused, expectedVersion: state.version, idempotencyKey, reason: reason.reason }),
        basis: { paused: state.paused, version: state.version, observedAt: control.value.meta.observedAt, deploymentDigest: state.deploymentDigest },
        attempts: 0,
        result: null,
        error: null,
        timedOut: false,
        retryRefused: false,
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
    const command = this.snapshot.command
    if (!this.active || this.snapshot.access !== "ok" || command?.phase !== "unknown") return "not_unknown"
    if (retryDeploymentChanged(this.snapshot)) return "deployment_changed"
    this.send()
    return null
  }

  /** Closes the command panel. A command in flight cannot be discarded (its answer is awaited). */
  discard(): boolean {
    const command = this.snapshot.command
    if (!command || command.phase === "sending") return false
    this.write({ command: null })
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
        this.write({ command: { ...command, phase: "unknown", result: null, error: { kind: "aborted", status: null, code: null }, timedOut: true, retryRefused: false } })
      }
    }, this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
    this.write({ command: { ...current, phase: "sending", attempts: attempt, error: null, timedOut: false, retryRefused: false } })
    void sendTradingControlCommand({ ...this.request(controller.signal), command: frozen }).then((result) => {
      if (!this.active || generation !== this.generation || sequence !== this.commandSequence) return
      this.clearCommandTransport()
      const command = this.snapshot.command
      if (!command || command.command !== frozen) return
      if (result.ok) {
        const shown = this.snapshot.control.value?.data
        const state = result.data.state
        // The response state becomes the current value unless a newer state of the same deployment is already shown.
        const newerShown = shown !== undefined && shown.deploymentDigest === state.deploymentDigest && shown.version > state.version
        if (!newerShown) this.cancel("control")
        this.write({
          command: { ...command, phase: result.data.replayed ? "replayed" : "accepted", result: { change: result.data, meta: result.meta }, error: null, timedOut: false, retryRefused: false },
          ...(newerShown ? {} : { control: { phase: "ready" as const, value: { data: state, meta: result.meta, loadedAt: this.now() }, error: null } }),
        })
        this.loadHistory(null)
        this.loadRuntime()
        return
      }
      if (result.error.kind === "aborted") return
      const phase = commandPhaseOf(result.error, false, attempt)
      const retryRefused = phase === "unknown" && attempt > 1 && result.error.kind !== "server" && result.error.kind !== "network" && result.error.kind !== "invalid"
      this.write({ command: { ...command, phase, result: null, error: result.error, timedOut: false, retryRefused } })
      if (phase === "conflict" || retryRefused || (phase === "rejected" && result.error.code === "CONTROL_IDEMPOTENCY_CONFLICT")) this.refresh()
    })
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

  private cancel(key: ReadKey): void {
    this.controllers.get(key)?.abort()
    this.controllers.delete(key)
    this.latest.delete(key)
  }

  private isLatest(key: ReadKey, generation: number, sequence: number): boolean {
    return this.active && generation === this.generation && this.latest.get(key) === sequence
  }

  private denyOnAccessError(error: StocksAdminError): boolean {
    const access: TradingControlAccess | null = error.kind === "forbidden" ? "forbidden" : error.kind === "unauthorized" ? "unauthorized" : error.kind === "unauthenticated" ? "signed_out" : null
    if (!access) return false
    // Same scope: a command whose result is not known is not forgotten silently (its key is never resent).
    const command = this.snapshot.command
    const abandoned = command && (command.phase === "sending" || command.phase === "unknown") ? { paused: command.command.paused, expectedVersion: command.command.expectedVersion, idempotencyKey: command.command.idempotencyKey } : this.snapshot.abandoned
    this.reset(this.snapshot.scopeKey, access, abandoned)
    return true
  }

  private reset(scopeKey: string, access: TradingControlAccess, abandoned: AbandonedCommand | null = null): void {
    this.generation += 1
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

/** True when the state now read belongs to another deployment than the unknown command was reviewed for. */
export function retryDeploymentChanged(snapshot: TradingControlSnapshot): boolean {
  const command = snapshot.command
  const shown = snapshot.control.value?.data
  return command !== null && shown !== undefined && shown.deploymentDigest !== command.basis.deploymentDigest
}
