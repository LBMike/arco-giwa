import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import { parseEnvelope } from "../stocks-admin/parse"
import { TC_DIGEST, TC_NOW, TC_OBSERVED_AT, tcEnvelope, tcEvent, tcRuntime, tcState } from "./fixtures"
import { parseControlEvent, parseControlStateValue, parseRuntimeStatus } from "./parse"
import { TradingControlView, type TradingControlViewProps } from "./TradingControlPanel"
import type { CommandState, HistoryState, ResourceState, RuntimeStatus, StocksAdminError, TradingControlSnapshot, TradingControlState } from "./types"

const META = parseEnvelope(tcEnvelope(null)).meta
const noop = () => {}
const loaded = <T,>(data: T): ResourceState<T> => ({ phase: "ready", value: { data, meta: META, loadedAt: TC_NOW - 5_000 }, error: null })
const failed = (kind: StocksAdminError["kind"], status: number | null = null, code: string | null = null) => ({ kind, status, code })
const state = (version: number, paused: boolean, options?: Parameters<typeof tcState>[2]): TradingControlState => parseControlStateValue(tcState(version, paused, options))
const runtime = (input: Parameters<typeof tcRuntime>[0] = {}): RuntimeStatus => parseRuntimeStatus(tcRuntime(input), TC_OBSERVED_AT)
// Confirmed for the shown deployment (the store confirms a list against the control state; see store.test / review-003f1).
const EMPTY_HISTORY: HistoryState = { phase: "ready", items: [], nextBeforeVersion: null, complete: true, observedAt: TC_OBSERVED_AT, error: null, failedPage: null, deploymentDigest: TC_DIGEST }

function snapshot(patch: Partial<TradingControlSnapshot> = {}): TradingControlSnapshot {
  return { scopeKey: "scope", access: "ok", control: loaded(state(0, true)), runtime: loaded(runtime()), history: EMPTY_HISTORY, command: null, abandoned: null, controlReadSeq: 1, ...patch }
}
function render(value: TradingControlSnapshot, extra: Partial<TradingControlViewProps> = {}) {
  return renderToStaticMarkup(
    <TradingControlView snapshot={value} now={TC_NOW} onRefresh={noop} onLoadOlder={noop} onStart={() => null} onRetry={() => null} onDiscard={noop} onDismissAbandoned={noop} onRetryAccess={noop} {...extra} />,
  )
}
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
}
const OVERCLAIMS = /trading (is )?(open|resumed)\b|trading has resumed|transactions (were|are) cancelled|cancelled (all|every)|emergency stop (is|was) (on|active)|guaranteed/i

function command(phase: CommandState["phase"], patch: Partial<CommandState> = {}): CommandState {
  return {
    phase,
    command: { paused: false, expectedVersion: 0, idempotencyKey: "tc-test-key-0001", reason: "Verified local reconciliation" },
    basis: { paused: true, version: 0, observedAt: TC_OBSERVED_AT, deploymentDigest: state(0, true).deploymentDigest },
    attempts: 1,
    result: null,
    error: null,
    timedOut: false,
    retryRefused: false,
    unknownSeq: null,
    ...patch,
  }
}
const event = (version: number, paused: boolean, options?: Parameters<typeof tcEvent>[2]) => parseControlEvent(tcEvent(version, paused, options), "e")

test("initial state: paused at version 0, no change recorded, new orders paused, and a reviewed resume is offered", () => {
  const t = text(render(snapshot()))
  assert.match(t, /Manual gate: Paused version 0/)
  assert.match(t, /No change recorded yet\. An enabled deployment starts paused at version 0 until an operator resumes it\./)
  assert.match(t, /New orders paused as reported by this API process/)
  assert.match(t, /Manual pause — The operator gate, as this process last cached it\./)
  assert.match(t, /The manual gate is paused \(version 0, read 2026-09-19T09:00:00\.000Z\)\. Possible change: resume the manual gate\. The server decides whether this session may make it\./)
  assert.doesNotMatch(t, /You can (resume|pause)/, "no permission statement")
  assert.match(t, /Review resume/)
  assert.match(t, /No changes recorded for this deployment\./)
  assert.match(t, /stored in the database and are not deleted automatically/)
  assert.doesNotMatch(t, OVERCLAIMS)
})

