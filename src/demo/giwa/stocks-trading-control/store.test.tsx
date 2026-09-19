import assert from "node:assert/strict"
import test from "node:test"
import { TRADING_CONTROL_PATH, RUNTIME_STATUS_PATH, historyPath } from "./client"
import { TC_NOW, controlledTcTransport, ok, tcChange, tcError, tcEvent, tcHistory, tcRead, tcRuntime, tcState, type TcReply } from "./fixtures"
import { TradingControlStore, type TradingControlStoreConfig } from "./store"

const API = "https://api.example.test"
const HISTORY = historyPath(null)
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function setup(options: { ignoreAbort?: boolean; timeoutMs?: number; keys?: string[] } = {}) {
  const transport = controlledTcTransport({ ignoreAbort: options.ignoreAbort })
  let n = 0
  const keys = options.keys
  const config: TradingControlStoreConfig = {
    apiBase: API,
    session: { id: "session-a", accessToken: "token-a" },
    fetch: transport.fetch,
    now: () => TC_NOW,
    newIdempotencyKey: () => keys?.[n++] ?? `tc-test-key-${String(++n).padStart(4, "0")}`,
    commandTimeoutMs: options.timeoutMs ?? 60_000,
  }
  const store = new TradingControlStore(config)
  return { store, transport, config }
}

async function readAll(store: TradingControlStore, transport: ReturnType<typeof controlledTcTransport>, state: unknown = tcState(0, true), runtime: unknown = tcRuntime(), history: unknown = tcHistory([], null)) {
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(state)))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(runtime))
  transport.take("GET", HISTORY).respond(ok(history))
  await flush()
}

function reviewed(store: TradingControlStore) {
  const value = store.getSnapshot().control.value!
  return { version: value.data.version, paused: value.data.paused, observedAt: value.meta.observedAt }
}
const posts = (transport: ReturnType<typeof controlledTcTransport>) => transport.all.filter((request) => request.method === "POST")
const REASON = "Verified local reconciliation"
const resumeEvent = () => tcEvent(1, false, { previousPaused: true, reason: REASON })
const resumedState = () => tcState(1, false, { reason: REASON })

test("no command before the first successful read; the initial state is paused at version 0 and one command is sent once", async () => {
  const { store, transport } = setup()
  assert.equal(store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: "x" } }), "not_ready")
  assert.equal(transport.all.length, 0, "nothing sent before a read")
  await readAll(store, transport)
  const snapshot = store.getSnapshot()
  assert.deepEqual([snapshot.control.value?.data.paused, snapshot.control.value?.data.version], [true, 0])
  assert.deepEqual(snapshot.runtime.value?.data.pauseReasons, ["OPERATOR_PAUSE"])
  assert.deepEqual([snapshot.history.items.length, snapshot.history.complete], [0, true])
  assert.equal(store.start({ paused: false, reason: REASON, reviewed: { ...reviewed(store), version: 1 } }), "stale_review", "the operator must confirm what is shown")
  assert.equal(store.start({ paused: false, reason: ` ${REASON}`, reviewed: reviewed(store) }), "invalid_reason", "exactly the reviewed, trimmed reason")
  assert.equal(store.start({ paused: false, reason: REASON, reviewed: reviewed(store) }), null)
  assert.equal(store.start({ paused: false, reason: REASON, reviewed: reviewed(store) }), "busy", "a double click sends nothing more")
  assert.equal(posts(transport).length, 1)
  const post = transport.take("POST", TRADING_CONTROL_PATH)
  assert.equal(post.init.body, JSON.stringify({ paused: false, expectedVersion: 0, idempotencyKey: "tc-test-key-0001", reason: REASON }))
  assert.deepEqual(Object.keys(JSON.parse(String(post.init.body))), ["paused", "expectedVersion", "idempotencyKey", "reason"])
  assert.equal(post.authorization, "Bearer token-a")
  assert.deepEqual(Object.keys(post.init.headers as object).sort(), ["accept", "authorization", "content-type"])
  assert.equal(store.getSnapshot().command?.phase, "sending")
})

