import { randomUUID } from "crypto"
import { deploymentHttpsRpc, type DeploymentReadRpc } from "./deployment-http"

const additionalReads = new Set(["eth_getTransactionCount", "eth_getBalance", "eth_estimateGas"])
/** Same bounded HTTPS policy as the verifier; send is explicit and has no retry. */
export function localDeploymentRpc(
  endpoint: string,
  allowSend = false,
  request: typeof fetch = fetch,
): DeploymentReadRpc {
  const reads = deploymentHttpsRpc(endpoint, request) // validates URL; no network here
  return async (method, params) => {
    if (!additionalReads.has(method) && method !== "eth_sendRawTransaction")
      return reads(method, params)
    if (
      method === "eth_sendRawTransaction" &&
      (!allowSend ||
        params.length !== 1 ||
        typeof params[0] !== "string" ||
        !/^0x02(?:[0-9a-f]{2})+$/i.test(params[0]) ||
        params[0].length > 131074)
    )
      throw Error("LOCAL_DEPLOYMENT_SEND_DISABLED")
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let finished = false
    const start = performance.now(),
      timeoutMs = 10000,
      maxBytes = 4 * 1024 * 1024
    const failure = () => Error("LOCAL_DEPLOYMENT_RPC_UNAVAILABLE")
    const current = () => {
      if (finished || performance.now() - start >= timeoutMs) throw failure()
    }
    const cancel = () => {
      if (reader) void reader.cancel().catch(() => {})
    }
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        cancel()
        reject(failure())
      }, timeoutMs)
    })
    const work = async () => {
      const id = randomUUID()
      const response = await request(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      })
      try {
        current()
        if (
          !response.ok ||
          response.redirected ||
          (response.url && response.url !== new URL(endpoint).href) ||
          !response.body
        )
          throw failure()
        const length = response.headers.get("content-length")
        if (length !== null && (!/^\d{1,16}$/.test(length) || Number(length) > maxBytes))
          throw failure()
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          current()
          const item = await reader.read()
          current()
          if (item.done) break
          total += item.value.byteLength
          if (total > maxBytes) throw failure()
          chunks.push(item.value)
        }
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        )
        current()
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.id !== id ||
          value.jsonrpc !== "2.0" ||
          value.error ||
          !Object.prototype.hasOwnProperty.call(value, "result")
        )
          throw failure()
        return value.result
      } finally {
        if (reader) cancel()
        else void response.body?.cancel().catch(() => {})
      }
    }
    try {
      const value = await Promise.race([work(), deadline])
      current()
      return value
    } catch {
      throw failure()
    } finally {
      finished = true
      clearTimeout(timer)
      controller.abort()
      cancel()
    }
  }
}
