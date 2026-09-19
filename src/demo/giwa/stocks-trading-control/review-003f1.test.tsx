// 003F-1 regressions from Codex's independent review of 070399c.
// CONTROL-UI-003F-P2-01: matching public history fields never identify this page's command.
// CONTROL-UI-003F-P2-02: an accepted history page is revalidated whenever the control state is established or changes.
import assert from "node:assert/strict"
import test, { after } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { RUNTIME_STATUS_PATH, TRADING_CONTROL_PATH, historyPath } from "./client"
import { parseEnvelope } from "../stocks-admin/parse"
import { TC_DIGEST, TC_NOW, controlledTcTransport, ok, tcChange, tcEnvelope, tcError, tcEvent, tcHistory, tcRead, tcRuntime, tcState } from "./fixtures"
import { parseControlEvent, parseControlStateValue } from "./parse"
import { TradingControlStore } from "./store"
import { TradingControlView } from "./TradingControlPanel"
import type { CommandState, TradingControlSnapshot } from "./types"

const HISTORY = historyPath(null)
const REASON = "Verified local reconciliation"
const B = "b".repeat(64)
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}
const stores: TradingControlStore[] = []
after(() => stores.forEach((store) => store.deactivate()))
const noop = () => {}

function setup(keys: string[] = ["operator-a-own-command"]) {
  const transport = controlledTcTransport()
  const store = new TradingControlStore({ apiBase: "https://api.example.test", session: { id: "operator-a-session", accessToken: "fake-test-token" }, fetch: transport.fetch, now: () => TC_NOW, newIdempotencyKey: () => keys.shift() ?? "operator-a-spare-key" })
  stores.push(store)
  return { store, transport }
}
function render(store: TradingControlStore) {
  return renderToStaticMarkup(
    <TradingControlView snapshot={store.getSnapshot()} now={TC_NOW} onRefresh={noop} onLoadOlder={noop} onStart={() => null} onRetry={() => null} onDiscard={noop} onDismissAbandoned={noop} onRetryAccess={noop} />,
  )
}
const text = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ")
// A matching public entry (version, action, reason) or a 409 must never be read as identifying a command.
const FALSE_CERTAINTY = /means it was recorded|shows only that one of the two was recorded|means the earlier one|a matching[^.]*(means|shows) (this|it|the earlier)/i
const NOT_IDENTIFIED = /A matching entry does not identify this command\./
const ONLY_KEY = /Only a verified answer for this command's key shows that it was recorded\./

async function firstRead(store: TradingControlStore, transport: ReturnType<typeof controlledTcTransport>) {
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(0, true))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime()))
  transport.take("GET", HISTORY).respond(ok(tcHistory([], null)))
  await flush()
}

/** A's resume never reaches the server; someone else records version 1 with the same action and reason. */
async function sameValuesRecordedElsewhere(operatorId: string) {
  const { store, transport } = setup()
  await firstRead(store, transport)
  const basis = store.getSnapshot().control.value!
  store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: basis.meta.observedAt } })
  transport.take("POST", TRADING_CONTROL_PATH).fail()
  await flush()
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(1, false, { operatorId, reason: REASON }))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "RESUMED", version: 1 } })))
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(1, false, { operatorId, reason: REASON, id: `${operatorId}-event` })], null)))
  await flush()
  assert.equal(store.getSnapshot().command?.phase, "unknown")
  return { store, transport }
}

for (const [label, operatorId] of [
  ["another operator", "operator-b"],
  ["the same operator with another key (another tab)", "ops-control-a"],
] as const) {
  test(`P2-01: ${label} records the same version, action and reason — nothing claims this command was recorded`, async () => {
    const { store } = await sameValuesRecordedElsewhere(operatorId)
    const unknown = text(render(store))
    assert.doesNotMatch(unknown, FALSE_CERTAINTY)
    assert.match(unknown, NOT_IDENTIFIED)
    assert.match(unknown, ONLY_KEY)
    // After a discard the note keeps the same uncertainty.
    store.discard()
    const discarded = text(render(store))
    assert.doesNotMatch(discarded, FALSE_CERTAINTY)
    assert.match(discarded, NOT_IDENTIFIED)
    assert.match(discarded, /This page no longer resends it, so that may stay unknown here\./)
  })
}

