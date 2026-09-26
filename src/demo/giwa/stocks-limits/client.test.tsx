import assert from "node:assert/strict"
import test from "node:test"
import type { StocksAdminFetch } from "../stocks-admin/types"
import { LIMITS_HISTORY_PATH, LIMITS_PATH, limitPath, newLimitIdempotencyKey, readTradingLimitHistory, readTradingLimits, sendTradingLimitChange } from "./client"
import { limEnvelope, limError, limEvent, limRead, limState } from "./fixtures"
import type { TradingLimitCommand } from "./types"

const API = "https://api.example.test"
const command: TradingLimitCommand = { enabled: false, dailyCashLimit: null, expectedVersion: 2, idempotencyKey: "limit-key-0003", reason: "Stop sells for the audit" }
type Call = { url: string; init: RequestInit }
type Reply = { status: number; body?: unknown; raw?: string } | Error

function transport(reply: () => Reply) {
  const calls: Call[] = []
  const fetch: StocksAdminFetch = async (url, init) => {
    calls.push({ url, init })
    const next = reply()
    if (next instanceof Error) throw next
    return { status: next.status, text: async () => next.raw ?? JSON.stringify(next.body) }
  }
  return { fetch, calls }
}

const ok = () => {
  const change = limEvent("SELL", 3, { enabled: false, dailyCashLimit: null, reason: command.reason })
  return { status: 200, body: limEnvelope({ state: limState("SELL", 3, { enabled: false, reason: command.reason, updatedAt: change.createdAt }), change, replayed: false }) }
}

test("paths: the one limits route per stock and side; the history asks for the newest 50", () => {
  assert.equal(limitPath("NVDA", "BUY"), "/api/v1/admin/stocks/limits/NVDA/BUY")
  assert.equal(limitPath("NVDA", "SELL"), "/api/v1/admin/stocks/limits/NVDA/SELL")
  for (const bad of ["nvda", "NV DA", "../x", "", "ABCDEFGHIJK"]) assert.throws(() => limitPath(bad, "BUY"), RangeError, bad)
  assert.equal(LIMITS_HISTORY_PATH, `${LIMITS_PATH}/history?limit=50`)
  for (let i = 0; i < 20; i++) assert.match(newLimitIdempotencyKey(), /^[a-zA-Z0-9:_-]{8,128}$/)
  assert.notEqual(newLimitIdempotencyKey(), newLimitIdempotencyKey())
})

test("reads: GET with the Bearer session only, no cookies, no cache", async () => {
  const { fetch, calls } = transport(() => ({ status: 200, body: limEnvelope(limRead()) }))
  const read = await readTradingLimits({ apiBase: `${API}/`, accessToken: "header.payload.signature", signal: new AbortController().signal, fetch })
  assert.equal(read.ok, true)
  const history = await readTradingLimitHistory({ apiBase: API, accessToken: "header.payload.signature", signal: new AbortController().signal, fetch })
  assert.equal(history.ok, false, "a read body is not a history")
  assert.deepEqual(calls.map((call) => call.url), [`${API}${LIMITS_PATH}`, `${API}${LIMITS_HISTORY_PATH}`])
  for (const { init } of calls) {
    assert.equal(init.method, "GET")
    assert.equal(init.credentials, "omit")
    assert.equal(init.cache, "no-store")
    assert.deepEqual(init.headers, { accept: "application/json", authorization: "Bearer header.payload.signature" })
  }
})