test("resumed manual gate with other runtime reasons: never shown as trading resumed; the remaining reasons are listed", () => {
  const t = text(render(snapshot({ control: loaded(state(1, false)), runtime: loaded(runtime({ operatorControl: { status: "RESUMED", version: 1 }, configuredPause: true, observerStatus: "STALE" })) })))
  assert.match(t, /Manual gate: Resumed version 1/)
  assert.match(t, /The manual gate is resumed; that alone does not resume trading New orders are still paused by: Configured pause, Chain observation not current\./)
  assert.match(t, /New orders paused/)
  assert.match(t, /Possible change: pause new orders\./)
  assert.doesNotMatch(t, OVERCLAIMS)
  // Control store unavailable to the process is a remaining reason too.
  const unavailable = text(render(snapshot({ control: loaded(state(1, false)), runtime: loaded(runtime({ operatorControl: { status: "UNAVAILABLE", version: null } })) })))
  assert.match(unavailable, /still paused by: Manual gate unavailable to this process/)
  // Unknown runtime: never "open".
  const unknown = text(render(snapshot({ control: loaded(state(1, false)), runtime: { phase: "error", value: null, error: failed("server", 503, "RUNTIME_STATUS_UNAVAILABLE") } })))
  assert.match(unknown, /Whether new orders are admitted is unknown until runtime status can be read\./)
  assert.match(unknown, /Runtime status unavailable \(503\).*Whether new orders are admitted is not known from this page\./)
  // No reason reported: a diagnostic, not permission.
  const none = text(render(snapshot({ control: loaded(state(1, false)), runtime: loaded(runtime({ operatorControl: { status: "RESUMED", version: 1 } })) })))
  assert.match(none, /No pause reason reported as reported by this API process/)
  assert.match(none, /It is a diagnostic, not permission: every order is still checked by the server when it arrives\./)
  assert.doesNotMatch(none, OVERCLAIMS)
})