test("P2-01: a different action or reason at version N+1 may exclude the command; a matching one never confirms it", async () => {
  const { store } = await sameValuesRecordedElsewhere("operator-b")
  const t = text(render(store))
  assert.match(t, /If the entry at version 1 is a different action or has a different reason than “ ?Verified local reconciliation ?”, this command was not recorded, and it can no longer be\./)
})

test("P2-01: an earlier unresolved command in the same slot — neither is identified by the history; a retry settles only this one", async () => {
  const { store, transport } = setup(["operator-a-first-key", "operator-a-second-key"])
  await firstRead(store, transport)
  const basis = store.getSnapshot().control.value!
  store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: basis.meta.observedAt } })
  transport.take("POST", TRADING_CONTROL_PATH).fail()
  await flush()
  store.discard()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(0, true))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime()))
  transport.take("GET", HISTORY).respond(ok(tcHistory([], null)))
  await flush()
  const second = store.getSnapshot().control.value!
  assert.equal(store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: second.meta.observedAt } }), null)
  transport.take("POST", TRADING_CONTROL_PATH).fail()
  await flush()
  const t = text(render(store))
  assert.doesNotMatch(t, FALSE_CERTAINTY)
  assert.match(t, /The earlier unresolved command \(note above\) has the same version, action and reason; the history cannot tell the two apart\./)
  assert.match(t, /A retry of this command settles only this one: its own event in the answer \(accepted or replayed\) means this command is recorded; a version conflict \(409\) means it was not, and the entry at version 1 may then be the earlier command's or anyone else's\./)
})

// ---------------------------------------------------------------- P2-02

async function initialReads(order: "history-first" | "control-first", historyItems: unknown[], control: unknown) {
  const { store, transport } = setup()
  store.refresh()
  const answerHistory = () => transport.take("GET", HISTORY).respond(ok(tcHistory(historyItems, null)))
  const answerControl = () => {
    transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(control)))
    transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime()))
  }
  if (order === "history-first") {
    answerHistory()
    await flush()
    answerControl()
  } else {
    answerControl()
    await flush()
    answerHistory()
  }
  await flush()
  return { store, transport }
}

test("P2-02: history of deployment A accepted first, then control of B — A's entries are never shown for B; B's first page is read", async () => {
  const { store, transport } = await initialReads("history-first", [tcEvent(1, false, { reason: "A-only audit entry" })], { ...tcState(0, true), deploymentDigest: B })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.control.value?.data.deploymentDigest, B)
  assert.deepEqual(snapshot.history.items, [], "A's entries are cleared")
  assert.ok(transport.pending.some((request) => request.path === HISTORY), "B's first page is read")
  assert.doesNotMatch(text(render(store)), /A-only audit entry/)
  transport.take("GET", HISTORY).respond(ok(tcHistory([], null)))
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.deploymentDigest], ["ready", B])
  assert.match(text(render(store)), /No changes recorded for this deployment\./)
})

test("P2-02: control of B first, then a history page of A — rejected and read again once; a second mismatch is an error", async () => {
  const { store, transport } = await initialReads("control-first", [tcEvent(1, false, { reason: "A-only audit entry" })], { ...tcState(1, false), deploymentDigest: B })
  assert.deepEqual(store.getSnapshot().history.items, [])
  assert.ok(transport.pending.some((request) => request.path === HISTORY), "read again once")
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(1, false, { reason: "A-only audit entry" })], null)))
  await flush()
  const history = store.getSnapshot().history
  assert.deepEqual([history.phase, history.items.length, history.error?.kind], ["error", 0, "invalid"])
  assert.equal(transport.pending.length, 0, "no loop")
  assert.doesNotMatch(text(render(store)), /A-only audit entry/)
})

