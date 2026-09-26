// The panel's state as a pure reducer, so the view stays a pure function of state (rendered directly by tests) and every
// transition of a change is testable without a DOM.
//
// A change is frozen when the operator confirms it: the same command (and idempotency key) is what a retry sends, so a
// change whose answer was lost is recorded at most once. Only a verified answer ends it. A version conflict proves the key
// was never recorded; any other refusal (400, 401, 403, 404, 409) ends it only on the first attempt, because a refused retry
// says nothing about the earlier attempt. Anything else leaves it unknown until retried or discarded.
import { LIMIT_CHANGE_REASON, capInputText, checkCapInput } from "./parse"
import type { Loaded, ResourceState, StocksAdminError, StocksEnvelopeMeta, TradingLimitChange, TradingLimitCommand, TradingLimitHistory, TradingLimitRow, TradingLimitsRead, TradingSide } from "./types"

export type LimitDraft = {
  readonly symbol: string
  readonly side: TradingSide
  /** The row as read when editing started; its version is the change's expected version. */
  readonly basis: TradingLimitRow
  readonly enabled: boolean
  readonly noCap: boolean
  readonly capText: string
  readonly reviewing: boolean
  /** Validation messages show after the first review attempt. */
  readonly showErrors: boolean
}

export type LimitCommandState = {
  readonly symbol: string
  readonly side: TradingSide
  readonly basis: TradingLimitRow
  readonly command: TradingLimitCommand
  /** `unknown`: no verified answer; the change may or may not have been recorded. */
  readonly phase: "sending" | "unknown"
  readonly attempts: number
  readonly error: StocksAdminError | null
}

export type LimitOutcome =
  | { readonly kind: "saved"; readonly symbol: string; readonly side: TradingSide; readonly change: TradingLimitChange }
  | { readonly kind: "conflict"; readonly symbol: string; readonly side: TradingSide }
  | { readonly kind: "changed_while_editing"; readonly symbol: string; readonly side: TradingSide }
  | { readonly kind: "rejected"; readonly symbol: string; readonly side: TradingSide; readonly error: StocksAdminError }

export type LimitsState = {
  readonly limits: ResourceState<TradingLimitsRead>
  readonly history: ResourceState<TradingLimitHistory>
  readonly draft: LimitDraft | null
  readonly command: LimitCommandState | null
  readonly outcome: LimitOutcome | null
}

export type DraftPatch = Partial<Pick<LimitDraft, "enabled" | "noCap" | "capText">>

export type LimitsAction =
  | { readonly type: "limits/start" }
  | { readonly type: "limits/loaded"; readonly data: TradingLimitsRead; readonly meta: StocksEnvelopeMeta; readonly at: number }
  | { readonly type: "limits/failed"; readonly error: StocksAdminError }
  | { readonly type: "history/start" }
  | { readonly type: "history/loaded"; readonly data: TradingLimitHistory; readonly meta: StocksEnvelopeMeta; readonly at: number }
  | { readonly type: "history/failed"; readonly error: StocksAdminError }
  | { readonly type: "edit"; readonly symbol: string; readonly side: TradingSide }
  | { readonly type: "draft"; readonly patch: DraftPatch }
  | { readonly type: "review" }
  | { readonly type: "back" }
  | { readonly type: "cancel" }
  | { readonly type: "send"; readonly command: LimitCommandState }
  | {
      readonly type: "result"
      /** The idempotency key of the change this answers; an answer for any other change is ignored. */
      readonly key: string
      readonly result: { readonly ok: true; readonly data: TradingLimitChange } | { readonly ok: false; readonly error: StocksAdminError }
    }
  | { readonly type: "retry" }
  | { readonly type: "discard" }
  | { readonly type: "dismiss" }

const EMPTY = { phase: "idle", value: null, error: null } as const

export const LIMITS_INITIAL: LimitsState = { limits: EMPTY, history: EMPTY, draft: null, command: null, outcome: null }

export function rowOf(state: LimitsState, symbol: string, side: TradingSide): TradingLimitRow | null {
  return state.limits.value?.data.items.find((item) => item.symbol === symbol && item.side === side) ?? null
}

export type DraftCheck =
  | { readonly ok: true; readonly enabled: boolean; readonly dailyCashLimit: string | null }
  | { readonly ok: false; readonly cap: string }

/** The cap checked the way the server will check it; the reason is the console's fixed text. */
export function checkDraft(draft: LimitDraft): DraftCheck {
  const cap = draft.noCap ? null : checkCapInput(draft.capText)
  if (cap === null || cap.ok) return { ok: true, enabled: draft.enabled, dailyCashLimit: cap === null ? null : cap.baseUnits }
  return { ok: false, cap: cap.message }
}

