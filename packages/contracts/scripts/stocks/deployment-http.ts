import { randomUUID } from "crypto"

export type DeploymentReadRpc = (method: string, params: unknown[]) => Promise<unknown>
const reads = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_call",
])
export const DEPLOYMENT_RPC_MAX_BYTES = 4 * 1024 * 1024

/** Explicit read-only transport. The third argument supplies smaller test budgets only. */
export function deploymentHttpsRpc(
  endpoint: string,
  request: typeof fetch = fetch,
  options: { timeoutMs?: number; maxBytes?: number; now?: () => number } = {},
): DeploymentReadRpc {
  let target: URL
  try {
    target = new URL(endpoint)
    if (
      !endpoint.startsWith("https://") ||
      /[\s\\?#]/.test(endpoint) ||
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      !target.hostname
    )
      throw Error()
  } catch {
    throw Error("EXPLICIT_HTTPS_READ_RPC_REQUIRED")
  }
  const {
    timeoutMs = 10000,
    maxBytes = DEPLOYMENT_RPC_MAX_BYTES,
    now = () => performance.now(),
  } = options
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DEPLOYMENT_RPC_MAX_BYTES
  )
    throw Error("INVALID_DEPLOYMENT_RPC_BUDGET")
  return async (method, params) => {
    if (!reads.has(method)) throw Error("READ_ONLY_DEPLOYMENT_RPC")
    const failure = () => Error("DEPLOYMENT_RPC_UNAVAILABLE")
    const controller = new AbortController(),
      start = now()
    let finished = false,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => {
      const elapsed = now() - start
      if (finished || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeoutMs)
        throw failure()
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
      current()
      const id = randomUUID()
      const response = await request(target, {
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
          (response.url && response.url !== target.href) ||
          !response.body
        )
          throw failure()
        const length = response.headers.get("content-length")
        if (length !== null && (!/^\d{1,16}$/.test(length) || Number(length) > maxBytes))
          throw failure()
        reader = response.body.getReader()
        let bytes = new Uint8Array(Math.min(8192, maxBytes)),
          total = 0
        for (;;) {
          current()
          const item = await reader.read()
          current()
          if (item.done) break
          const next = total + item.value.byteLength
          if (next > maxBytes) throw failure()
          if (next > bytes.length) {
            const grown = new Uint8Array(Math.min(maxBytes, Math.max(next, bytes.length * 2)))
            grown.set(bytes)
            bytes = grown
          }
          bytes.set(item.value, total)
          total = next
        }
        const row: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)),
        )
        current()
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw Error("DEPLOYMENT_RPC_RESPONSE_INVALID")
        const value = row as Record<string, unknown>
        if (
          value.jsonrpc !== "2.0" ||
          value.id !== id ||
          value.error ||
          !Object.prototype.hasOwnProperty.call(value, "result")
        )
          throw Error("DEPLOYMENT_RPC_RESPONSE_INVALID")
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
    } catch (error) {
      // Preserve only our envelope error; never surface provider text, URL, body or nested cause.
      if (error instanceof Error && error.message === "DEPLOYMENT_RPC_RESPONSE_INVALID")
        throw Error("DEPLOYMENT_RPC_RESPONSE_INVALID")
      throw failure()
    } finally {
      finished = true
      clearTimeout(timer)
      controller.abort()
      cancel()
    }
  }
}