test("P2-02: a multi-page history of A, then a control read of B — pages and cursor are cleared; a late A page never mixes in", async () => {
  const { store, transport } = setup()
  const newest = Array.from({ length: 20 }, (_, i) => tcEvent(30 - i, (30 - i) % 2 === 0))
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(30, true))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "PAUSED", version: 30 } })))
  transport.take("GET", HISTORY).respond(ok(tcHistory(newest, 11)))
  await flush()
  assert.equal(store.getSnapshot().history.deploymentDigest, TC_DIGEST)
  store.loadHistory(11)
  const lateOlder = transport.take("GET", historyPath(11))
  store.loadControl()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead({ ...tcState(2, true), deploymentDigest: B })))
  await flush()
  let history = store.getSnapshot().history
  assert.deepEqual([history.items.length, history.nextBeforeVersion, history.deploymentDigest], [0, null, null], "cleared")
  assert.equal(lateOlder.init.signal?.aborted, true, "the old page read is superseded")
  lateOlder.respond(ok(tcHistory(Array.from({ length: 10 }, (_, i) => tcEvent(10 - i, (10 - i) % 2 === 0)), null)))
  await flush()
  assert.equal(store.getSnapshot().history.items.length, 0, "a late A page never lands")
  transport.take("GET", HISTORY).respond(ok(tcHistory([{ ...tcEvent(2, true), deploymentDigest: B }, { ...tcEvent(1, false, { previousPaused: true }), deploymentDigest: B }], null)))
  await flush()
  history = store.getSnapshot().history
  assert.deepEqual([history.phase, history.items.map((item) => item.version), history.deploymentDigest], ["ready", [2, 1], B])
})

test("P2-02: a failed revalidation read can be retried; same-deployment paging still continues", async () => {
  const { store, transport } = await initialReads("history-first", [tcEvent(1, false, { reason: "A-only audit entry" })], { ...tcState(25, false), deploymentDigest: B })
  transport.take("GET", HISTORY).respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.items.length], ["error", 0])
  const ofB = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ ...tcEvent(from - i, (from - i) % 2 === 0), deploymentDigest: B }))
  store.loadHistory(null)
  transport.take("GET", HISTORY).respond(ok(tcHistory(ofB(25, 20), 6)))
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.deploymentDigest, store.getSnapshot().history.nextBeforeVersion], ["ready", B, 6])
  store.loadHistory(6)
  transport.take("GET", historyPath(6)).respond(ok(tcHistory(ofB(5, 5), null)))
  await flush()
  const history = store.getSnapshot().history
  assert.deepEqual([history.items.length, history.complete, history.deploymentDigest, transport.pending.length], [25, true, B, 0])
})

test("P2-02: a delayed first page of the old deployment, answered after the new state: its entries never land; read again once", async () => {
  const { store, transport } = setup()
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(1, false))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "RESUMED", version: 1 } })))
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(1, false, { reason: "A-only audit entry" })], null)))
  await flush()
  assert.equal(store.getSnapshot().history.deploymentDigest, TC_DIGEST)
  store.refresh()
  const delayed = transport.take("GET", HISTORY)
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead({ ...tcState(0, true), deploymentDigest: B })))
  await flush()
  assert.deepEqual([store.getSnapshot().history.items.length, store.getSnapshot().history.phase], [0, "loading"], "A's entries go at once")
  assert.equal(transport.pending.filter((request) => request.path === HISTORY).length, 1, "the read in flight is checked when it arrives")
  delayed.respond(ok(tcHistory([tcEvent(1, false, { reason: "A-only audit entry" })], null)))
  await flush()
  assert.equal(store.getSnapshot().history.items.length, 0)
  assert.doesNotMatch(text(render(store)), /A-only audit entry/)
  transport.take("GET", HISTORY).respond(ok(tcHistory([], null)))
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.deploymentDigest], ["ready", B])
})

test("P2-02: a history older than the control state (lower newest version, or empty while the version is above 0) is read again", async () => {
  const { store, transport } = await initialReads("history-first", [tcEvent(1, false)], tcState(2, true))
  assert.ok(transport.pending.some((request) => request.path === HISTORY), "stale by version")
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(2, true), tcEvent(1, false)], null)))
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.items.length, store.getSnapshot().history.deploymentDigest], ["ready", 2, TC_DIGEST])
  const empty = await initialReads("history-first", [], tcState(1, false))
  assert.ok(empty.transport.pending.some((request) => request.path === HISTORY), "an empty list cannot belong to a changed state")
})

test("P2-02: an accepted POST re-reads the history exactly once through revalidation", async () => {
  const { store, transport } = setup()
  await firstRead(store, transport)
  const basis = store.getSnapshot().control.value!
  store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: basis.meta.observedAt } })
  transport.take("POST", TRADING_CONTROL_PATH).respond(ok(tcChange(tcState(1, false, { reason: REASON }), tcEvent(1, false, { previousPaused: true, reason: REASON }))))
  await flush()
  assert.equal(transport.pending.filter((request) => request.path === HISTORY).length, 1)
  assert.equal(transport.all.filter((request) => request.path === HISTORY).length, 2, "the first read and one after the POST")
})

