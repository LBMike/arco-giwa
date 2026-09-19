// 003F: the trading control and runtime status contracts as the client reads them, checked against the server's own
// plugins (real Fastify injection) so the two cannot drift apart silently, plus the client transport and reason rules.
import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { stocksTradingControlPlugin } from "../../../../server/src/stocks-trading-control/plugin"
import { stocksRuntimeStatusPlugin } from "../../../../server/src/stocks-runtime-status/plugin"
import { StocksError } from "../../../../server/src/stocks/contracts"
import { StocksContractError } from "../stocks-admin/parse"
import { TRADING_CONTROL_PATH, historyPath, newIdempotencyKey, readRuntimeStatus, sendTradingControlCommand } from "./client"
import { TC_DIGEST, TC_FLAGS, TC_OBSERVED_AT, TC_PROFILE, tcChange, tcEnvelope, tcError, tcEvent, tcHistory, tcRead, tcRuntime, tcState, type TcReply } from "./fixtures"
import { IDEMPOTENCY_KEY, checkReason, parseControlChange, parseControlHistory, parseControlRead, parseRuntimeStatus } from "./parse"
import type { TradingControlCommand } from "./types"

const command = (overrides: Partial<TradingControlCommand> = {}): TradingControlCommand => ({ paused: false, expectedVersion: 0, idempotencyKey: "tc-key-00000001", reason: "Reason for version 1", ...overrides })
const rejects = (name: string, run: () => unknown) => assert.throws(run, StocksContractError, name)

test("control state: the initial state is paused at version 0 with no change metadata; later states need all of it", () => {
  assert.deepEqual(parseControlRead(tcRead(tcState(0, true))), { deploymentDigest: TC_DIGEST, paused: true, version: 0, updatedAt: null, operatorId: null, reason: null })
  assert.equal(parseControlRead(tcRead(tcState(3, false))).paused, false)
  const initial = tcState(0, true)
  rejects("v0 resumed", () => parseControlRead(tcRead({ ...initial, paused: false })))
  rejects("v0 with a reason", () => parseControlRead(tcRead({ ...initial, reason: "x" })))
  rejects("v0 with a time", () => parseControlRead(tcRead({ ...initial, updatedAt: "2026-09-19T08:00:00.000Z" })))
  const later = tcState(2, true)
  for (const [name, change] of [
    ["no time", { updatedAt: null }],
    ["loose time", { updatedAt: "2026-09-19T08:00:00Z" }],
    ["no operator", { operatorId: null }],
    ["untrimmed reason", { reason: " padded " }],
    ["control char in reason", { reason: "line\nbreak" }],
    ["C1 control in operator", { operatorId: "ops\u0085a" }],
    ["reason too long", { reason: "x".repeat(501) }],
    ["upper-case digest", { deploymentDigest: TC_DIGEST.toUpperCase() }],
    ["fractional version", { version: 2.5 }],
    ["version above the limit", { version: 2_147_483_648 }],
    ["extra field", { idempotencyKey: "leak-0001" }],
  ] as const) rejects(name, () => parseControlRead(tcRead({ ...later, ...change })))
  rejects("execution authorization", () => parseControlRead({ ...tcRead(later), executionAuthorization: true }))
  rejects("in-flight flag missing", () => parseControlRead({ state: later, executionAuthorization: false }))
  rejects("extra data field", () => parseControlRead({ ...tcRead(later), raw: {} }))
})