test("accepted: the POST state becomes the current value and the event is shown; history and runtime are re-read (GET only)", async () => {
  const { store, transport } = setup()
  await readAll(store, transport)
  store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
  transport.take("POST", TRADING_CONTROL_PATH).respond(ok(tcChange(resumedState(), resumeEvent()), "2026-09-19T09:00:01.000Z"))
  await flush()
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.command?.phase, "accepted")
  assert.deepEqual([snapshot.control.value?.data.paused, snapshot.control.value?.data.version, snapshot.control.value?.meta.observedAt], [false, 1, "2026-09-19T09:00:01.000Z"])
  assert.equal(snapshot.command?.result?.change.change.version, 1)
  assert.deepEqual(transport.pending.map((request) => `${request.method} ${request.path}`).sort(), [`GET ${HISTORY}`, `GET ${RUNTIME_STATUS_PATH}`].sort())
  // Resume done, yet other runtime reasons remain.
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "RESUMED", version: 1 }, configuredPause: true, observerStatus: "STALE" })))
  transport.take("GET", HISTORY).respond(ok(tcHistory([resumeEvent()], null)))
  await flush()
  assert.deepEqual(store.getSnapshot().runtime.value?.data.pauseReasons, ["CONFIGURED_PAUSE", "OBSERVER_NOT_CURRENT"])
  assert.equal(posts(transport).length, 1)
  // A new command is allowed after a finished one, from the new state.
  assert.equal(store.start({ paused: true, reason: "Pause for review", reviewed: reviewed(store) }), null)
  assert.equal(JSON.parse(String(transport.take("POST", TRADING_CONTROL_PATH).init.body)).expectedVersion, 1)
})

test("a control read still in flight when the POST answers never replaces the POST's state", async () => {
  const { store, transport } = setup({ ignoreAbort: true })
  await readAll(store, transport)
  store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
  store.loadControl()
  const oldRead = transport.take("GET", TRADING_CONTROL_PATH)
  transport.take("POST", TRADING_CONTROL_PATH).respond(ok(tcChange(resumedState(), resumeEvent())))
  await flush()
  oldRead.respond(ok(tcRead(tcState(0, true))))
  await flush()
  assert.deepEqual([store.getSnapshot().control.value?.data.version, store.getSnapshot().control.value?.data.paused], [1, false])
})

test("409 version conflict: nothing is resent; state, history and runtime are re-read; a new command needs a new key and version", async () => {
  const { store, transport } = setup()
  await readAll(store, transport)
  store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
  transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
  await flush()
  assert.equal(store.getSnapshot().command?.phase, "conflict")
  assert.equal(posts(transport).length, 1, "never resent")
  assert.equal(store.retry(), false, "a conflict is not retried")
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(1, false, { operatorId: "ops-control-b", reason: "Another operator resumed" }))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "RESUMED", version: 1 } })))
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(1, false, { previousPaused: true, operatorId: "ops-control-b", reason: "Another operator resumed" })], null)))
  await flush()
  assert.equal(store.getSnapshot().control.value?.data.version, 1)
  assert.equal(posts(transport).length, 1, "no automatic command after the re-read")
  assert.equal(store.start({ paused: true, reason: "Pause again after review", reviewed: reviewed(store) }), null)
  const second = JSON.parse(String(transport.take("POST", TRADING_CONTROL_PATH).init.body))
  assert.deepEqual([second.expectedVersion, second.idempotencyKey], [1, "tc-test-key-0002"])
})

test("refusals that prove nothing changed: 409 idempotency, 400, 403 (read-only operator), 404, 401", async () => {
  const cases: [TcReply, string | null, boolean][] = [
    [{ status: 409, body: tcError("CONTROL_IDEMPOTENCY_CONFLICT") }, "CONTROL_IDEMPOTENCY_CONFLICT", true],
    [{ status: 400, body: tcError("INVALID_TRADING_CONTROL_INPUT") }, "INVALID_TRADING_CONTROL_INPUT", false],
    [{ status: 403, body: tcError("OPERATOR_FORBIDDEN") }, "OPERATOR_FORBIDDEN", false],
    [{ status: 404, body: { message: "Route POST:/x not found", error: "Not Found", statusCode: 404 } }, null, false],
    [{ status: 401, body: { error: "Invalid bearer session token" } }, null, false],
  ]
  for (const [reply, code, rereads] of cases) {
    const { store, transport } = setup()
    await readAll(store, transport)
    store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
    transport.take("POST", TRADING_CONTROL_PATH).respond(reply)
    await flush()
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.command?.phase, "rejected", String(reply.status))
    assert.equal(snapshot.command?.error?.code ?? null, code)
    assert.equal(snapshot.access, "ok", `${reply.status}: a refused change never denies reading`)
    assert.equal(snapshot.control.value?.data.version, 0, "the state stays")
    assert.equal(store.retry(), false)
    assert.equal(transport.pending.some((request) => request.method === "GET"), rereads, `${reply.status}: re-read`)
    assert.equal(posts(transport).length, 1)
  }
})

