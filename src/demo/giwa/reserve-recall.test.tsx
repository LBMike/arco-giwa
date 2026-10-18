import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AdminApiError, bearerSessionAuth, giwaApi } from "./api"
import {
  isReserveRecall,
  recallActionKey,
  recallActionLabel,
  recallBadge,
  recallStateLabel,
  recallsNeedingAttention,
  recallsUnavailableReason,
} from "./reserve-recall"
import type { GiwaReserveRecall } from "./types"

const recall = (overrides: Partial<GiwaReserveRecall>): GiwaReserveRecall => ({
  productId: "umint",
  requestId: "2",
  strategyId: 0,
  status: "SETTLED",
  state: "awaiting-acknowledgement",
  action: "acknowledge",
  pending: "5000000",
  open: true,
  lockedAssetsOut: "5000000",
  settledTxHash: null,
  createdAt: null,
  warning: null,
  error: null,
  ...overrides,
})

test("only rows the server marks as Reserve recalls get the recall treatment", () => {
  assert.equal(isReserveRecall({ kind: "arcousd-recall" }), true)
  assert.equal(isReserveRecall({ kind: "customer" }), false)
  assert.equal(isReserveRecall({}), false) // an older server without `kind`
})

test("attention list: this product's recalls with an action, a warning or a read problem; finished ones drop out", () => {
  const recalls = [
    recall({ requestId: "1" }),
    recall({ requestId: "2", state: "done", action: null }),
    recall({ requestId: "3", state: "requested", action: null, warning: "backing understated" }),
    recall({ requestId: "4", state: "unknown", action: null, error: "Reserve read failed" }),
    recall({ requestId: "5", state: "claimable", action: "claim", productId: "ibenji" }),
    recall({ requestId: "6", state: "requested", action: null }),
  ]
  assert.deepEqual(recallsNeedingAttention(recalls, "umint").map((item) => item.requestId), ["1", "3", "4"])
  assert.deepEqual(recallsNeedingAttention(recalls, "ibenji").map((item) => item.requestId), ["5"])
  assert.equal(recallActionLabel("acknowledge"), "Acknowledge")
  assert.equal(recallActionLabel("claim"), "Claim")
  assert.equal(recallActionLabel(null), null)
  assert.equal(recallStateLabel({ state: "awaiting-acknowledgement" }), "Paid · awaiting acknowledgement")
  assert.equal(recallStateLabel({ state: "unknown" }), "State unavailable")
})

test("recall list renders the amount, state and the one allowed action; nothing when empty", async () => {
  const { ReserveRecallList } = await import("./VaultAdmin")
  const render = (recalls: GiwaReserveRecall[], phases: Record<string, "idle" | "signing" | "done"> = {}, errors: Record<string, string> = {}) =>
    renderToStaticMarkup(
      <ReserveRecallList recalls={recalls} paymentDecimals={6} baseSymbol="USDC" phases={phases} errors={errors} onAction={() => undefined} />,
    )
  assert.equal(render([]), "")

  const html = render([recall({}), recall({ requestId: "3", state: "claimable", action: "claim", status: "FULFILLED" })])
  assert.match(html, /ArcoUSD Reserve recalls/)
  assert.match(html, /ARCO-2/)
  assert.match(html, /5 USDC/)
  assert.match(html, /Paid · awaiting acknowledgement/)
  assert.match(html, />Acknowledge</)
  assert.match(html, />Claim</)

  // No action → no button, but its warning and read error are shown.
  const noted = render([recall({ state: "requested", action: null, warning: "backing understated", error: "Reserve read failed" })])
  assert.doesNotMatch(noted, /<button/)
  assert.match(noted, /backing understated/)
  assert.match(noted, /Reserve read failed/)

  // In flight: the button is disabled and says so; a failed send shows its error.
  const signing = render([recall({})], { "2:acknowledge": "signing" }, { "2:acknowledge": "user rejected" })
  assert.match(signing, /disabled=""/)
  assert.match(signing, /Signing/)
  assert.match(signing, /user rejected/)
  // An earlier, different action on the same request does not block the next one.
  const nextAction = render([recall({ state: "claimable", action: "claim" })], { "2:acknowledge": "done" })
  assert.doesNotMatch(nextAction, /disabled=""/)
  assert.match(nextAction, />Claim</)
  assert.match(html, /RESERVE_MANAGER_ROLE/)
})

test("header badge, action keys and the unavailable reason", () => {
  assert.equal(recallBadge([]), null)
  assert.equal(recallBadge([recall({ action: null, warning: "w" })]), "ArcoUSD recall: check state")
  assert.equal(recallBadge([recall({ action: null, error: "e" }), recall({})]), "ArcoUSD recall: action needed")
  assert.equal(recallActionKey({ requestId: "2", action: "claim" }), "2:claim")
  assert.equal(recallsUnavailableReason({ status: "live" }, null), null)
  assert.equal(recallsUnavailableReason({ status: "not-deployed" }, null), null)
  assert.match(recallsUnavailableReason({ status: "unavailable", error: "registry invalid" }, null) ?? "", /registry invalid/)
  assert.match(recallsUnavailableReason(undefined, new Error("503")) ?? "", /Could not load ArcoUSD recalls: 503/)
  // An older API without the route: nothing to show, not an error on every card.
  assert.equal(recallsUnavailableReason(undefined, new AdminApiError("Request failed: 404", 404, null)), null)
})

test("recall actions call the product-scoped Reserve routes", async () => {
  const calls: { url: string; method?: string }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method })
    return new Response(JSON.stringify({ transaction: {}, status: "live", recalls: [] }), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const auth = bearerSessionAuth("s")
    await giwaApi.admin.reserveRecalls(auth)
    await giwaApi.admin.acknowledgeRecall(auth, "umint", "2")
    await giwaApi.admin.claimRecall(auth, "umint", "3")
    await giwaApi.admin.reserveRecalls(auth, { fresh: true })
  } finally {
    globalThis.fetch = original
  }
  assert.match(calls[0].url, /\/api\/v1\/admin\/arcousd\/recalls$/)
  assert.match(calls[3].url, /\/api\/v1\/admin\/arcousd\/recalls\?fresh=1$/)
  assert.equal(calls[0].method ?? "GET", "GET")
  assert.match(calls[1].url, /\/api\/v1\/admin\/products\/umint\/redemptions\/2\/acknowledge-recall$/)
  assert.equal(calls[1].method, "POST")
  assert.match(calls[2].url, /\/api\/v1\/admin\/products\/umint\/redemptions\/3\/claim-recall$/)
})