test("change: the event must be this command's; the state is current and may be later (old replay)", () => {
  const fresh = parseControlChange(tcChange(tcState(1, false), tcEvent(1, false, { previousPaused: true })), command())
  assert.deepEqual([fresh.state.version, fresh.change.version, fresh.replayed], [1, 1, false])
  // An old resume replayed after a later pause: its original event plus the current paused state.
  const replay = parseControlChange(tcChange(tcState(2, true), tcEvent(1, false, { previousPaused: true }), true), command())
  assert.deepEqual([replay.state.paused, replay.state.version, replay.change.paused, replay.change.version, replay.replayed], [true, 2, false, 1, true])
  const state = tcState(1, false)
  const event = tcEvent(1, false, { previousPaused: true })
  rejects("event for another expected version", () => parseControlChange(tcChange(tcState(2, false), tcEvent(2, false)), command()))
  rejects("event with the other paused value", () => parseControlChange(tcChange(tcState(1, true), tcEvent(1, true)), command()))
  rejects("event with another reason", () => parseControlChange(tcChange(state, { ...event, reason: "Other" }), command()))
  rejects("event of another deployment", () => parseControlChange(tcChange(state, { ...event, deploymentDigest: "a".repeat(64) }), command()))
  rejects("state older than the event", () => parseControlChange(tcChange(tcState(0, true), event), command()))
  rejects("same version, different operator", () => parseControlChange(tcChange({ ...state, operatorId: "someone-else" }, event), command()))
  rejects("same version, different time", () => parseControlChange(tcChange({ ...state, updatedAt: "2026-09-19T08:59:00.000Z" }, event), command()))
  rejects("replayed not boolean", () => parseControlChange({ ...tcChange(state, event), replayed: "no" }, command()))
  rejects("idempotency key echoed", () => parseControlChange(tcChange(state, { ...event, idempotencyKey: "tc-key-00000001" }), command()))
  rejects("bad event id", () => parseControlChange(tcChange(state, { ...event, id: "has space" }), command()))
  rejects("flags", () => parseControlChange({ ...tcChange(state, event), inFlightMayContinue: false }, command()))
})

test("history: newest first, one deployment, bounded pages, nextBeforeVersion only after a full page", () => {
  const page = parseControlHistory(tcHistory([tcEvent(3, true), tcEvent(2, false), tcEvent(1, true, { previousPaused: true })], null), { limit: 20, beforeVersion: null })
  assert.deepEqual(page.items.map((item) => item.version), [3, 2, 1])
  assert.equal(page.nextBeforeVersion, null)
  const full = parseControlHistory(tcHistory([tcEvent(5, true), tcEvent(4, false)], 4), { limit: 2, beforeVersion: 6 })
  assert.equal(full.nextBeforeVersion, 4)
  assert.deepEqual(parseControlHistory(tcHistory([], null), { limit: 20, beforeVersion: null }).items, [])
  rejects("ascending", () => parseControlHistory(tcHistory([tcEvent(1, true), tcEvent(2, false)], null), { limit: 20, beforeVersion: null }))
  rejects("duplicate version", () => parseControlHistory(tcHistory([tcEvent(2, true), tcEvent(2, false)], null), { limit: 20, beforeVersion: null }))
  rejects("not before the bound", () => parseControlHistory(tcHistory([tcEvent(6, true)], null), { limit: 20, beforeVersion: 6 }))
  rejects("mixed deployments", () => parseControlHistory(tcHistory([tcEvent(2, true), { ...tcEvent(1, false), deploymentDigest: "b".repeat(64) }], null), { limit: 20, beforeVersion: null }))
  rejects("next after a short page", () => parseControlHistory(tcHistory([tcEvent(2, true)], 2), { limit: 20, beforeVersion: null }))
  rejects("next not the last version", () => parseControlHistory(tcHistory([tcEvent(5, true), tcEvent(4, false)], 3), { limit: 2, beforeVersion: null }))
  rejects("more than the limit", () => parseControlHistory(tcHistory([tcEvent(3, true), tcEvent(2, false), tcEvent(1, true)], null), { limit: 2, beforeVersion: null }))
  rejects("next missing", () => parseControlHistory({ items: [], ...TC_FLAGS }, { limit: 20, beforeVersion: null }))
})