test("the runtime's cached manual gate is labelled as cached and flagged when it differs from the database state", () => {
  const t = text(render(snapshot({ control: loaded(state(2, false)), runtime: loaded(runtime({ operatorControl: { status: "PAUSED", version: 1 } })) })))
  assert.match(t, /This process's cached manual gate Paused, version 1 Cached for up to 5 seconds; it can lag behind the database state\. It differs from the manual gate read above; read both again in a few seconds\./)
  const absent = text(render(snapshot({ runtime: loaded(runtime({ operatorControl: undefined })) })))
  assert.match(absent, /Not reported \(this server runs without operator controls in its runtime status\)\./)
})

test("review shows the current state and the exact change; pause and resume warnings say what they do not do", () => {
  const resume = text(render(snapshot({ runtime: loaded(runtime({ configuredPause: true })) }), { initialDraft: { step: "review", reason: "  Verified local reconciliation " } }))
  assert.match(resume, /Current state \(as read\) Paused · version 0 · server response 2026-09-19T09:00:00\.000Z/)
  assert.match(resume, /Change to send Resume the manual gate\. The server records it as version 1 only if the state is still version 0; otherwise it refuses and nothing changes\./)
  assert.match(resume, /Reason Verified local reconciliation /)
  assert.match(resume, /What a resume does It clears the manual gate only\. New orders stay paused while any other reason remains: Configured pause \(as last reported\)\./)
  assert.match(resume, /Confirm resume Back/)
  const pause = text(render(snapshot({ control: loaded(state(1, false)), runtime: loaded(runtime({ operatorControl: { status: "RESUMED", version: 1 } })) }), { initialDraft: { step: "review", reason: "Drill" } }))
  assert.match(pause, /Change to send Pause new orders\./)
  assert.match(pause, /What a pause does New admissions that check the manual gate are blocked\. Transactions that were already approved or sent are not cancelled, issued wallet requests and execution policies stay valid, and in-flight work may still complete\. Order lookup and hash recovery stay available\./)
  assert.match(pause, /Confirm pause/)
  const noRuntime = text(render(snapshot({ runtime: { phase: "error", value: null, error: failed("disabled", 404) } }), { initialDraft: { step: "review", reason: "x" } }))
  assert.match(noRuntime, /runtime status is not available, so the other reasons are unknown/)
})

test("no command from a missing, failed or stale read; earlier data is labelled as earlier", () => {
  const loading = text(render(snapshot({ control: { phase: "loading", value: null, error: null } })))
  assert.match(loading, /Reading the current state…/)
  assert.doesNotMatch(loading, /Review resume|Review pause/)
  const stale = render(snapshot({ control: { ...loaded(state(3, true)), phase: "error", error: failed("server", 503, "TRADING_CONTROL_UNAVAILABLE") } }))
  const t = text(stale)
  assert.match(t, /Trading control state unavailable \(503\) The server could not provide it\. The result could not be read\. The state below is from an earlier read at 2026-09-19T09:00:00\.000Z; it may no longer be current\. Read it again before changing it\./)
  assert.match(t, /Read the current state successfully before changing it\./)
  assert.doesNotMatch(t, /Review resume|Review pause/)
  const history = text(render(snapshot({ history: { ...EMPTY_HISTORY, phase: "error", items: [event(2, true)], complete: false, nextBeforeVersion: null, error: failed("network"), failedPage: "first" } })))
  assert.match(history, /The entries below are from an earlier read at 2026-09-19T09:00:00\.000Z; they may not include later changes\./)
})

test("control 404 means not enabled: no command, no history; access states show nothing from earlier reads", () => {
  const t = text(render(snapshot({ control: { phase: "error", value: null, error: failed("disabled", 404) }, runtime: loaded(runtime({ operatorControl: undefined })) })))
  assert.match(t, /Trading control is not enabled on this server \(404\) The trading control routes are not registered here, so nothing can be paused or resumed from this page\./)
  assert.match(t, /Not available: trading control is not enabled on this server\./)
  assert.doesNotMatch(t, /Change history/)
  for (const [access, copy] of [
    ["forbidden", /No access to trading control \(403\)/],
    ["unauthorized", /Session not accepted \(401\)/],
    ["signed_out", /Operator session required/],
  ] as const) {
    const html = render(snapshot({ access }), { onSignInRequired: noop })
    assert.match(text(html), copy)
    assert.doesNotMatch(text(html), /Manual gate:|version 0|Change history/)
  }
})

test("outcomes: sending, accepted, replayed (old event, later state), conflict, refused, unknown", () => {
  const sending = text(render(snapshot({ command: command("sending") })))
  assert.match(sending, /Sending the resume command… Attempt 1, key tc-tes…0001 tc-test-key-0001 ?\. Waiting for the server's answer\. No new command can be started until this one is answered, or until its unknown result is discarded\./)
  assert.doesNotMatch(sending, /Review resume|Confirm resume/, "no second command while sending")

  const accepted = command("accepted", { result: { change: { state: state(1, false, { reason: "Verified local reconciliation" }), change: event(1, false, { previousPaused: true, reason: "Verified local reconciliation" }), replayed: false }, meta: META } })
  const a = text(render(snapshot({ control: loaded(state(1, false)), runtime: loaded(runtime({ configuredPause: true, operatorControl: { status: "RESUMED", version: 1 } })), command: accepted })))
  assert.match(a, /Recorded: the resume command This request's audit event: Version 1: Paused → Resumed at 2026-09-19 08:01:00 UTC by ops-control-a ?\. Reason: Verified local reconciliation/)
  assert.match(a, /Manual gate in this response \(2026-09-19T09:00:00\.000Z\): Resumed · version 1\./)
  assert.match(a, /This is not a full trading resume\. Still paused by: Configured pause \(as last reported\)\./)
  assert.doesNotMatch(a, OVERCLAIMS)

  const replayed = command("replayed", { attempts: 2, result: { change: { state: state(2, true, { operatorId: "ops-control-b" }), change: event(1, false, { previousPaused: true, reason: "Verified local reconciliation" }), replayed: true }, meta: META } })
  const r = text(render(snapshot({ control: loaded(state(2, true)), command: replayed })))
  assert.match(r, /Already recorded earlier: the resume command \(replayed\) The server returned this command's original event; nothing was changed again\./)
  assert.match(r, /Manual gate in this response \(2026-09-19T09:00:00\.000Z\): Paused · version 2\. It differs from this request's event: a later change \(version 2\) had been recorded by then\./)
  assert.doesNotMatch(r, /not a full trading resume/, "an old resume is not presented as resuming now")

  const conflict = text(render(snapshot({ command: command("conflict", { error: failed("request", 409, "CONTROL_VERSION_CONFLICT") }) })))
  assert.match(conflict, /Not applied: the state changed first \(409\) The resume was based on version 0, but the state had already moved on, so the server changed nothing for this request\. The current state was read again \(shown above\)\..*this command will not be resent\./)
  const failedReread = text(render(snapshot({ control: { ...loaded(state(1, false)), phase: "error", error: failed("server", 503) }, command: command("conflict", { error: failed("request", 409, "CONTROL_VERSION_CONFLICT") }) })))
  assert.match(failedReread, /Reading the current state again failed; read it successfully before starting a new command\./)
  const rereading = text(render(snapshot({ control: { ...loaded(state(1, false)), phase: "loading" }, command: command("conflict", { error: failed("request", 409, "CONTROL_VERSION_CONFLICT") }) })))
  assert.match(rereading, /The current state is being read again\./)

  const refusals: [StocksAdminError, RegExp][] = [
    [failed("forbidden", 403, "OPERATOR_FORBIDDEN"), /The server refused the change \(403\)\. This session may not change trading control \(stocks:control\), or the session could not be verified\. Nothing was changed\./],
    [failed("request", 409, "CONTROL_IDEMPOTENCY_CONFLICT"), /this command's key is already recorded for a different command \(409\)\. This request changed nothing\./],
    [failed("disabled", 404), /The change route is not available on this server \(404\)\. Nothing was changed\./],
    [failed("request", 400, "INVALID_TRADING_CONTROL_INPUT"), /rejected the command as invalid \(400\)\. Nothing was changed\./],
  ]
  for (const [error, copy] of refusals) {
    const t = text(render(snapshot({ command: command("rejected", { error }) })))
    assert.match(t, /Not applied: the resume command was refused/)
    assert.match(t, copy)
  }

  const unknowns: [Partial<CommandState>, RegExp][] = [
    [{ error: failed("server", 503, "TRADING_CONTROL_UNAVAILABLE") }, /the server reported that the control result is unavailable \(503\)/],
    [{ error: failed("network") }, /the connection failed before an answer arrived/],
    [{ error: failed("invalid", 200) }, /the answer did not match the contract/],
    [{ error: failed("aborted"), timedOut: true }, /no answer arrived in time/],
  ]
  for (const [patch, why] of unknowns) {
    // Read after the unknown outcome (mark 2 > 1): the retry is offered.
    const html = render(snapshot({ controlReadSeq: 2, command: command("unknown", { attempts: 2, unknownSeq: 1, ...patch }) }))
    const t = text(html)
    assert.match(t, /Result unknown: the resume may or may not have been recorded/)
    assert.match(t, why)
    // The short key is followed by its full value for screen readers.
    assert.match(t, /Do not assume that the resume failed or succeeded\. Attempt 2, key tc-tes…0001 tc-test-key-0001 ?\./)
    // 003F-1 P2-01: entries carry no key, so a matching one never identifies this command; a different one excludes it.
    assert.match(t, /The change history shows no keys, so it cannot confirm this command: another operator, another tab or another command can record the same version 1 resume with the same reason\. A matching entry does not identify this command\. If the entry at version 1 is a different action or has a different reason than “ ?Verified local reconciliation ?”, this command was not recorded, and it can no longer be\. Only a verified answer for this command's key shows that it was recorded\./)
    assert.doesNotMatch(t, /means it was recorded|This page no longer resends it/)
    assert.match(t, /Retry the same command Read state and history Discard this command/)
    assert.doesNotMatch(t, /Review resume|Review pause/, "no new command while the result is unknown")
    assert.match(html, /data-outcome="unknown"/)
    // Not read since the outcome: read first, no Retry.
    const first = text(render(snapshot({ controlReadSeq: 1, command: command("unknown", { attempts: 2, unknownSeq: 3, ...patch }) })))
    assert.match(first, /Read the state and history first\. Retrying becomes available after a successful read taken now/)
    assert.doesNotMatch(first, /Retry the same command/)
  }
})

test("history: newest first with Load older, an explicit end, and a retry after a failed older page", () => {
  const items = [event(3, true), event(2, false), event(1, true, { previousPaused: true })]
  const more = text(render(snapshot({ history: { ...EMPTY_HISTORY, items, complete: false, nextBeforeVersion: 1 } })))
  assert.match(more, /Paused Version 3 · was resumed .* By ops-control-a · Reason for version 3/)
  assert.match(more, /Load older changes/)
  const end = text(render(snapshot({ history: { ...EMPTY_HISTORY, items } })))
  assert.match(end, /End of history: no older changes\./)
  const html = render(snapshot({ history: { ...EMPTY_HISTORY, items, complete: false, nextBeforeVersion: 1, phase: "error", error: failed("server", 503), failedPage: "older" } }))
  assert.match(text(html), /Older changes could not be read; the entries below were read earlier\./)
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Load older changes/, "an older page that failed can be retried")
  const order = [...html.matchAll(/data-version="(\d+)"/g)].map((match) => Number(match[1]))
  assert.deepEqual(order, [3, 2, 1])
})

test("only the reviewed command controls exist; every button is one of a fixed set", () => {
  const htmls = [
    render(snapshot()),
    render(snapshot(), { initialDraft: { step: "review", reason: "x" } }),
    render(snapshot({ controlReadSeq: 3, command: command("unknown", { error: failed("network"), unknownSeq: 2 }) })),
    render(snapshot({ command: command("conflict", { error: failed("request", 409, "CONTROL_VERSION_CONFLICT") }) })),
    render(snapshot({ history: { ...EMPTY_HISTORY, items: [event(1, false, { previousPaused: true })], complete: false, nextBeforeVersion: 1 } })),
    render(snapshot({ access: "unauthorized" }), { onSignInRequired: noop }),
  ]
  const allowed = /^(Refresh(ing…)?|Review (pause|resume)|Confirm (pause|resume)|Back|Close|Retry the same command|Read state and history|Discard this command|Load older changes|Loading…|Sign in with operator wallet|Check access again)$/
  for (const html of htmls) {
    for (const match of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) assert.match(text(match[1]).trim(), allowed)
    assert.doesNotMatch(html, /<form\b|type="submit"/)
  }
})

test("sources: POST only in the client, to the trading control path; no stored credentials, role headers, operator ids or fixtures", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx$/.test(name) && name !== "fixtures.ts")
  assert.ok(sources.includes("client.ts") && sources.includes("TradingControlPanel.tsx"))
  for (const name of sources) {
    const source = readFileSync(path.join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.doesNotMatch(source, /x-operator-token|operatorToken|x-role|localStorage|sessionStorage|indexedDB|document\.cookie/, name)
    assert.doesNotMatch(source, /from "\.\/fixtures"/, name)
    assert.doesNotMatch(source, /parseFloat|toFixed/, name)
    assert.doesNotMatch(source, /ethereum|eth_send|sendTransaction|signMessage/, name)
    if (name !== "client.ts") assert.doesNotMatch(source, /method: "(POST|PUT|PATCH|DELETE)"/, name)
  }
  const client = readFileSync(path.join(dir, "client.ts"), "utf8")
  assert.equal((client.match(/method: "POST"/g) ?? []).length, 1)
  assert.doesNotMatch(client, /method: "(PUT|PATCH|DELETE)"/)
})

// ---------------------------------------------------------------- review round 1 (builder-side adversarial review)

test("retained values are never stated as the present: gate card, admission notice and empty history", () => {
  const gateError = { ...loaded(state(4, false)), phase: "error" as const, error: failed("server", 503, "TRADING_CONTROL_UNAVAILABLE") }
  const runtimeError = { ...loaded(runtime({ operatorControl: { status: "RESUMED", version: 4 }, configuredPause: true })), phase: "error" as const, error: failed("network") }
  const t = text(render(snapshot({ control: gateError, runtime: runtimeError })))
  assert.match(t, /At the earlier read \(2026-09-19T09:00:00\.000Z\) the manual gate was resumed; that alone does not resume trading As last reported \(2026-09-19T09:00:00\.000Z\), new orders were still paused by: Configured pause\./)
  assert.doesNotMatch(t, /The manual gate is resumed;/)
  assert.match(t, /The report below is from an earlier read at 2026-09-19T09:00:00\.000Z; it may no longer be current\./)
  const empty = text(render(snapshot({ history: { ...EMPTY_HISTORY, phase: "error", error: failed("server", 503), failedPage: "first" } })))
  assert.match(empty, /No changes were recorded as of the earlier read at 2026-09-19T09:00:00\.000Z\./)
  assert.doesNotMatch(empty, /No changes recorded for this deployment\./)
  // Before a command whose result is unknown, the shown state may be outdated.
  const unknown = text(render(snapshot({ controlReadSeq: 1, command: command("unknown", { error: failed("network"), unknownSeq: 2 }) })))
  assert.match(unknown, /Read before a command whose result is unknown The state below was read at 2026-09-19T09:00:00\.000Z, before that command's outcome; it may no longer be current\./)
  const reread = text(render(snapshot({ control: loaded(state(1, false)), controlReadSeq: 3, command: command("unknown", { error: failed("network"), unknownSeq: 2 }) })))
  assert.doesNotMatch(reread, /Read before a command whose result is unknown/)
  const sending = text(render(snapshot({ command: command("sending") })))
  assert.match(sending, /A command is being sent The state below \(read at 2026-09-19T09:00:00\.000Z\) may or may not include it\. Read it again once the command is answered\./)
  // A resumed gate read before an unresolved command is stated in the past tense, and no new command starts from it.
  const resumedBefore = text(render(snapshot({ control: loaded(state(1, false)), controlReadSeq: 1, abandoned: { paused: true, expectedVersion: 1, idempotencyKey: "tc-test-key-0009", reason: "Pause drill", sinceSeq: 4, deploymentDigest: state(0, true).deploymentDigest } })))
  assert.match(resumedBefore, /At the earlier read \(2026-09-19T09:00:00\.000Z\) the manual gate was resumed; that alone does not resume trading/)
  assert.match(resumedBefore, /The state above was read before a command whose result is unknown\. Read it again before starting a new command\./)
  assert.doesNotMatch(resumedBefore, /Review pause/)
})

test("remaining reasons include the control store and unknown runtime; in-flight warnings stay in header and pause outcome", () => {
  const unavailable = loaded(runtime({ operatorControl: { status: "UNAVAILABLE", version: null } }))
  const review = text(render(snapshot({ runtime: unavailable }), { initialDraft: { step: "review", reason: "x" } }))
  assert.match(review, /New orders stay paused while any other reason remains: Manual gate unavailable to this process \(as last reported\)\./)
  const acceptedResume = (runtimeState: TradingControlSnapshot["runtime"]) =>
    text(render(snapshot({ control: loaded(state(1, false)), runtime: runtimeState, command: command("accepted", { result: { change: { state: state(1, false, { reason: "Verified local reconciliation" }), change: event(1, false, { previousPaused: true, reason: "Verified local reconciliation" }), replayed: false }, meta: META } }) })))
  assert.match(acceptedResume(unavailable), /This is not a full trading resume\. Still paused by: Manual gate unavailable to this process \(as last reported\)\./)
  assert.match(acceptedResume({ phase: "error", value: null, error: failed("server", 503) }), /This is not a full trading resume\. Whether other reasons remain is unknown until runtime status is read\./)
  const header = text(render(snapshot()))
  assert.match(header, /It is not an emergency stop: pausing does not cancel transactions that were already approved or sent, and in-flight work may still complete\. Order lookup and hash recovery stay available\./)
  const pause = command("accepted", {
    command: { paused: true, expectedVersion: 1, idempotencyKey: "tc-test-key-0002", reason: "Drill" },
    result: { change: { state: state(2, true, { reason: "Drill" }), change: event(2, true, { reason: "Drill" }), replayed: false }, meta: META },
  })
  assert.match(text(render(snapshot({ control: loaded(state(2, true)), command: pause }))), /Transactions already approved or sent are not cancelled; in-flight work may still complete\./)
  // A replayed resume after a later pause and resume: same paused value, later version.
  const later = command("replayed", { result: { change: { state: state(3, false), change: event(1, false, { previousPaused: true, reason: "Verified local reconciliation" }), replayed: true }, meta: META } })
  const t = text(render(snapshot({ control: loaded(state(3, false)), command: later })))
  assert.match(t, /Resumed · version 3\. It differs from this request's event: a later change \(version 3\) had been recorded by then\./)
  assert.doesNotMatch(t, /not a full trading resume/)
})

test("a refused retry, a changed deployment and an abandoned command stay unknown and say what is and is not known", () => {
  const refused = text(render(snapshot({ controlReadSeq: 3, command: command("unknown", { attempts: 2, unknownSeq: 2, retryRefused: true, error: failed("forbidden", 403, "OPERATOR_FORBIDDEN") }) })))
  assert.match(refused, /Result unknown: the resume may or may not have been recorded No verifiable answer: the retry was refused \(403 OPERATOR_FORBIDDEN\): this session may not change trading control now, or it could not be verified\. That refusal only concerns the retry; the earlier attempt may still have been recorded\./)
  assert.doesNotMatch(refused, /Nothing was changed/)
  for (const [error, copy] of [
    [failed("request", 400, "INVALID_TRADING_CONTROL_INPUT"), /the identical command was refused as invalid \(400 INVALID_TRADING_CONTROL_INPUT\), so retrying cannot help/],
    [failed("request", 409, "CONTROL_IDEMPOTENCY_CONFLICT"), /this key as already recorded with different details \(409 CONTROL_IDEMPOTENCY_CONFLICT\), so retrying cannot help/],
  ] as const) {
    const html = render(snapshot({ controlReadSeq: 3, command: command("unknown", { attempts: 2, unknownSeq: 2, retryRefused: true, error }) }))
    assert.match(text(html), copy)
    assert.doesNotMatch(html, />Retry the same command</, "retrying cannot help")
  }
  const moved = render(snapshot({ control: loaded({ ...state(0, true), deploymentDigest: "a".repeat(64) }), controlReadSeq: 3, command: command("unknown", { error: failed("network"), unknownSeq: 2 }) }))
  assert.match(text(moved), /The server now serves a different deployment than the one this command was reviewed for\. It cannot be retried here.*Discard this command, then review the current state/)
  assert.doesNotMatch(moved, />Retry the same command</)
  const abandoned = { paused: false, expectedVersion: 0, idempotencyKey: "tc-test-key-0001", reason: "Verified local reconciliation", sinceSeq: 2, deploymentDigest: state(0, true).deploymentDigest }
  assert.match(text(render(snapshot({ access: "forbidden", abandoned }))), /No access to trading control \(403\).*A resume command sent from this page \(key tc-tes…0001 tc-test-key-0001 ?\) has no verified result\. It may or may not have been recorded, and it is not resent\. +The change history shows no keys, so it cannot confirm this command: .*A matching entry does not identify this command\. If the entry at version 1 is a different action or has a different reason than “ ?Verified local reconciliation ?”, this command was not recorded, and it can no longer be\. Only a verified answer for this command's key shows that it was recorded\. This page no longer resends it, so that may stay unknown here\./)
  assert.match(text(render(snapshot({ abandoned, controlReadSeq: 3 }))), /An earlier command has no verified result A resume command sent from this page/)
  // A retry that met a version conflict proves the earlier attempt was not recorded.
  assert.match(text(render(snapshot({ command: command("conflict", { attempts: 2, error: failed("request", 409, "CONTROL_VERSION_CONFLICT") }) }))), /this also shows that the earlier attempt with this key was not recorded\./)
})

test("the version limit offers no command; event ids keep their full value; read failures are summarised once", () => {
  const limit = text(render(snapshot({ control: loaded(state(2_147_483_647, true)) })))
  assert.match(limit, /The version limit was reached; no further change can be recorded\./)
  assert.doesNotMatch(limit, /Review (pause|resume)/)
  const html = render(snapshot({ history: { ...EMPTY_HISTORY, items: [event(1, false, { previousPaused: true, id: "c1f0a6de-0001-4c1e-9b1d-5a2f0e7d9c01" })] } }))
  assert.match(html, /title="c1f0a6de-0001-4c1e-9b1d-5a2f0e7d9c01"/)
  assert.match(html, /<span class="sr-only">c1f0a6de-0001-4c1e-9b1d-5a2f0e7d9c01<\/span>/)
  const failedAll = render(snapshot({
    control: { ...loaded(state(1, false)), phase: "error", error: failed("network") },
    runtime: { phase: "error", value: null, error: failed("network") },
    history: { ...EMPTY_HISTORY, phase: "error", error: failed("network"), failedPage: "first" },
  }))
  assert.equal((failedAll.match(/role="alert"/g) ?? []).length, 0, "no alert per card")
  assert.match(failedAll, /role="status" class="sr-only">Could not read: trading control state, runtime status, change history\.</)
  const disabled = render(snapshot({ control: { phase: "error", value: null, error: failed("disabled", 404) }, history: { ...EMPTY_HISTORY, phase: "error", error: failed("disabled", 404), failedPage: "first" } }))
  assert.match(disabled, /role="status" class="sr-only">Trading control is not enabled on this server \(404\)\.</)
  // The reason help is not a live region; only the validation message is.
  const edit = render(snapshot())
  assert.doesNotMatch(edit, /id="[^"]*-reason-help"[^>]*aria-live/)
  assert.match(edit, /id="[^"]*-reason-error"[^>]*aria-live="polite"/)
})

test("a review that can no longer be confirmed says why, by read phase, and offers only Back", () => {
  const cases: [TradingControlSnapshot["control"], RegExp][] = [
    [{ ...loaded(state(0, true)), phase: "loading" }, /The state is being read again This review can no longer be confirmed\. Wait for the read, then go back and review the current state\. Nothing was sent\./],
    [{ ...loaded(state(0, true)), phase: "error", error: failed("network") }, /Reading the state again failed This review can no longer be confirmed\. Read the state successfully, then go back and review it\. Nothing was sent\./],
  ]
  for (const [control, copy] of cases) {
    const html = render(snapshot({ control }), { initialDraft: { step: "review", reason: "Verified local reconciliation" } })
    assert.match(text(html), copy)
    assert.doesNotMatch(html, />Confirm (pause|resume)</)
    assert.match(html, /role="group"[^>]*aria-labelledby="[^"]*-review-title"/)
  }
})

// ---------------------------------------------------------------- review round 3

test("the recorded-or-not check applies only to the command's own deployment and a readable history", () => {
  const other = { ...state(0, true), deploymentDigest: "a".repeat(64) }
  const moved = text(render(snapshot({ control: loaded(other), controlReadSeq: 3, command: command("unknown", { error: failed("network"), unknownSeq: 2 }) })))
  assert.match(moved, /This command was for deployment 5f0c2b…a2c4 ?5f0c2b7d9e41a3c6b8d0f2e4a6c8b0d2f4e6a8c0b2d4f6e8a0c2e4b6d8f0a2c4 ?; the history shown is for another deployment and cannot tell whether it was recorded\./)
  assert.doesNotMatch(moved, /means it was recorded/)
  const note = { paused: false, expectedVersion: 0, idempotencyKey: "tc-test-key-0001", reason: "Verified local reconciliation", sinceSeq: 1, deploymentDigest: state(0, true).deploymentDigest }
  const disabled = text(render(snapshot({ control: { phase: "error", value: null, error: failed("disabled", 404) }, abandoned: note })))
  assert.match(disabled, /The control routes are not available here, so whether this command was recorded cannot be checked from this page\./)
  assert.doesNotMatch(disabled, /means it was recorded/)
})

test("the other-deployment note follows the re-read; the card's focus fallback is a named group", () => {
  const accepted = (control: TradingControlSnapshot["control"]) =>
    text(render(snapshot({ control, command: command("accepted", { result: { change: { state: state(1, false, { reason: "Verified local reconciliation" }), change: event(1, false, { previousPaused: true, reason: "Verified local reconciliation" }), replayed: false }, meta: META } }) })))
  const other = { ...state(2, false), deploymentDigest: "b".repeat(64) }
  assert.match(accepted({ ...loaded(other), phase: "loading" }), /for a different deployment than this response; it is being read again\./)
  assert.match(accepted({ ...loaded(other), phase: "error", error: failed("network") }), /for a different deployment than this response; reading it again failed\./)
  assert.match(accepted(loaded(other)), /for a different deployment than this response: the server now serves that one\./)
  assert.match(render(snapshot()), /role="group" aria-label="Pause or resume"[^>]*data-testid="stocks-trading-control-command"/)
})

test("a disabled feature says a retry and the history check are impossible; a shared version slot is explained", () => {
  const disabled = { phase: "error" as const, value: loaded(state(0, true)).value, error: failed("disabled", 404) }
  const t = text(render(snapshot({ control: disabled, controlReadSeq: 3, command: command("unknown", { attempts: 2, unknownSeq: 2, retryRefused: true, error: failed("disabled", 404) }) })))
  assert.match(t, /The control routes are not available on this server now, so this command cannot be retried from this page\./)
  assert.match(t, /whether this command was recorded cannot be checked from this page/)
  assert.doesNotMatch(t, /Retrying becomes available after a successful read|Read it again before changing it/)
  assert.match(t, /The state below is from an earlier read at 2026-09-19T09:00:00\.000Z, before the routes became unavailable\./)
  const note = { paused: false, expectedVersion: 0, idempotencyKey: "tc-test-key-0000", reason: "Verified local reconciliation", sinceSeq: 1, deploymentDigest: state(0, true).deploymentDigest }
  const shared = text(render(snapshot({ controlReadSeq: 3, abandoned: note, command: command("unknown", { unknownSeq: 2, error: failed("network") }) })))
  // 003F-1 P2-01: neither command is identified by the history; a retry settles only the current one.
  assert.match(shared, /The earlier unresolved command \(note above\) has the same version, action and reason; the history cannot tell the two apart\. A retry of this command settles only this one: its own event in the answer \(accepted or replayed\) means this command is recorded; a version conflict \(409\) means it was not, and the entry at version 1 may then be the earlier command's or anyone else's\./)
  assert.doesNotMatch(shared, /shows only that one of the two was recorded|means the earlier one|means it was recorded/)
})