test("change: exactly the five fields in a fixed order, PUT, Bearer only, and no redirects", async () => {
  const { fetch, calls } = transport(ok)
  const result = await sendTradingLimitChange({ apiBase: API, accessToken: "header.payload.signature", signal: new AbortController().signal, fetch, symbol: "NVDA", side: "SELL", command })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(calls.length, 1)
  const [{ url, init }] = calls
  assert.equal(url, `${API}/api/v1/admin/stocks/limits/NVDA/SELL`)
  assert.equal(init.method, "PUT")
  assert.equal(init.redirect, "error")
  assert.equal(init.credentials, "omit")
  assert.equal(init.body, '{"enabled":false,"dailyCashLimit":null,"expectedVersion":2,"idempotencyKey":"limit-key-0003","reason":"Stop sells for the audit"}')
  assert.deepEqual(init.headers, { accept: "application/json", "content-type": "application/json", authorization: "Bearer header.payload.signature" })
  assert.doesNotMatch(JSON.stringify(init), /operator|x-role|cookie/i)
})

test("change: every answer is classified; only a verified 2xx is a success", async () => {
  let next: Reply = ok()
  const { fetch } = transport(() => next)
  const send = () => sendTradingLimitChange({ apiBase: API, accessToken: "t", signal: new AbortController().signal, fetch, symbol: "NVDA", side: "SELL", command })
  const cases: Array<[Reply, string, number | null, string | null]> = [
    [{ status: 401, body: limError("SESSION_REJECTED") }, "unauthorized", 401, "SESSION_REJECTED"],
    [{ status: 403, body: limError("OPERATOR_FORBIDDEN") }, "forbidden", 403, "OPERATOR_FORBIDDEN"],
    [{ status: 404, raw: "Not Found" }, "disabled", 404, null],
    [{ status: 400, body: limError("INVALID_TRADING_LIMIT_INPUT") }, "request", 400, "INVALID_TRADING_LIMIT_INPUT"],
    [{ status: 409, body: limError("LIMIT_VERSION_CONFLICT") }, "request", 409, "LIMIT_VERSION_CONFLICT"],
    [{ status: 409, body: limError("LIMIT_IDEMPOTENCY_CONFLICT") }, "request", 409, "LIMIT_IDEMPOTENCY_CONFLICT"],
    [{ status: 503, body: limError("TRADING_LIMITS_UNAVAILABLE") }, "server", 503, "TRADING_LIMITS_UNAVAILABLE"],
    [{ status: 500, raw: "<html>secret stack</html>" }, "server", 500, null],
    [{ status: 200, raw: "not json" }, "invalid", 200, null],
    [{ status: 200, body: limEnvelope({ ...(ok().body.data as object), replayed: "no" }) }, "invalid", 200, null],
    [{ status: 200, body: { ...ok().body, chainId: 1 } }, "invalid", 200, null],
    [{ status: 409, body: { error: "lower case" } }, "request", 409, null],
    [new TypeError("offline"), "network", null, null],
  ]
  for (const [reply, kind, status, code] of cases) {
    next = reply
    const result = await send()
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.deepEqual(result.error, { kind, status, code }, JSON.stringify(reply instanceof Error ? reply.message : reply.status))
    assert.doesNotMatch(JSON.stringify(result), /secret/)
  }
})

test("change: nothing is sent without a session or with a bad API base; an abort is reported as aborted", async () => {
  const { fetch, calls } = transport(ok)
  const signal = new AbortController().signal
  assert.deepEqual(await sendTradingLimitChange({ apiBase: "not a url", accessToken: "t", signal, fetch, symbol: "NVDA", side: "BUY", command }), { ok: false, error: { kind: "configuration", status: null, code: null } })
  assert.deepEqual(await sendTradingLimitChange({ apiBase: API, accessToken: null, signal, fetch, symbol: "NVDA", side: "BUY", command }), { ok: false, error: { kind: "unauthenticated", status: null, code: null } })
  assert.equal(calls.length, 0)
  const controller = new AbortController()
  const aborting: StocksAdminFetch = async () => {
    controller.abort()
    throw new DOMException("aborted", "AbortError")
  }
  assert.deepEqual(await sendTradingLimitChange({ apiBase: API, accessToken: "t", signal: controller.signal, fetch: aborting, symbol: "NVDA", side: "BUY", command }), { ok: false, error: { kind: "aborted", status: null, code: null } })
})
