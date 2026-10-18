import assert from "node:assert/strict"
import test from "node:test"
import { AdminApiError, bearerSessionAuth, giwaApi } from "./api"

// ArcoUSD client data layer: the public reserve/gate reads and the admin console routes.

type Call = { url: string; method: string; body: unknown; authorization: string | null }

async function withFetch(status: number, body: unknown, run: () => Promise<void>): Promise<Call[]> {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      authorization: headers.authorization ?? null,
    })
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
  return calls
}

test("public ArcoUSD reads need no credentials", async () => {
  const calls = await withFetch(200, { status: "not-deployed" }, async () => {
    await giwaApi.arcousd.reserve()
    await giwaApi.arcousd.gate()
  })
  assert.match(calls[0].url, /\/api\/v1\/arcousd\/reserve$/)
  assert.match(calls[1].url, /\/api\/v1\/arcousd\/gate$/)
  assert.deepEqual(calls.map((call) => call.authorization), [null, null])
})

test("admin ArcoUSD routes send the operator session, the window and filter, and the processQueue body", async () => {
  const auth = bearerSessionAuth("session-token")
  const calls = await withFetch(200, { status: "live" }, async () => {
    await giwaApi.admin.arcousdSnapshots(auth)
    await giwaApi.admin.arcousdSnapshots(auth, 7)
    await giwaApi.admin.arcousdQueue(auth)
    await giwaApi.admin.arcousdQueue(auth, "PAYOUT_FAILED")
    await giwaApi.admin.arcousdFlows(auth, 30)
    await giwaApi.admin.arcousdProcessQueue(auth, "tUSDC", 10)
    await giwaApi.admin.arcousdProcessQueue(auth, "tUSDT")
  })
  assert.match(calls[0].url, /\/api\/v1\/admin\/arcousd\/snapshots$/)
  assert.match(calls[1].url, /\/api\/v1\/admin\/arcousd\/snapshots\?days=7$/)
  assert.match(calls[2].url, /\/api\/v1\/admin\/arcousd\/queue\?status=open$/)
  assert.match(calls[3].url, /\/api\/v1\/admin\/arcousd\/queue\?status=PAYOUT_FAILED$/)
  assert.match(calls[4].url, /\/api\/v1\/admin\/arcousd\/flows\?days=30$/)
  assert.match(calls[5].url, /\/api\/v1\/admin\/arcousd\/process-queue$/)
  assert.deepEqual([calls[5].method, calls[5].body], ["POST", { asset: "tUSDC", maxCount: 10 }])
  assert.deepEqual(calls[6].body, { asset: "tUSDT" }) // server default batch
  assert.ok(calls.every((call) => call.authorization === "Bearer session-token"))
})

test("a refused processQueue surfaces the server's reason and status", async () => {
  let failures: number[] = []
  const auth = bearerSessionAuth("session-token", (status) => failures.push(status))
  let caught: unknown = null
  await withFetch(400, { error: "maxCount must be an integer in 1..50" }, async () => {
    try {
      await giwaApi.admin.arcousdProcessQueue(auth, "tUSDC", 500)
    } catch (error) {
      caught = error
    }
  })
  assert.ok(caught instanceof AdminApiError)
  assert.deepEqual([(caught as AdminApiError).status, (caught as Error).message], [400, "maxCount must be an integer in 1..50"])
  assert.deepEqual(failures, []) // not an auth failure

  failures = []
  await withFetch(403, { error: "forbidden" }, async () => {
    await giwaApi.admin.arcousdQueue(auth).catch(() => undefined)
  })
  assert.deepEqual(failures, [403])
})