test("runtime: pause reasons must be exactly the server's derivation, in order; operatorControl is optional", () => {
  const cases = [
    tcRuntime(),
    tcRuntime({ operatorControl: { status: "RESUMED", version: 1 } }),
    tcRuntime({ operatorControl: { status: "RESUMED", version: 1 }, configuredPause: true, observerStatus: "STALE" }),
    tcRuntime({ operatorControl: { status: "UNAVAILABLE", version: null }, autodispatch: false }),
    tcRuntime({ runtimeState: "STOPPED" }),
    tcRuntime({ operatorControl: undefined }),
  ]
  for (const body of cases) assert.deepEqual(parseRuntimeStatus(body, TC_OBSERVED_AT).pauseReasons, body.pauseReasons)
  assert.equal(parseRuntimeStatus(tcRuntime({ operatorControl: undefined }), TC_OBSERVED_AT).operatorControl, null)
  const resumed = tcRuntime({ operatorControl: { status: "RESUMED", version: 1 }, configuredPause: true, observerStatus: "STALE" })
  assert.deepEqual(resumed.pauseReasons, ["CONFIGURED_PAUSE", "OBSERVER_NOT_CURRENT"])
  const base = tcRuntime()
  rejects("reasons reordered", () => parseRuntimeStatus({ ...resumed, pauseReasons: ["OBSERVER_NOT_CURRENT", "CONFIGURED_PAUSE"] }, TC_OBSERVED_AT))
  rejects("reason missing", () => parseRuntimeStatus({ ...resumed, pauseReasons: ["CONFIGURED_PAUSE"] }, TC_OBSERVED_AT))
  rejects("newOrdersPaused disagrees", () => parseRuntimeStatus({ ...base, newOrdersPaused: false }, TC_OBSERVED_AT))
  rejects("unavailable with a version", () => parseRuntimeStatus(tcRuntime({ operatorControl: { status: "UNAVAILABLE", version: 3 } }), TC_OBSERVED_AT))
  rejects("paused without a version", () => parseRuntimeStatus({ ...base, operatorControl: { status: "PAUSED", version: null } }, TC_OBSERVED_AT))
  rejects("execution authorization", () => parseRuntimeStatus({ ...base, executionAuthorization: true }, TC_OBSERVED_AT))
  rejects("stopped runtime, running observer", () => parseRuntimeStatus({ ...base, runtimeState: "STOPPED" }, TC_OBSERVED_AT))
  rejects("current but too old", () => parseRuntimeStatus({ ...base, lastCurrentAgeMs: 60_001 }, TC_OBSERVED_AT))
  // lastCurrentAt is 2 s before TC_OBSERVED_AT; an envelope time before it cannot be CURRENT.
  rejects("current after the response", () => parseRuntimeStatus(base, "2026-09-19T08:59:57.000Z"))
  rejects("current older than the freshness limit", () => parseRuntimeStatus(base, "2026-09-19T09:01:00.000Z"))
  rejects("extra field", () => parseRuntimeStatus({ ...base, config: {} }, TC_OBSERVED_AT))
  rejects("loose envelope time", () => parseRuntimeStatus(base, "2026-09-19T09:00:00Z"))
})

test("reason: trimmed, 1–500 UTF-16 units, no control characters", () => {
  assert.deepEqual(checkReason("  Verified reconciliation  "), { ok: true, reason: "Verified reconciliation" })
  assert.equal(checkReason("x".repeat(500)).ok, true)
  assert.equal(checkReason("😀".repeat(250)).ok, true, "500 code units")
  for (const bad of ["", "   ", "x".repeat(501), "😀".repeat(251), "two\nlines", "tab\there", "c1\u0085", "del\u007f"]) assert.equal(checkReason(bad).ok, false, JSON.stringify(bad))
  assert.match((checkReason("x".repeat(501)) as { message: string }).message, /501 characters; the limit is 500/)
  assert.ok(IDEMPOTENCY_KEY.test(newIdempotencyKey()))
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey())
})

