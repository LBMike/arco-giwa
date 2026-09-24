import assert from "assert/strict"
import { localDeploymentRpc } from "../../scripts/stocks/local-transport"
import { runLocalDeploymentCli } from "../../scripts/stocks/local-deploy"

describe("GIWA local deployment transport and CLI boundaries", () => {
  it("requires explicit credential-free HTTPS and read modes cannot send or sign", async () => {
    let calls = 0
    const request: typeof fetch = async () => {
      calls++
      throw Error("unexpected")
    }
    for (const url of [
      "http://rpc.invalid",
      "https://user:password@rpc.invalid",
      "https://rpc.invalid/?key=secret",
      "https://rpc.invalid/#fragment",
    ])
      assert.throws(() => localDeploymentRpc(url, true, request))
    const read = localDeploymentRpc("https://rpc.invalid", false, request)
    await assert.rejects(() => read("eth_sendRawTransaction", ["0x02abcd"]))
    await assert.rejects(() => read("eth_sendTransaction", [{}]))
    await assert.rejects(() => read("eth_sign", []))
    assert.equal(calls, 0)
  })

  it("sends the exact bytes only once and never retries an uncertain or malformed response", async () => {
    const original = "0x02abcd",
      expectedHash = "0x" + "a".repeat(64)
    let calls = 0
    const good: typeof fetch = async (_url, options) => {
      calls++
      assert.equal(options?.redirect, "error")
      const message = JSON.parse(options?.body as string)
      assert.equal(message.method, "eth_sendRawTransaction")
      assert.deepEqual(message.params, [original])
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: expectedHash }))
    }
    assert.equal(
      await localDeploymentRpc(
        "https://rpc.invalid",
        true,
        good,
      )("eth_sendRawTransaction", [original]),
      expectedHash,
    )
    assert.equal(calls, 1)
    for (const mode of ["throw", "id", "error", "too-large", "invalid-json", "redirect"]) {
      calls = 0
      const broken: typeof fetch = async (_url, options) => {
        calls++
        if (mode === "throw") throw Error(original)
        const input = JSON.parse(options?.body as string)
        if (mode === "id")
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "different", result: expectedHash }),
          )
        if (mode === "error")
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: input.id, error: { message: original } }),
          )
        if (mode === "too-large")
          return new Response("x", { headers: { "content-length": "999999999" } })
        if (mode === "redirect") return new Response("", { status: 302 })
        return new Response(original)
      }
      await assert.rejects(
        () =>
          localDeploymentRpc(
            "https://rpc.invalid",
            true,
            broken,
          )("eth_sendRawTransaction", [original]),
        (error: any) => error.message === "LOCAL_DEPLOYMENT_RPC_UNAVAILABLE",
      )
      assert.equal(calls, 1)
    }
  })

  it("supports required chain reads without enabling wallet RPC and rejects malformed CLI before input access", async () => {
    const seen: string[] = []
    const request: typeof fetch = async (_url, options) => {
      const input = JSON.parse(options?.body as string)
      seen.push(input.method)
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: "0x0" }))
    }
    const rpc = localDeploymentRpc("https://rpc.invalid", false, request)
    for (const method of [
      "eth_getTransactionCount",
      "eth_getBalance",
      "eth_estimateGas",
      "eth_chainId",
    ])
      assert.equal(await rpc(method, []), "0x0")
    assert.equal(seen.length, 4)
    for (const args of [
      [],
      ["send"],
      ["check", "--keystore", "/wrong"],
      ["check", "--plan", "/x", "--plan", "/y"],
      ["verify", "--output", "/x"],
    ])
      await assert.rejects(() => runLocalDeploymentCli(args), /ARGUMENTS_INVALID/)
  })
})