test("unknown outcomes (503, 502, network, invalid 200, timeout): the same command and key are retried; a replay resolves it", async () => {
  const failures: [string, (request: ReturnType<ReturnType<typeof controlledTcTransport>["take"]>) => void][] = [
    ["503", (request) => request.respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })],
    ["502", (request) => request.respond({ status: 502, raw: "bad gateway" })],
    ["network", (request) => request.fail()],
    ["invalid 200", (request) => request.respond(ok(tcChange(tcState(1, true), tcEvent(1, true))))],
    ["timeout", () => {}],
  ]
  for (const [name, answer] of failures) {
    const { store, transport } = setup({ timeoutMs: name === "timeout" ? 30 : 60_000 })
    await readAll(store, transport)
    store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
    const first = transport.take("POST", TRADING_CONTROL_PATH)
    answer(first)
    if (name === "timeout") await new Promise((resolve) => setTimeout(resolve, 60))
    await flush()
    const unknown = store.getSnapshot().command!
    assert.equal(unknown.phase, "unknown", name)
    assert.equal(unknown.timedOut, name === "timeout")
    assert.equal(store.getSnapshot().control.value?.data.version, 0, `${name}: never assumed applied`)
    assert.equal(store.start({ paused: true, reason: "Something else", reviewed: reviewed(store) }), "busy", `${name}: resolve the unknown command first`)
    assert.equal(transport.pending.length, 0, `${name}: nothing else sent`)
    assert.equal(store.retry(), true)
    const second = transport.take("POST", TRADING_CONTROL_PATH)
    assert.equal(second.init.body, first.init.body, `${name}: identical command and key`)
    second.respond(ok(tcChange(resumedState(), resumeEvent(), true)))
    await flush()
    const done = store.getSnapshot().command!
    assert.deepEqual([done.phase, done.attempts], ["replayed", 2], name)
    assert.equal(posts(transport).length, 2)
  }
})

test("an old resume replayed after a later pause: the old event is shown with the current paused state", async () => {
  const { store, transport } = setup()
  await readAll(store, transport)
  store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
  transport.take("POST", TRADING_CONTROL_PATH).fail()
  await flush()
  store.retry()
  transport.take("POST", TRADING_CONTROL_PATH).respond(ok(tcChange(tcState(2, true, { operatorId: "ops-control-b", reason: "Paused again" }), resumeEvent(), true)))
  await flush()
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.command?.phase, "replayed")
  assert.deepEqual([snapshot.command?.result?.change.change.version, snapshot.command?.result?.change.change.paused], [1, false])
  assert.deepEqual([snapshot.control.value?.data.version, snapshot.control.value?.data.paused], [2, true], "the current state is the paused one")
})

test("a scope change while a command is in flight aborts it: never resent, its late answer never lands", async () => {
  for (const change of ["session", "logout", "apiBase", "deployment"] as const) {
    const { store, transport, config } = setup({ ignoreAbort: true })
    await readAll(store, transport)
    store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
    const post = transport.take("POST", TRADING_CONTROL_PATH)
    const next: TradingControlStoreConfig =
      change === "session" ? { ...config, session: { id: "session-b", accessToken: "token-b" } } : change === "logout" ? { ...config, session: null } : change === "apiBase" ? { ...config, apiBase: "https://other.example.test" } : { ...config, deploymentKey: "deployment-2" }
    store.configure(next)
    const snapshot = store.getSnapshot()
    assert.deepEqual([snapshot.command, snapshot.control.value, snapshot.history.items.length], [null, null, 0], change)
    assert.equal(post.init.signal?.aborted, true, `${change}: aborted`)
    post.respond(ok(tcChange(resumedState(), resumeEvent())))
    await flush()
    assert.equal(store.getSnapshot().command, null, `${change}: the late answer never lands`)
    assert.equal(store.getSnapshot().control.value, null)
    assert.equal(store.retry(), false)
    assert.equal(posts(transport).length, 1, `${change}: never resent`)
  }
})

test("token rotation keeps the unknown command; its retry uses the new Bearer and the same key; deactivation aborts", async () => {
  const { store, transport, config } = setup()
  await readAll(store, transport)
  store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
  const first = transport.take("POST", TRADING_CONTROL_PATH)
  first.respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  await flush()
  store.configure({ ...config, session: { id: "session-a", accessToken: "token-a2" } })
  assert.equal(store.getSnapshot().command?.phase, "unknown", "same session: kept")
  store.retry()
  const second = transport.take("POST", TRADING_CONTROL_PATH)
  assert.equal(second.authorization, "Bearer token-a2")
  assert.equal(second.init.body, first.init.body)
  store.deactivate()
  assert.equal(second.init.signal?.aborted, true)
})

