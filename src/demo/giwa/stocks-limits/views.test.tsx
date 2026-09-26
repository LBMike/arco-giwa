import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"
import { parseEnvelope } from "../stocks-admin/parse"
import type { StocksAdminError } from "../stocks-admin/types"
import { LIM_NOW, limEnvelope, limEvent, limRead, limRow, limState } from "./fixtures"
import { LimitsView, StocksLimitsPanel, type LimitsViewProps } from "./LimitsPanel"
import { LIMIT_CHANGE_REASON, parseLimitChange, parseLimitHistory, parseLimitsRead } from "./parse"
import { LIMITS_INITIAL, commandFor, limitsReducer, type LimitsAction, type LimitsState } from "./state"

const META = parseEnvelope(limEnvelope(null)).meta
const noop = () => {}
const run = (state: LimitsState, ...actions: LimitsAction[]) => actions.reduce(limitsReducer, state)
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")
const error = (kind: StocksAdminError["kind"], status: number | null = null, code: string | null = null): StocksAdminError => ({ kind, status, code })
/** The editor (and its review) alone, without the table and the history around it. */
function editorOf(html: string) {
  const start = html.indexOf('data-testid="stocks-limits-editor"')
  assert.ok(start >= 0, "no editor")
  return html.slice(start, html.indexOf("</section>", start))
}

const ROWS = [
  limRow("BUY", 2, { dailyCashLimit: "50000000000", reason: "Launch cap for the first week" }, "12345000000"),
  limRow("SELL", 1, { enabled: false, operatorId: "ops-limits-b", reason: "Sells paused for the audit" }, "0"),
]
function loaded(items: unknown[] = ROWS, history: unknown[] = [limEvent("BUY", 2, { dailyCashLimit: "50000000000" }), limEvent("SELL", 1, { enabled: false })]): LimitsState {
  return run(
    LIMITS_INITIAL,
    { type: "limits/start" },
    { type: "limits/loaded", data: parseLimitsRead(limRead(items)), meta: META, at: LIM_NOW - 5_000 },
    { type: "history/loaded", data: parseLimitHistory({ items: history }), meta: META, at: LIM_NOW - 5_000 },
  )
}
function render(state: LimitsState, extra: Partial<LimitsViewProps> = {}) {
  return renderToStaticMarkup(
    <LimitsView
      state={state}
      signedIn
      canControl
      now={LIM_NOW}
      onRefresh={noop}
      onEdit={noop}
      onDraft={noop}
      onReview={noop}
      onBack={noop}
      onCancel={noop}
      onConfirm={noop}
      onRetry={noop}
      onDiscard={noop}
      onDismiss={noop}
      onSignInRequired={noop}
      {...extra}
    />,
  )
}

test("access: signed out, 401, 403 and a server without the limits routes each explain themselves", () => {
  assert.match(text(render(LIMITS_INITIAL, { signedIn: false })), /Operator session required.*Sign in with operator wallet/)
  const failed = (value: StocksAdminError) => run(LIMITS_INITIAL, { type: "limits/start" }, { type: "limits/failed", error: value })
  assert.match(text(render(failed(error("unauthorized", 401)))), /Session missing or expired \(401\).*Sign in with operator wallet/)
  assert.match(text(render(failed(error("forbidden", 403)))), /No Stocks read permission \(403\).*stocks:read.*Check again/)
  const disabled = text(render(failed(error("disabled", 404))))
  assert.match(disabled, /Trading limits are not turned on for this server/)
  assert.match(disabled, /STOCKS_TRADING_LIMITS=1/)
  assert.doesNotMatch(disabled, /Sign in with operator wallet/)
  assert.match(text(render(LIMITS_INITIAL)), /Reading the limits/)
})

