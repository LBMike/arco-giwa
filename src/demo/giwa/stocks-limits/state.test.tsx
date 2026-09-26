import assert from "node:assert/strict"
import test from "node:test"
import { parseEnvelope } from "../stocks-admin/parse"
import type { StocksAdminError } from "../stocks-admin/types"
import { LIM_NOW, limEnvelope, limEvent, limRead, limRow, limState } from "./fixtures"
import { LIMIT_CHANGE_REASON, parseLimitChange, parseLimitsRead } from "./parse"
import { LIMITS_INITIAL, checkDraft, commandFor, limitsReducer, type LimitsAction, type LimitsState } from "./state"

const META = parseEnvelope(limEnvelope(null)).meta
const run = (state: LimitsState, ...actions: LimitsAction[]) => actions.reduce(limitsReducer, state)
const read = (items = [limRow("BUY", 2, { dailyCashLimit: "50000000000" }, "12500000"), limRow("SELL")]) => parseLimitsRead(limRead(items))
const ready = (data = read()) => run(LIMITS_INITIAL, { type: "limits/start" }, { type: "limits/loaded", data, meta: META, at: LIM_NOW })
const error = (kind: StocksAdminError["kind"], status: number | null = null, code: string | null = null): StocksAdminError => ({ kind, status, code })

function reviewed(patch: Parameters<typeof limitsReducer>[1] & { type: "draft" } = { type: "draft", patch: { enabled: false, noCap: true } }) {
  return run(ready(), { type: "edit", symbol: "NVDA", side: "BUY" }, patch, { type: "review" })
}
function sending(key = "limit-key-0001") {
  const state = reviewed()
  const command = commandFor(state.draft, key)
  assert.ok(command)
  return run(state, { type: "send", command })
}
function saved(key = "limit-key-0001") {
  const change = limEvent("BUY", 3, { enabled: false, dailyCashLimit: null, reason: LIMIT_CHANGE_REASON })
  const state = limState("BUY", 3, { enabled: false, reason: LIMIT_CHANGE_REASON, updatedAt: change.createdAt })
  return parseLimitChange({ state, change, replayed: false }, { symbol: "NVDA", side: "BUY", command: { enabled: false, dailyCashLimit: null, expectedVersion: 2, idempotencyKey: key, reason: LIMIT_CHANGE_REASON } })
}

test("editing starts only from a successful read and copies the row as its basis", () => {
  assert.equal(run(LIMITS_INITIAL, { type: "edit", symbol: "NVDA", side: "BUY" }).draft, null, "nothing read yet")
  const loading = run(ready(), { type: "limits/start" }, { type: "edit", symbol: "NVDA", side: "BUY" })
  assert.equal(loading.draft, null, "not while reading again")
  const state = run(ready(), { type: "edit", symbol: "NVDA", side: "BUY" })
  assert.deepEqual(
    state.draft && { enabled: state.draft.enabled, noCap: state.draft.noCap, capText: state.draft.capText, version: state.draft.basis.version },
    { enabled: true, noCap: false, capText: "50000", version: 2 },
  )
  assert.equal(run(ready(), { type: "edit", symbol: "TSLA", side: "BUY" }).draft, null)
  assert.equal(run(state, { type: "cancel" }).draft, null)
})

test("review checks the cap the way the server will and needs no typed reason; the review freezes the inputs", () => {
  const empty = run(ready(), { type: "edit", symbol: "NVDA", side: "BUY" }, { type: "draft", patch: { capText: "0" } }, { type: "review" })
  assert.equal(empty.draft?.reviewing, false)
  assert.equal(empty.draft?.showErrors, true)
  assert.deepEqual(empty.draft && checkDraft(empty.draft), { ok: false, cap: "A cap must be more than 0. To stop this side, turn it off instead." })
  // Nothing typed but the cap: the review opens straight away.
  const unchanged = run(ready(), { type: "edit", symbol: "NVDA", side: "BUY" }, { type: "review" })
  assert.deepEqual([unchanged.draft?.reviewing, unchanged.draft && checkDraft(unchanged.draft)], [true, { ok: true, enabled: true, dailyCashLimit: "50000000000" }])
  const state = reviewed({ type: "draft", patch: { capText: "75,000.5" } })
  assert.equal(state.draft?.reviewing, true)
  assert.deepEqual(state.draft && checkDraft(state.draft), { ok: true, enabled: true, dailyCashLimit: "75000500000" })
  assert.equal(run(state, { type: "draft", patch: { capText: "1" } }).draft?.capText, "75,000.5", "inputs are frozen while reviewing")
  assert.equal(run(state, { type: "back" }).draft?.reviewing, false)
})

test("a confirmed change is frozen with the basis version as the expected version", () => {
  assert.equal(commandFor(run(ready(), { type: "edit", symbol: "NVDA", side: "BUY" }).draft, "k-00000001"), null, "not reviewed")
  const state = sending("limit-key-0001")
  assert.equal(state.draft, null)
  assert.deepEqual(state.command && { ...state.command, basis: state.command.basis.version }, {
    symbol: "NVDA",
    side: "BUY",
    basis: 2,
    command: { enabled: false, dailyCashLimit: null, expectedVersion: 2, idempotencyKey: "limit-key-0001", reason: LIMIT_CHANGE_REASON },
    phase: "sending",
    attempts: 1,
    error: null,
  })
  // One change at a time: a second confirm or edit does nothing while one is open.
  const second = commandFor({ ...reviewed().draft!, capText: "1" }, "limit-key-0002")!
  assert.equal(run(state, { type: "send", command: second }).command?.command.idempotencyKey, "limit-key-0001")
  assert.equal(run(state, { type: "edit", symbol: "NVDA", side: "SELL" }).draft, null)
})

