import assert from "assert/strict"
import { deploymentHttpsRpc } from "../../scripts/stocks/deployment-http"

const endpoint = "https://rpc.example.test"
const failed = /^Error: DEPLOYMENT_RPC_UNAVAILABLE$/
function rpc(request: typeof fetch, options = {}) {
  return deploymentHttpsRpc(endpoint, request, options)("eth_chainId", [])
}

describe("Stocks deployment read transport bounds", () => {
  it("accepts the exact decoded byte budget and split UTF-8", async () => {
    const result = await rpc(
      async (_url, init) => {
        const { id } = JSON.parse(String(init?.body))
        const text = JSON.stringify({ jsonrpc: "2.0", id, result: "한글" })
        const bytes = new TextEncoder().encode(text.padEnd(128, " "))
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes.subarray(0, 128)) controller.enqueue(Uint8Array.of(byte))
              controller.close()
            },
          }),
        )
      },
      { maxBytes: 128 },
    )
    assert.equal(result, "한글")
  })

  it("rejects declared and streamed excess, invalid UTF-8 and raw provider errors", async () => {
    for (const request of [
      async () => new Response("{}", { headers: { "content-length": "65" } }),
      async () => new Response("x".repeat(65), { headers: { "content-length": "1" } }),
      async () => new Response(Uint8Array.of(0xc3, 0x28)),
      async () => new Response("PRIVATE_RESPONSE", { status: 503 }),
      async () => {
        throw Error("PRIVATE_RPC_TOKEN")
      },
    ] as (typeof fetch)[])
      await assert.rejects(rpc(request, { maxBytes: 64 }), failed)
  })

  it("rejects redirects and foreign response URLs even if an injected provider ignores redirect policy", async () => {
    for (const field of ["redirected", "url"])
      await assert.rejects(
        rpc(async (_url, init) => {
          assert.equal(init?.redirect, "error")
          return Object.defineProperty(Response.json({}), field, {
            value: field === "url" ? "https://foreign.test" : true,
          })
        }),
        failed,
      )
  })

  it("times out stalled headers and discards a late response without decoding it", async () => {
    let release!: (response: Response) => void,
      cancelled = false,
      signal: AbortSignal | undefined
    const work = rpc(
      async (_url, init) => {
        signal = init?.signal as AbortSignal
        return new Promise((resolve) => {
          release = resolve
        })
      },
      { timeoutMs: 20 },
    )
    await assert.rejects(work, failed)
    assert.equal(signal?.aborted, true)
    release(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelled, true)
  })

  it("bounds a stalled body without waiting for broken cancellation", async () => {
    let cancelled = false
    await assert.rejects(
      rpc(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true
                return new Promise(() => {})
              },
            }),
          ),
        { timeoutMs: 20 },
      ),
      failed,
    )
    assert.equal(cancelled, true)
  })

  it("keeps one deadline across headers, chunks and JSON and rejects reversed clocks", async () => {
    for (const clock of [100, -1, NaN]) {
      let now = 0
      await assert.rejects(
        rpc(
          async (_url, init) => {
            const { id } = JSON.parse(String(init?.body))
            now = clock
            return Response.json({ jsonrpc: "2.0", id, result: "0x164ce" })
          },
          { timeoutMs: 100, now: () => now },
        ),
        failed,
      )
    }
    let now = 0
    await assert.rejects(
      rpc(
        async () => {
          now = 60
          return new Response(
            new ReadableStream({
              pull(controller) {
                now = 100
                controller.enqueue(new TextEncoder().encode("{}"))
              },
            }),
          )
        },
        { timeoutMs: 100, now: () => now },
      ),
      failed,
    )
  })

  it("rejects invalid endpoints, methods and budgets before sending anything", async () => {
    let calls = 0
    const request: typeof fetch = async () => {
      calls++
      return Response.json({})
    }
    for (const value of [
      "not a url",
      "https://rpc.test?",
      "https://rpc.test#",
      "https://rpc.test\\secret",
      " https://rpc.test",
    ]) {
      assert.throws(
        () => deploymentHttpsRpc(value, request),
        /^Error: EXPLICIT_HTTPS_READ_RPC_REQUIRED$/,
      )
    }
    for (const options of [
      { timeoutMs: 0 },
      { timeoutMs: 10001 },
      { maxBytes: 0 },
      { maxBytes: 4194305 },
    ])
      assert.throws(
        () => deploymentHttpsRpc(endpoint, request, options),
        /INVALID_DEPLOYMENT_RPC_BUDGET/,
      )
    await assert.rejects(
      deploymentHttpsRpc(endpoint, request)("eth_sendRawTransaction", []),
      /READ_ONLY_DEPLOYMENT_RPC/,
    )
    assert.equal(calls, 0)
  })
})