test("each stock and side shows its status, today's usage against the cap, the cap and the last change", () => {
  const html = render(loaded())
  const page = text(html)
  assert.match(page, /Trading limits/)
  assert.match(page, /NVDA Side Buy Status On Today 12,345 tUSDC used of 50,000 tUSDC \(24\.6%\) Daily cap 50,000 tUSDC Last change v2/)
  assert.doesNotMatch(page, /Launch cap for the first week/, "the reason is in the change history, not in the row")
  assert.match(page, /NVDA Side Sell Status Off Today 0 tUSDC used · no cap Daily cap No cap Last change v1/)
  assert.match(page, /ops-limits-b/)
  assert.match(page, /Today counts from 2026-09-25 15:00:00 UTC and resets at 2026-09-26 15:00:00 UTC \(00:00 KST, in 11h 59m\)/)
  assert.match(html, /aria-label="Change the NVDA Buy limit"/)
  assert.match(html, /aria-label="Change the NVDA Sell limit"/)
  const reached = text(render(loaded([limRow("BUY", 2, { dailyCashLimit: "1000000" }, "1000000"), limRow("SELL")])))
  assert.match(reached, /NVDA Side Buy Status Cap reached Today 1 tUSDC used of 1 tUSDC \(100\.0%\)/)
  assert.match(reached, /Default \(never changed\): on, no cap/)
  // After 00:00 KST the usage shown is yesterday's.
  assert.match(text(render(loaded(), { now: Date.parse("2026-09-26T15:00:01.000Z") })), /A new day started at 00:00 KST/)
})

test("read-only operators see the limits and history without any Change button", () => {
  const html = render(loaded(), { canControl: false })
  assert.doesNotMatch(html, /Change the NVDA/)
  assert.match(text(html), /Read only for this operator.*stocks:read but not stocks:control/)
  // Even a draft (from before permissions were read again) is not offered.
  assert.doesNotMatch(render(run(loaded(), { type: "edit", symbol: "NVDA", side: "BUY" }), { canControl: false }), /stocks-limits-editor/)
})

test("the editor offers on/off and a cap or No cap, with no reason to type; errors show after the first review", () => {
  const editing = run(loaded(), { type: "edit", symbol: "NVDA", side: "BUY" })
  const html = render(editing)
  assert.match(html, /data-testid="stocks-limits-editor"/)
  assert.match(html, /role="switch"[^>]*checked=""|checked=""[^>]*role="switch"/)
  assert.match(html, /value="50000"/)
  assert.match(text(html), /Change the NVDA Buy limit.*Take new Buy orders.*SIDE_DISABLED.*No cap.*= 50,000 tUSDC a day \(50000000000 base units\).*DAILY_LIMIT_REACHED.*Review change/)
  assert.doesNotMatch(editorOf(html), /<textarea|Reason/)
  const invalid = run(editing, { type: "draft", patch: { capText: "abc" } }, { type: "review" })
  const shown = text(render(invalid))
  assert.match(shown, /Use digits with an optional decimal point/)
  assert.doesNotMatch(text(editorOf(render(invalid))), /reason/i)
  assert.match(render(invalid), /aria-invalid="true"/)
  const noCap = text(render(run(editing, { type: "draft", patch: { noCap: true } })))
  assert.match(noCap, /No daily cap: while it is on, this side takes any amount\./)
})

test("the review shows now, after saving and the change; a cap at today's usage warns", () => {
  const review = run(loaded(), { type: "edit", symbol: "NVDA", side: "BUY" }, { type: "draft", patch: { capText: "10,000" } }, { type: "review" })
  const page = text(render(review))
  assert.match(page, /Review the NVDA Buy change/)
  assert.match(page, /Now \(version 2\) On · 50,000 tUSDC/)
  assert.match(page, /After saving \(version 3\) On · 10,000 tUSDC/)
  assert.match(page, /Change Cap 50,000 tUSDC → 10,000 tUSDC/)
  assert.doesNotMatch(text(editorOf(render(review))), /Reason/)
  assert.match(page, /At or below what today already used.*12,345 tUSDC today.*until 00:00 KST/)
  assert.match(page, /only if this limit is still version 2/)
  assert.match(page, /Confirm change/)
  const same = text(render(run(loaded(), { type: "edit", symbol: "NVDA", side: "SELL" }, { type: "review" })))
  assert.match(same, /Saved again without a change \(Off · No cap\)/)
  assert.doesNotMatch(same, /At or below/)
})

