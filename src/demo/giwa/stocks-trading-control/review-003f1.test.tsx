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
  assert.match(t, /A retry of this command settles only this one: its own event in the answer \(accepted or replayed\) means this command is recorded; a version conflict \(409\) from the deployment it was reviewed for means it was not, and the entry at version 1 may then be the earlier command's or anyone else's\./)
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
  assert.equal(delayed.init.signal?.aborted, false, "not superseded by a second read")
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
  // Routes gone (404) after the unknown outcome: retrying is impossible from this page, so no retry is offered as a way to settle it.
  const disabled = withSlot({ control: { phase: "error", value: unknownSnapshot().control.value, error: { kind: "disabled", status: 404, code: null } }, controlReadSeq: 1 }, {})
  assert.match(disabled, /cannot be retried from this page/)
  assert.doesNotMatch(disabled, /A retry of this command settles/)
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
    otherDeploymentSeen: false,
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

// ---------------------------------------------------------------- builder review of 6b1e22c

/** An unknown resume at version 0, then a read at version 1 of the same deployment: the retry is offered. */
async function retryReady(keys: string[] = ["operator-a-own-command"]) {
  const { store, transport } = setup(keys)
  await firstRead(store, transport)
  const basis = store.getSnapshot().control.value!
  store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: basis.meta.observedAt } })
  transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  await flush()
  store.loadControl()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(1, false, { reason: REASON }))))
  await flush()
  assert.equal(store.retry(), null)
  return { store, transport }
}

test("COPY-003F1-01: a 409 on a retry is not proof for the reviewed deployment when the state read after it is another deployment's; closing keeps a note", async () => {
  const { store, transport } = await retryReady()
  transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
  await flush()
  assert.equal(store.getSnapshot().command?.phase, "conflict")
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead({ ...tcState(3, true), deploymentDigest: B })))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "PAUSED", version: 3 } })))
  await flush()
  const t = text(render(store))
  assert.match(t, /If this answer came from deployment 5f0c2b…a2c4 ?5f0c2b7d9e41a3c6b8d0f2e4a6c8b0d2f4e6a8c0b2d4f6e8a0c2e4b6d8f0a2c4 ?, the one this command was reviewed for, it also shows that the earlier attempt with this key was not recorded there/)
  assert.match(t, /The state read after it is for another deployment, so this answer may have come from that one: whether the earlier attempt was recorded is not known, and closing it or starting a new command keeps it as an unresolved note\./)
  assert.doesNotMatch(t, /Because the server checks the key before the version, this also shows/)
  assert.equal(store.discard(), true)
  const note = store.getSnapshot().abandoned
  assert.deepEqual([note?.idempotencyKey, note?.deploymentDigest], ["operator-a-own-command", TC_DIGEST])
  assert.match(text(render(store)), /This command was for deployment 5f0c2b…a2c4 ?5f0c2b7d9e41a3c6b8d0f2e4a6c8b0d2f4e6a8c0b2d4f6e8a0c2e4b6d8f0a2c4 ?; the history shown is for another deployment and cannot tell whether it was recorded\./)
})

test("COPY-003F1-01: a 409 on a retry followed by a read of the same deployment closes without a note; a read still pending keeps one", async () => {
  const same = await retryReady()
  same.transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
  await flush()
  same.transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(2, true))))
  await flush()
  assert.doesNotMatch(text(render(same.store)), /The state read after it is for another deployment/)
  same.store.discard()
  assert.equal(same.store.getSnapshot().abandoned, null)
  const pending = await retryReady()
  pending.transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
  await flush()
  pending.store.discard()
  assert.equal(pending.store.getSnapshot().abandoned?.idempotencyKey, "operator-a-own-command", "no read after the conflict yet")
})

test("STORE-P2-02-A: after a first page was rejected, a control state of another deployment reads the history for it", async () => {
  const { store, transport } = setup()
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(0, true))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime()))
  await flush()
  const ofB = [{ ...tcEvent(1, false), deploymentDigest: B }]
  for (let i = 0; i < 2; i++) {
    transport.take("GET", HISTORY).respond(ok(tcHistory(ofB, null)))
    await flush()
  }
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.error?.kind], ["error", "invalid"])
  store.refresh()
  transport.take("GET", HISTORY).respond(ok(tcHistory(ofB, null)))
  await flush()
  assert.equal(store.getSnapshot().history.phase, "error", "still compared with the earlier state")
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead({ ...tcState(1, false), deploymentDigest: B })))
  await flush()
  transport.take("GET", HISTORY).respond(ok(tcHistory(ofB, null)))
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.deploymentDigest, store.getSnapshot().history.items.length], ["ready", B, 1])
})