test("answers: saved, version conflict, refused before recording, and unknown", () => {
  const key = "limit-key-0001"
  const ok = run(sending(key), { type: "result", key, result: { ok: true, data: saved(key) } })
  assert.deepEqual([ok.command, ok.outcome?.kind], [null, "saved"])
  const conflict = run(sending(key), { type: "result", key, result: { ok: false, error: error("request", 409, "LIMIT_VERSION_CONFLICT") } })
  assert.deepEqual([conflict.command, conflict.outcome?.kind], [null, "conflict"])
  for (const refused of [error("forbidden", 403, "OPERATOR_FORBIDDEN"), error("unauthorized", 401), error("disabled", 404), error("request", 400, "INVALID_TRADING_LIMIT_INPUT"), error("request", 409, "LIMIT_IDEMPOTENCY_CONFLICT")]) {
    const state = run(sending(key), { type: "result", key, result: { ok: false, error: refused } })
    assert.deepEqual([state.command, state.outcome?.kind], [null, "rejected"], refused.kind)
  }
  for (const lost of [error("network"), error("server", 503, "TRADING_LIMITS_UNAVAILABLE"), error("invalid", 200), error("aborted"), error("request", 429)]) {
    const state = run(sending(key), { type: "result", key, result: { ok: false, error: lost } })
    assert.deepEqual([state.command?.phase, state.command?.error, state.outcome], ["unknown", lost, null], lost.kind)
  }
  // An answer for another change is ignored.
  assert.equal(run(sending(key), { type: "result", key: "limit-key-other", result: { ok: true, data: saved(key) } }).command?.phase, "sending")
})

test("an unknown change is retried with the same key or discarded; nothing else can start meanwhile", () => {
  const key = "limit-key-0001"
  const unknown = run(sending(key), { type: "result", key, result: { ok: false, error: error("network") } })
  const retried = run(unknown, { type: "retry" })
  assert.deepEqual([retried.command?.phase, retried.command?.attempts, retried.command?.command.idempotencyKey, retried.command?.error], ["sending", 2, key, null])
  assert.equal(run(retried, { type: "retry" }).command?.attempts, 2, "no retry while sending")
  assert.equal(run(retried, { type: "discard" }).command?.phase, "sending", "no discard while sending")
  const replayed = run(retried, { type: "result", key, result: { ok: true, data: { ...saved(key), replayed: true } } })
  assert.equal(replayed.outcome?.kind === "saved" && replayed.outcome.change.replayed, true)
  assert.equal(run(unknown, { type: "discard" }).command, null)
  assert.equal(run(unknown, { type: "edit", symbol: "NVDA", side: "SELL" }).draft, null)
})

test("a refused retry says nothing about the first attempt: the change stays unknown, except for a version conflict", () => {
  const key = "limit-key-0001"
  const retried = run(sending(key), { type: "result", key, result: { ok: false, error: error("network") } }, { type: "retry" })
  for (const refused of [error("forbidden", 403, "OPERATOR_FORBIDDEN"), error("unauthorized", 401), error("disabled", 404), error("request", 400, "INVALID_TRADING_LIMIT_INPUT"), error("request", 409, "LIMIT_IDEMPOTENCY_CONFLICT"), error("unauthenticated")]) {
    const state = run(retried, { type: "result", key, result: { ok: false, error: refused } })
    assert.deepEqual([state.command?.phase, state.command?.attempts, state.command?.error, state.outcome], ["unknown", 2, refused, null], refused.kind)
  }
  // The server looks the key up before it compares versions: a conflict proves the key was never recorded.
  const conflict = run(retried, { type: "result", key, result: { ok: false, error: error("request", 409, "LIMIT_VERSION_CONFLICT") } })
  assert.deepEqual([conflict.command, conflict.outcome?.kind], [null, "conflict"])
})

test("a read that shows the edited row moved on ends the draft without sending anything", () => {
  const editing = run(ready(), { type: "edit", symbol: "NVDA", side: "BUY" }, { type: "draft", patch: { capText: "7" } })
  const same = run(editing, { type: "limits/start" }, { type: "limits/loaded", data: read(), meta: META, at: LIM_NOW + 1 })
  assert.equal(same.draft?.capText, "7", "same version: the draft stays")
  const moved = run(editing, { type: "limits/loaded", data: read([limRow("BUY", 3, { enabled: false }), limRow("SELL")]), meta: META, at: LIM_NOW + 2 })
  assert.deepEqual([moved.draft, moved.outcome?.kind], [null, "changed_while_editing"])
  const failed = run(editing, { type: "limits/start" }, { type: "limits/failed", error: error("network") })
  assert.equal(failed.limits.phase, "error")
  assert.equal(failed.limits.value?.data.items.length, 2, "the last read stays, labelled")
  assert.equal(failed.draft?.capText, "7")
})