test("a change in flight, an unknown result and each outcome are announced", () => {
  const review = run(loaded(), { type: "edit", symbol: "NVDA", side: "BUY" }, { type: "draft", patch: { enabled: false, noCap: true } }, { type: "review" })
  const command = commandFor(review.draft, "limit-key-0001")!
  const inFlight = run(review, { type: "send", command })
  const sending = text(render(inFlight))
  assert.match(sending, /Saving the NVDA Buy change… NVDA Buy → Off · No cap/)
  assert.match(render(inFlight), /disabled=""[^>]*aria-label="Change the NVDA Buy limit"|aria-label="Change the NVDA Buy limit"[^>]*disabled=""/)
  const unknown = run(inFlight, { type: "result", key: "limit-key-0001", result: { ok: false, error: error("network") } })
  assert.match(text(render(unknown)), /The NVDA Buy change was not confirmed Could not reach the API\. It may or may not have been saved\..*Retry.*Discard and read again/)
  assert.match(text(render(run(unknown, { type: "retry" }))), /attempt 2, same change key/)
  const change = limEvent("BUY", 3, { enabled: false, reason: LIMIT_CHANGE_REASON })
  const data = parseLimitChange({ state: limState("BUY", 4, { dailyCashLimit: "5" }), change, replayed: true }, { symbol: "NVDA", side: "BUY", command: command.command })
  const saved = text(render(run(inFlight, { type: "result", key: "limit-key-0001", result: { ok: true, data } })))
  assert.match(saved, /Already saved earlier: NVDA Buy.*nothing was saved twice.*Version 3: On → Off\. A later change \(version 4\) is already recorded\./)
  assert.match(text(render(run(inFlight, { type: "result", key: "limit-key-0001", result: { ok: false, error: error("request", 409, "LIMIT_VERSION_CONFLICT") } }))), /NVDA Buy was changed by someone else first.*read again/)
  assert.match(text(render(run(inFlight, { type: "result", key: "limit-key-0001", result: { ok: false, error: error("forbidden", 403, "OPERATOR_FORBIDDEN") } }))), /No permission to change limits \(403\).*Nothing was changed/)
  assert.match(text(render(run(inFlight, { type: "result", key: "limit-key-0001", result: { ok: false, error: error("request", 400, "INVALID_TRADING_LIMIT_INPUT") } }))), /The server refused the input \(400\)/)
  const moved = run(loaded(), { type: "edit", symbol: "NVDA", side: "BUY" }, { type: "limits/loaded", data: parseLimitsRead(limRead([limRow("BUY", 5), limRow("SELL")])), meta: META, at: LIM_NOW })
  assert.match(text(render(moved)), /NVDA Buy changed while you were editing.*Nothing was sent/)
})

test("history lists each change newest first with what changed, who and why", () => {
  const page = text(render(loaded()))
  assert.match(page, /Change history.*newest 50 changes/)
  assert.match(page, /NVDA Buy v2 Change Cap No cap → 50,000 tUSDC Operator ops-limits-a Reason Reason for version 2/)
  assert.match(page, /NVDA Sell v1 Change On → Off Operator ops-limits-a Reason Reason for version 1/)
  assert.match(text(render(loaded(ROWS, []))), /No change has been recorded yet/)
  const failed = run(loaded(), { type: "history/start" }, { type: "history/failed", error: error("server", 503) })
  assert.match(text(render(failed)), /Server error \(503\) Reading the history again failed; the list below is from the last successful read\./)
})

test("the panel mounts with the console session and sends nothing during server rendering", () => {
  let calls = 0
  const html = renderToStaticMarkup(
    <StocksLimitsPanel apiBase="https://api.example.test" session={{ id: "s-1", accessToken: "header.payload.signature" }} canControl fetch={async () => { calls++; throw new Error("no fetch during render") }} />,
  )
  assert.match(html, /data-testid="stocks-limits"/)
  assert.equal(calls, 0)
  assert.match(renderToStaticMarkup(<StocksLimitsPanel apiBase="https://api.example.test" session={null} canControl />), /Operator session required/)
})

test("limits sources keep no credentials: no storage, cookies, legacy operator token or role headers", () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sources = readdirSync(here).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "fixtures.ts")
  assert.deepEqual(sources.sort(), ["LimitsPanel.tsx", "client.ts", "index.ts", "parse.ts", "state.ts", "types.ts"])
  for (const name of sources) {
    const source = readFileSync(path.join(here, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|x-operator|x-role|operatorTokenAuth|window\.ethereum/, name)
  }
})
