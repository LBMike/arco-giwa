import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { parseEnvelope } from "../stocks-admin/parse"
import { TC_DIGEST, TC_NOW, TC_OBSERVED_AT, tcEnvelope, tcRuntime, tcState } from "./fixtures"
import { parseControlStateValue, parseRuntimeStatus } from "./parse"
import { TradingControlView } from "./TradingControlPanel"
import type { HistoryState, ResourceState, TradingControlSnapshot } from "./types"

const META = parseEnvelope(tcEnvelope(null)).meta
const noop = () => {}
const loaded = <T,>(data: T): ResourceState<T> => ({ phase: "ready", value: { data, meta: META, loadedAt: TC_NOW - 5_000 }, error: null })
const HISTORY: HistoryState = { phase: "ready", items: [], nextBeforeVersion: null, complete: true, observedAt: TC_OBSERVED_AT, error: null, failedPage: null, deploymentDigest: TC_DIGEST }
const snapshot: TradingControlSnapshot = {
  scopeKey: "scope", access: "ok", control: loaded(parseControlStateValue(tcState(0, true))), runtime: loaded(parseRuntimeStatus(tcRuntime({}), TC_OBSERVED_AT)),
  history: HISTORY, command: null, abandoned: null, controlReadSeq: 1,
}
const render = (canControl?: boolean) =>
  renderToStaticMarkup(
    <TradingControlView snapshot={snapshot} now={TC_NOW} onRefresh={noop} onLoadOlder={noop} onStart={() => null} onRetry={() => null} onDiscard={noop} onDismissAbandoned={noop} onRetryAccess={noop} canControl={canControl} />,
  )

test("without stocks:control the console offers no pause or resume; the page still does not guess when it is not told", () => {
  const readOnly = render(false)
  assert.match(readOnly, /<button type="button" disabled=""[^>]*>Review resume<\/button>/)
  assert.match(readOnly, /Read only for this operator/)
  for (const html of [render(true), render(undefined)]) {
    assert.match(html, /<button type="button"[^>]*>Review resume<\/button>/)
    assert.doesNotMatch(html, /<button type="button" disabled=""[^>]*>Review resume/)
    assert.doesNotMatch(html, /Read only for this operator/)
  }
})