/** The frozen change for a reviewed draft, or null when there is nothing valid to send. */
export function commandFor(draft: LimitDraft | null, idempotencyKey: string): LimitCommandState | null {
  if (draft === null || !draft.reviewing) return null
  const check = checkDraft(draft)
  if (!check.ok) return null
  return {
    symbol: draft.symbol,
    side: draft.side,
    basis: draft.basis,
    command: { enabled: check.enabled, dailyCashLimit: check.dailyCashLimit, expectedVersion: draft.basis.version, idempotencyKey, reason: LIMIT_CHANGE_REASON },
    phase: "sending",
    attempts: 1,
    error: null,
  }
}

function loaded<T>(data: T, meta: StocksEnvelopeMeta, at: number): Loaded<T> {
  return { data, meta, loadedAt: at }
}

/** A refusal the server gives before it records anything; everything else leaves the outcome unknown. */
function refusedBeforeRecording(error: StocksAdminError): boolean {
  return (
    error.kind === "configuration" ||
    error.kind === "unauthenticated" ||
    error.kind === "unauthorized" ||
    error.kind === "forbidden" ||
    error.kind === "disabled" ||
    (error.kind === "request" && (error.status === 400 || error.status === 409))
  )
}

export function limitsReducer(state: LimitsState, action: LimitsAction): LimitsState {
  switch (action.type) {
    case "limits/start":
      return { ...state, limits: { ...state.limits, phase: "loading" } }
    case "limits/loaded": {
      const limits = { phase: "ready", value: loaded(action.data, action.meta, action.at), error: null } as const
      const draft = state.draft
      if (draft === null) return { ...state, limits }
      // Someone changed the row being edited: the draft's basis is gone, so nothing may be sent from it.
      const current = action.data.items.find((item) => item.symbol === draft.symbol && item.side === draft.side)
      if (current && current.version === draft.basis.version && current.deploymentDigest === draft.basis.deploymentDigest) return { ...state, limits }
      return { ...state, limits, draft: null, outcome: { kind: "changed_while_editing", symbol: draft.symbol, side: draft.side } }
    }
    case "limits/failed":
      return { ...state, limits: { ...state.limits, phase: "error", error: action.error } }
    case "history/start":
      return { ...state, history: { ...state.history, phase: "loading" } }
    case "history/loaded":
      return { ...state, history: { phase: "ready", value: loaded(action.data, action.meta, action.at), error: null } }
    case "history/failed":
      return { ...state, history: { ...state.history, phase: "error", error: action.error } }
    case "edit": {
      if (state.command !== null || state.limits.phase !== "ready") return state
      const row = rowOf(state, action.symbol, action.side)
      if (row === null) return state
      return {
        ...state,
        outcome: null,
        draft: {
          symbol: row.symbol,
          side: row.side,
          basis: row,
          enabled: row.enabled,
          noCap: row.dailyCashLimit === null,
          capText: row.dailyCashLimit === null ? "" : capInputText(row.dailyCashLimit),
          reviewing: false,
          showErrors: false,
        },
      }
    }
    case "draft":
      return state.draft === null || state.draft.reviewing ? state : { ...state, draft: { ...state.draft, ...action.patch } }
    case "review": {
      if (state.draft === null) return state
      const check = checkDraft(state.draft)
      return { ...state, draft: { ...state.draft, reviewing: check.ok, showErrors: true } }
    }
    case "back":
      return state.draft === null ? state : { ...state, draft: { ...state.draft, reviewing: false } }
    case "cancel":
      return { ...state, draft: null }
    case "send":
      if (state.command !== null || state.draft === null || !state.draft.reviewing) return state
      return { ...state, draft: null, outcome: null, command: action.command }
    case "result": {
      const command = state.command
      if (command === null || command.phase !== "sending" || command.command.idempotencyKey !== action.key) return state
      const { result } = action
      if (result.ok) return { ...state, command: null, outcome: { kind: "saved", symbol: command.symbol, side: command.side, change: result.data } }
      // The server looks the key up before it compares versions: a version conflict proves this key was never recorded.
      if (result.error.kind === "request" && result.error.status === 409 && result.error.code === "LIMIT_VERSION_CONFLICT") {
        return { ...state, command: null, outcome: { kind: "conflict", symbol: command.symbol, side: command.side } }
      }
      // Any other refusal proves only that this attempt changed nothing; after an unknown first attempt the change stays unknown.
      if (command.attempts === 1 && refusedBeforeRecording(result.error)) return { ...state, command: null, outcome: { kind: "rejected", symbol: command.symbol, side: command.side, error: result.error } }
      return { ...state, command: { ...command, phase: "unknown", error: result.error } }
    }
    case "retry":
      return state.command === null || state.command.phase !== "unknown" ? state : { ...state, command: { ...state.command, phase: "sending", attempts: state.command.attempts + 1, error: null } }
    case "discard":
      return state.command === null || state.command.phase !== "unknown" ? state : { ...state, command: null }
    case "dismiss":
      return { ...state, outcome: null }
  }
}