test("reads: GET 403/401 clear the panel; a control 404 means not enabled; runtime 404 and 503 stay local and keep earlier values", async () => {
  for (const [status, access] of [[403, "forbidden"], [401, "unauthorized"]] as const) {
    const { store, transport } = setup()
    await readAll(store, transport)
    store.refresh()
    transport.take("GET", TRADING_CONTROL_PATH).respond({ status, body: tcError("OPERATOR_FORBIDDEN") })
    await flush()
    const snapshot = store.getSnapshot()
    assert.deepEqual([snapshot.access, snapshot.control.value, snapshot.runtime.value, snapshot.history.items.length], [access, null, null, 0])
    assert.equal(transport.pending.length, 0, "the other reads were aborted")
  }
  const { store, transport } = setup()
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond({ status: 404, body: { message: "Route GET:/x not found", error: "Not Found", statusCode: 404 } })
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: undefined })))
  transport.take("GET", HISTORY).respond({ status: 404, body: { message: "Route GET:/x not found", error: "Not Found", statusCode: 404 } })
  await flush()
  let snapshot = store.getSnapshot()
  assert.deepEqual([snapshot.access, snapshot.control.error?.kind, snapshot.runtime.phase], ["ok", "disabled", "ready"])
  assert.equal(store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: "x" } }), "not_ready")

  const second = setup()
  await readAll(second.store, second.transport)
  second.store.refresh()
  second.transport.take("GET", TRADING_CONTROL_PATH).respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  second.transport.take("GET", RUNTIME_STATUS_PATH).respond({ status: 404, body: { message: "Route GET:/x not found", error: "Not Found", statusCode: 404 } })
  second.transport.take("GET", HISTORY).fail()
  await flush()
  snapshot = second.store.getSnapshot()
  assert.deepEqual([snapshot.control.phase, snapshot.control.error?.kind, snapshot.control.value?.data.version], ["error", "server", 0], "kept, labelled by the view")
  assert.deepEqual([snapshot.runtime.phase, snapshot.runtime.error?.kind], ["error", "disabled"])
  assert.deepEqual([snapshot.history.phase, snapshot.history.error?.kind, snapshot.history.failedPage], ["error", "network", "first"])
  assert.equal(second.store.start({ paused: false, reason: REASON, reviewed: reviewed(second.store) }), "not_ready", "no command from a failed re-read")
})

test("history: newest page, then older pages to the end; a failed older page can be retried; an inconsistent page is rejected", async () => {
  const { store, transport } = setup()
  const newest = Array.from({ length: 20 }, (_, i) => tcEvent(45 - i, (45 - i) % 2 === 0))
  await readAll(store, transport, tcState(45, false), tcRuntime({ operatorControl: { status: "RESUMED", version: 45 } }), tcHistory(newest, 26))
  assert.deepEqual([store.getSnapshot().history.items.length, store.getSnapshot().history.nextBeforeVersion, store.getSnapshot().history.complete], [20, 26, false])
  store.loadHistory(99)
  assert.equal(transport.pending.length, 0, "only the offered cursor")
  store.loadHistory(26)
  transport.take("GET", historyPath(26)).fail()
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.failedPage, store.getSnapshot().history.items.length], ["error", "older", 20])
  store.loadHistory(26)
  transport.take("GET", historyPath(26)).respond(ok(tcHistory(Array.from({ length: 20 }, (_, i) => tcEvent(25 - i, (25 - i) % 2 === 0)), 6)))
  await flush()
  store.loadHistory(6)
  transport.take("GET", historyPath(6)).respond(ok(tcHistory(Array.from({ length: 5 }, (_, i) => tcEvent(5 - i, (5 - i) % 2 === 0)), null)))
  await flush()
  const history = store.getSnapshot().history
  assert.deepEqual([history.items.length, history.complete, history.nextBeforeVersion, history.items[44].version], [45, true, null, 1])
  store.loadHistory(1)
  assert.equal(transport.pending.length, 0, "nothing after the end")

  const other = setup()
  await other.store.refresh()
  other.transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(2, true))))
  other.transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "PAUSED", version: 2 } })))
  await flush()
  other.transport.take("GET", HISTORY).respond(ok(tcHistory([{ ...tcEvent(2, true), deploymentDigest: "c".repeat(64) }], null)))
  await flush()
  assert.deepEqual([other.store.getSnapshot().history.phase, other.store.getSnapshot().history.error?.kind], ["error", "invalid"], "another deployment's history is not shown")
})

test("discard: never while sending; clears a finished or unknown command; a bad key generator sends nothing", async () => {
  const { store, transport } = setup()
  await readAll(store, transport)
  store.start({ paused: false, reason: REASON, reviewed: reviewed(store) })
  assert.equal(store.discard(), false)
  transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  await flush()
  assert.equal(store.discard(), true)
  assert.equal(store.getSnapshot().command, null)
  assert.equal(store.retry(), false)

  const bad = setup({ keys: ["short"] })
  await readAll(bad.store, bad.transport)
  assert.equal(bad.store.start({ paused: false, reason: REASON, reviewed: reviewed(bad.store) }), "invalid_key")
  assert.equal(posts(bad.transport).length, 0)
})
