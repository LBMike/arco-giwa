import assert from "node:assert/strict"
import test from "node:test"
import { STOCKS_ADMIN_PATHS, stocksAdminGet } from "./client"
import { createFixtureTransport, fixtureEnvelope } from "./fixtures"
import { parseOrders } from "./parse"
import { errorCopy } from "./ui"

const TOKEN = "admin-header.admin-payload.admin-signature"

function orders(apiBase: string, accessToken: string | null = TOKEN) {
  const transport = createFixtureTransport(() => ({ status: 200, body: fixtureEnvelope([]) }))
  const result = stocksAdminGet({ apiBase, path: STOCKS_ADMIN_PATHS.orders, accessToken, signal: new AbortController().signal, parse: parseOrders, fetch: transport.fetch })
  return { result, calls: transport.calls }
}

test("a base with a bare query or fragment delimiter is refused before the authenticated orders read", async () => {
  const bad = ["https://api.test?", "https://api.test#", "https://api.test/prefix?", "https://api.test/prefix#", "https://api.test?x=1", "https://user:pass@api.test", "ftp://api.test", "/api", ""]
  for (const apiBase of bad) {
    for (const token of [TOKEN, null]) {
      const { result, calls } = orders(apiBase, token)
      const outcome = await result
      assert.deepEqual(outcome, { ok: false, error: { kind: "configuration", status: null, code: null } }, apiBase)
      assert.equal(calls.length, 0)
      assert.ok(!JSON.stringify(outcome).includes(TOKEN))
    }
  }
})

test("a path-prefixed base sends the orders read under the prefix with the Bearer session", async () => {
  for (const [apiBase, url] of [["https://api.test/prefix//", "https://api.test/prefix/api/v1/admin/stocks/orders"], ["https://api.test/prefix%3Fsegment", "https://api.test/prefix%3Fsegment/api/v1/admin/stocks/orders"]]) {
    const { result, calls } = orders(apiBase)
    assert.equal((await result).ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, url)
    assert.deepEqual(calls[0].init.headers, { accept: "application/json", authorization: `Bearer ${TOKEN}` })
  }
})

test("the configuration failure has fixed copy that names no server answer", () => {
  const copy = errorCopy({ kind: "configuration", status: null, code: null })
  assert.equal(copy.title, "Stocks admin API is not configured")
  assert.equal(copy.body, "No request was sent. Nothing new is shown.")
})
