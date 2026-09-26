import assert from "node:assert/strict"
import test from "node:test"
import { AdminApiError, bearerSessionAuth, giwaApi, operatorTokenAuth } from "./api"

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } }

async function withFetch(status: number, body: unknown, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: Call["init"]) => {
    calls.push({ url: String(url), init })
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test("admin requests carry only the supplied credential: a Bearer session or, in the legacy UI, the operator token", async () => {
  await withFetch(200, { redemptions: [] }, async (calls) => {
    await giwaApi.admin.pendingRedemptions(bearerSessionAuth("header.payload.signature"))
    await giwaApi.admin.pendingRedemptions(operatorTokenAuth("legacy-token"))
    assert.equal(calls[0].init.headers.authorization, "Bearer header.payload.signature")
    assert.equal("x-operator-token" in calls[0].init.headers, false)
    assert.equal(calls[0].init.credentials, "omit")
    assert.equal(calls[1].init.headers["x-operator-token"], "legacy-token")
    assert.equal("authorization" in calls[1].init.headers, false)
    // A read has no body, so it declares none.
    assert.equal("content-type" in calls[0].init.headers, false)
  })
  await withFetch(200, { ok: true, id: "card-1" }, async (calls) => {
    await giwaApi.admin.removeFeatured(bearerSessionAuth("s"), "card-1")
    await giwaApi.admin.addFeatured(bearerSessionAuth("s"), { productId: "acapix" })
    assert.equal(calls[0].init.method, "DELETE")
    assert.equal("content-type" in calls[0].init.headers, false)
    assert.equal(calls[1].init.headers["content-type"], "application/json")
  })
})

test("ready follows the credential: no token or no session keeps admin queries idle", () => {
  assert.equal(operatorTokenAuth("").ready, false)
  assert.equal(operatorTokenAuth("t").ready, true)
  assert.equal(bearerSessionAuth(null).ready, false)
  assert.deepEqual(bearerSessionAuth(null).headers(), {})
  assert.equal(bearerSessionAuth("s").ready, true)
})

test("401 and 403 reach the credential's owner and surface as AdminApiError with the status", async () => {
  for (const status of [401, 403] as const) {
    const told: number[] = []
    await withFetch(status, { error: "denied", code: status === 401 ? "SESSION_REQUIRED" : "PERMISSION_REQUIRED" }, async () => {
      await assert.rejects(giwaApi.admin.saveSavingsOrder(bearerSessionAuth("s", (value) => told.push(value)), []), (error: unknown) => {
        assert.ok(error instanceof AdminApiError)
        assert.equal(error.status, status)
        assert.equal(error.message, "denied")
        assert.equal(error.code, status === 401 ? "SESSION_REQUIRED" : "PERMISSION_REQUIRED")
        return true
      })
    })
    assert.deepEqual(told, [status])
  }
  const told: number[] = []
  await withFetch(500, undefined, async () => {
    await assert.rejects(giwaApi.monitoring.overview(bearerSessionAuth("s", (value) => told.push(value)), 91342), /Request failed: 500/)
  })
  assert.deepEqual(told, [], "other failures are not authentication failures")
})