test("client: the POST sends exactly the four fields with the Bearer only; errors are classified, bodies never echoed", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  let reply: TcReply | Error = { status: 200, body: tcEnvelope(tcChange(tcState(1, false), tcEvent(1, false, { previousPaused: true }))) }
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (reply instanceof Error) throw reply
    const text = reply.raw ?? JSON.stringify(reply.body)
    return { status: reply.status, text: async () => text }
  }
  const send = () => sendTradingControlCommand({ apiBase: "https://api.example.test", accessToken: "session.jwt", signal: new AbortController().signal, fetch, command: command() })
  const outcome = await send()
  assert.equal(outcome.ok, true)
  assert.equal(calls[0].url, `https://api.example.test${TRADING_CONTROL_PATH}`)
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.credentials, "omit")
  assert.equal(calls[0].init.cache, "no-store")
  assert.deepEqual(calls[0].init.headers, { accept: "application/json", "content-type": "application/json", authorization: "Bearer session.jwt" })
  assert.equal(calls[0].init.body, JSON.stringify({ paused: false, expectedVersion: 0, idempotencyKey: "tc-key-00000001", reason: "Reason for version 1" }))
  const cases: [TcReply | Error, string, number | null, string | null][] = [
    [{ status: 200, body: tcEnvelope(tcChange(tcState(1, true), tcEvent(1, true))) }, "invalid", 200, null],
    [{ status: 200, body: { ...tcEnvelope(tcChange(tcState(1, false), tcEvent(1, false, { previousPaused: true }))), profile: "PRODUCTION" } }, "invalid", 200, null],
    [{ status: 400, body: tcError("INVALID_TRADING_CONTROL_INPUT") }, "request", 400, "INVALID_TRADING_CONTROL_INPUT"],
    [{ status: 403, body: tcError("OPERATOR_FORBIDDEN") }, "forbidden", 403, "OPERATOR_FORBIDDEN"],
    [{ status: 404, body: { message: "Route POST:/x not found", error: "Not Found", statusCode: 404 } }, "disabled", 404, null],
    [{ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") }, "request", 409, "CONTROL_VERSION_CONFLICT"],
    [{ status: 409, body: tcError("CONTROL_IDEMPOTENCY_CONFLICT") }, "request", 409, "CONTROL_IDEMPOTENCY_CONFLICT"],
    [{ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") }, "server", 503, "TRADING_CONTROL_UNAVAILABLE"],
    [{ status: 502, raw: "<html>proxy secret-host</html>" }, "server", 502, null],
    [new TypeError("offline"), "network", null, null],
  ]
  for (const [next, kind, status, code] of cases) {
    reply = next
    const result = await send()
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.deepEqual(result.error, { kind, status, code }, JSON.stringify(next instanceof Error ? next.message : next.status))
    assert.ok(!JSON.stringify(result).includes("secret"))
  }
  assert.equal((await sendTradingControlCommand({ apiBase: "not a url", accessToken: "t", signal: new AbortController().signal, fetch, command: command() })).ok, false)
  const before = calls.length
  await sendTradingControlCommand({ apiBase: "https://api.example.test", accessToken: null, signal: new AbortController().signal, fetch, command: command() })
  assert.equal(calls.length, before, "no session, nothing sent")
})

test("client: history uses the canonical query; runtime is checked against the envelope time", async () => {
  assert.equal(historyPath(null), `${TRADING_CONTROL_PATH}/history?limit=20`)
  assert.equal(historyPath(21), `${TRADING_CONTROL_PATH}/history?limit=20&beforeVersion=21`)
  for (const bad of [0, -1, 1.5, 2_147_483_648]) assert.throws(() => historyPath(bad))
  const fetch = async () => ({ status: 200, text: async () => JSON.stringify(tcEnvelope({ ...tcRuntime(), newOrdersPaused: false })) })
  const result = await readRuntimeStatus({ apiBase: "https://api.example.test", accessToken: "t", signal: new AbortController().signal, fetch })
  assert.deepEqual(result, { ok: false, error: { kind: "invalid", status: 200, code: null } })
})

// ---------------------------------------------------------------- parity with the real server plugins

type Port = { read(): Promise<unknown>; change(operator: unknown, command: unknown): Promise<unknown>; history(limit?: number, beforeVersion?: number): Promise<unknown> }
async function controlServer(port: Port) {
  const app = Fastify({ logger: false })
  await app.register(stocksTradingControlPlugin, { service: port as never, resolveOperator: async () => ({ operatorId: "ops-control-a", permissions: ["stocks:read", "stocks:control"] }) })
  await app.ready()
  return app
}

test("parity: whatever the real trading control plugin returns, the client parses to the same values", async () => {
  const states = [tcState(0, true), tcState(1, false), tcState(7, true, { reason: "😀 emergency drill, verified" })]
  for (const state of states) {
    const app = await controlServer({ read: async () => state, change: async () => ({}), history: async () => ({}) })
    const response = await app.inject({ method: "GET", url: TRADING_CONTROL_PATH })
    assert.equal(response.statusCode, 200)
    const body = JSON.parse(response.body)
    assert.deepEqual(Object.keys(body).sort(), [...Object.keys(TC_PROFILE), "data", "observedAt"].sort())
    assert.deepEqual(parseControlRead(body.data), state)
    await app.close()
  }
  // POST: fresh and replayed-after-a-later-pause.
  for (const [state, change, replayed] of [
    [tcState(1, false, { operatorId: "ops-control-a" }), tcEvent(1, false, { previousPaused: true, operatorId: "ops-control-a" }), false],
    [tcState(2, true), tcEvent(1, false, { previousPaused: true, operatorId: "ops-control-a" }), true],
  ] as const) {
    const app = await controlServer({ read: async () => state, change: async () => ({ state, change, replayed }), history: async () => ({}) })
    const sent = command()
    const response = await app.inject({ method: "POST", url: TRADING_CONTROL_PATH, payload: sent })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(parseControlChange(JSON.parse(response.body).data, sent), { state, change, replayed })
    await app.close()
  }
  // History, both a full page with a next cursor and the last page.
  const items = [tcEvent(4, true), tcEvent(3, false)]
  const app = await controlServer({ read: async () => tcState(4, true), change: async () => ({}), history: async () => ({ items, nextBeforeVersion: 3 }) })
  const response = await app.inject({ method: "GET", url: historyPath(5, 2) })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(parseControlHistory(JSON.parse(response.body).data, { limit: 2, beforeVersion: 5 }), { items, nextBeforeVersion: 3 })
  // Error envelopes carry the fixed code the client classifies.
  const conflict = await controlServer({ read: async () => tcState(0, true), change: async () => { throw new StocksError("CONTROL_VERSION_CONFLICT", 409) }, history: async () => ({}) })
  const refused = await conflict.inject({ method: "POST", url: TRADING_CONTROL_PATH, payload: command() })
  assert.equal(refused.statusCode, 409)
  assert.deepEqual(JSON.parse(refused.body), { ...TC_PROFILE, observedAt: JSON.parse(refused.body).observedAt, data: null, error: "CONTROL_VERSION_CONFLICT" })
  await conflict.close()
  await app.close()
})

test("parity: the real runtime status plugin's output parses to the same reasons for every gate combination", async () => {
  const combos = []
  for (const runtimeState of ["RUNNING", "STOPPED"] as const)
    for (const autodispatch of [true, false])
      for (const configuredPause of [false, true])
        for (const operatorControl of [undefined, { status: "PAUSED" as const, version: 2 }, { status: "RESUMED" as const, version: 3 }, { status: "UNAVAILABLE" as const, version: null }])
          for (const observerStatus of runtimeState === "STOPPED" ? (["STOPPED"] as const) : (["CURRENT", "STALE"] as const)) combos.push({ runtimeState, autodispatch, configuredPause, operatorControl, observerStatus })
  for (const input of combos) {
    const observedAt = new Date().toISOString()
    const snapshot = { ...tcRuntime({ ...input, observedAt }), observedAt }
    const app = Fastify({ logger: false })
    await app.register(stocksRuntimeStatusPlugin, { getSnapshot: () => snapshot as never, resolveOperator: async () => ({ operatorId: "ops-read", permissions: ["stocks:read"] }) })
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/stocks/runtime" })
    assert.equal(response.statusCode, 200, `${JSON.stringify(input)} ${response.body}`)
    const body = JSON.parse(response.body)
    const parsed = parseRuntimeStatus(body.data, body.observedAt)
    assert.deepEqual(parsed.pauseReasons, body.data.pauseReasons)
    assert.equal(parsed.newOrdersPaused, body.data.newOrdersPaused)
    assert.deepEqual(parsed.operatorControl, input.operatorControl ?? null)
    await app.close()
  }
  assert.equal(combos.length, 2 * 2 * 4 * 1 + 2 * 2 * 4 * 2)
})