test("P2-02: while the history is not confirmed for the shown deployment, its entries are not shown", async () => {
  const { store, transport } = setup()
  store.refresh()
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(1, false, { reason: "Unconfirmed entry" })], null)))
  await flush()
  const t = text(render(store))
  assert.doesNotMatch(t, /Unconfirmed entry/)
  assert.match(t, /The history is shown once the current state confirms which deployment it belongs to\./)
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(1, false))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "RESUMED", version: 1 } })))
  await flush()
  assert.match(text(render(store)), /Unconfirmed entry/, "confirmed once the control state matches")
})

test("P2-01: the shared-slot retry sentence is left out when this command cannot be retried", () => {
  const withSlot = (patch: Partial<TradingControlSnapshot>, command: Partial<CommandState>) =>
    text(
      renderToStaticMarkup(
        <TradingControlView
          snapshot={{ ...unknownSnapshot(), ...patch, command: { ...unknownSnapshot().command!, ...command } }}
          now={TC_NOW}
          onRefresh={noop}
          onLoadOlder={noop}
          onStart={() => null}
          onRetry={() => null}
          onDiscard={noop}
          onDismissAbandoned={noop}
          onRetryAccess={noop}
        />,
      ),
    )
  const refused = withSlot({}, { retryRefused: true, attempts: 2, error: { kind: "request", status: 400, code: "INVALID_TRADING_CONTROL_INPUT" } })
  assert.match(refused, /the history cannot tell the two apart\./)
  assert.doesNotMatch(refused, /A retry of this command settles/)
  const moved = withSlot({ control: { phase: "ready", value: { ...unknownSnapshot().control.value!, data: { ...unknownSnapshot().control.value!.data, deploymentDigest: B } }, error: null } }, {})
  assert.doesNotMatch(moved, /A retry of this command settles/)
  assert.match(withSlot({}, {}), /A retry of this command settles only this one/)
})

test("P2-02: entries confirmed for another deployment than the shown state are not shown", () => {
  const snapshot = unknownSnapshot()
  const html = (digest: string | null) =>
    text(
      renderToStaticMarkup(
        <TradingControlView
          snapshot={{ ...snapshot, command: null, abandoned: null, history: { ...snapshot.history, deploymentDigest: digest } }}
          now={TC_NOW}
          onRefresh={noop}
          onLoadOlder={noop}
          onStart={() => null}
          onRetry={() => null}
          onDiscard={noop}
          onDismissAbandoned={noop}
          onRetryAccess={noop}
        />,
      ),
    )
  assert.match(html(TC_DIGEST), /Version 1 · was paused/)
  for (const digest of [B, null]) {
    const t = html(digest)
    assert.doesNotMatch(t, /Version 1 · was paused|Newest page read at|End of history/)
    assert.match(t, /The history is shown once the current state confirms which deployment it belongs to\./)
  }
})

/** An unknown resume (key 2) after an unresolved note (key 1) in the same slot, read since: the retry is offered. */
function unknownSnapshot(): TradingControlSnapshot {
  const control = { data: parseControlStateValue(tcState(1, false, { reason: REASON })), meta: parseEnvelope(tcEnvelope(null)).meta, loadedAt: TC_NOW }
  const command: CommandState = {
    phase: "unknown",
    command: { paused: false, expectedVersion: 0, idempotencyKey: "operator-a-second-key", reason: REASON },
    basis: { paused: true, version: 0, observedAt: control.meta.observedAt, deploymentDigest: TC_DIGEST },
    attempts: 1,
    result: null,
    error: { kind: "network", status: null, code: null },
    timedOut: false,
    retryRefused: false,
    unknownSeq: 2,
  }
  return {
    scopeKey: "scope",
    access: "ok",
    control: { phase: "ready", value: control, error: null },
    runtime: { phase: "idle", value: null, error: null },
    history: { phase: "ready", items: [parseControlEvent(tcEvent(1, false, { reason: REASON }), "event")], nextBeforeVersion: null, complete: true, observedAt: control.meta.observedAt, error: null, failedPage: null, deploymentDigest: TC_DIGEST },
    command,
    abandoned: { paused: false, expectedVersion: 0, idempotencyKey: "operator-a-first-key", reason: REASON, sinceSeq: 1, deploymentDigest: TC_DIGEST },
    controlReadSeq: 3,
  }
}