test("STORE-P2-02-B: an accepted POST reads a history whose first page had failed", async () => {
  const { store, transport } = setup()
  store.refresh()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(0, true))))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime()))
  transport.take("GET", HISTORY).respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  await flush()
  const basis = store.getSnapshot().control.value!
  store.start({ paused: false, reason: REASON, reviewed: { version: 0, paused: true, observedAt: basis.meta.observedAt } })
  transport.take("POST", TRADING_CONTROL_PATH).respond(ok(tcChange(tcState(1, false, { reason: REASON }), tcEvent(1, false, { previousPaused: true, reason: REASON }))))
  await flush()
  transport.take("GET", HISTORY).respond(ok(tcHistory([tcEvent(1, false, { previousPaused: true, reason: REASON })], null)))
  await flush()
  assert.deepEqual([store.getSnapshot().history.phase, store.getSnapshot().history.items.length, store.getSnapshot().history.deploymentDigest], ["ready", 1, TC_DIGEST])
})

test("P2-02: an empty list read before another deployment's state is never shown as that deployment's, even after its re-read fails", async () => {
  const { store, transport } = await initialReads("history-first", [], { ...tcState(2, true), deploymentDigest: B })
  transport.take("GET", HISTORY).respond({ status: 503, body: tcError("TRADING_CONTROL_UNAVAILABLE") })
  await flush()
  const t = text(render(store))
  assert.doesNotMatch(t, /No changes recorded for this deployment|No changes were recorded as of the earlier read/)
  assert.match(t, /The history is shown once the current state confirms which deployment it belongs to\./)
})

// ---------------------------------------------------------------- builder review round 2 (2b50e9a)

/** A retry of an unknown resume met 409, then the read after it showed deployment B at version 3. */
async function conflictThenOtherDeployment() {
  const { store, transport } = await retryReady(["operator-a-own-command", "operator-a-next-command"])
  transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
  await flush()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead({ ...tcState(3, true), deploymentDigest: B })))
  transport.take("GET", RUNTIME_STATUS_PATH).respond(ok(tcRuntime({ operatorControl: { status: "PAUSED", version: 3 } })))
  await flush()
  return { store, transport }
}

test("R2-01: starting a new command after an unresolved retry conflict keeps the earlier command as a note", async () => {
  const { store, transport } = await conflictThenOtherDeployment()
  const shown = store.getSnapshot().control.value!
  assert.equal(store.start({ paused: false, reason: "Resume on the deployment now served", reviewed: { version: 3, paused: true, observedAt: shown.meta.observedAt } }), null)
  const snapshot = store.getSnapshot()
  assert.deepEqual([snapshot.abandoned?.idempotencyKey, snapshot.abandoned?.deploymentDigest, snapshot.command?.command.idempotencyKey], ["operator-a-own-command", TC_DIGEST, "operator-a-next-command"])
  assert.equal(JSON.parse(String(transport.take("POST", TRADING_CONTROL_PATH).init.body)).expectedVersion, 3)
  // On the reviewed deployment (no other seen), the conflict is settled and a new command leaves no note.
  const same = await retryReady(["operator-a-own-command", "operator-a-next-command"])
  same.transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
  await flush()
  same.transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(2, true))))
  await flush()
  const read = same.store.getSnapshot().control.value!
  assert.equal(same.store.start({ paused: false, reason: "Resume after the conflict", reviewed: { version: 2, paused: true, observedAt: read.meta.observedAt } }), null)
  assert.equal(same.store.getSnapshot().abandoned, null)
})

test("R2-02: an access denial on the reads after a retry's 409 keeps the command as a note", async () => {
  for (const [path, status, access] of [
    [TRADING_CONTROL_PATH, 403, "forbidden"],
    [RUNTIME_STATUS_PATH, 401, "unauthorized"],
  ] as const) {
    const { store, transport } = await retryReady()
    transport.take("POST", TRADING_CONTROL_PATH).respond({ status: 409, body: tcError("CONTROL_VERSION_CONFLICT") })
    await flush()
    transport.take("GET", path).respond({ status, body: tcError(status === 403 ? "OPERATOR_FORBIDDEN" : "UNAUTHORIZED") })
    await flush()
    const snapshot = store.getSnapshot()
    assert.deepEqual([snapshot.access, snapshot.abandoned?.idempotencyKey], [access, "operator-a-own-command"], path)
    assert.match(text(render(store)), /A resume command sent from this page \(key operat…mand ?operator-a-own-command ?\) has no verified result\./)
  }
})

test("F3: once a read after a retry's 409 showed another deployment, a later read of the reviewed one does not settle it", async () => {
  const { store, transport } = await conflictThenOtherDeployment()
  store.loadControl()
  transport.take("GET", TRADING_CONTROL_PATH).respond(ok(tcRead(tcState(2, true))))
  await flush()
  assert.equal(store.getSnapshot().control.value?.data.deploymentDigest, TC_DIGEST)
  const t = text(render(store))
  assert.match(t, /A state read after it showed another deployment, so this answer may have come from that one: whether the earlier attempt was recorded is not known, and closing it or starting a new command keeps it as an unresolved note\./)
  store.discard()
  assert.equal(store.getSnapshot().abandoned?.idempotencyKey, "operator-a-own-command")
})
