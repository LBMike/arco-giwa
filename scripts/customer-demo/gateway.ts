import type { IncomingMessage, ServerResponse } from "node:http"
import { parseSiweMessage } from "viem/siwe"

// Existing product services only. Browser input cannot choose an upstream.
export const CUSTOMER_API = "https://arco-giwa-api.onrender.com"
export const CUSTOMER_RPC = "https://sepolia-rpc.giwa.io"
const MAX_REQUEST = 64 * 1024
const MAX_RESPONSE = 4_000_000
const RPC_READS = new Set(["eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs"])
class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function publicRead(raw: string, method: string): boolean {
  if (method !== "GET" || !raw.startsWith("/") || raw.startsWith("//") || /[%\\#?]/.test(raw)) return false
  return /^\/api\/v1\/evm\/(registry|catalog|featured|market)\/91342$/.test(raw)
    || /^\/api\/v1\/evm\/market\/91342\/[a-zA-Z0-9_-]{1,80}\/history$/.test(raw)
    || /^\/api\/v1\/(portfolio|activity|redemptions)\/0x[a-fA-F0-9]{40}$/.test(raw)
    || /^\/api\/v1\/faucet\/0x[a-fA-F0-9]{40}\/status$/.test(raw)
    || raw === "/api/v1/stocks/catalog"
}

function privateRead(raw: string, method: string): boolean {
  return method === "GET" && (/^\/api\/v1\/stocks\/(portfolio|orders|sell-orders)$/.test(raw)
    || /^\/api\/v1\/stocks\/(orders|sell-orders)\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(raw))
}

function authBody(text: string, kind: "nonce" | "verify", origin: string): string {
  let value: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    value = parsed as Record<string, unknown>
  } catch { throw new GatewayError(400, "INVALID_CUSTOMER_AUTH") }
  const domain = new URL(origin).host
  if (kind === "nonce") {
    if (value.domain !== domain || typeof value.walletAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value.walletAddress)
      || Object.keys(value).some(key => !["walletAddress", "domain"].includes(key))) throw new GatewayError(400, "INVALID_CUSTOMER_AUTH_SCOPE")
    return JSON.stringify({ walletAddress: value.walletAddress, domain })
  }
  if (typeof value.message !== "string" || typeof value.signature !== "string" || !/^0x[a-fA-F0-9]{130}$/.test(value.signature)
    || Object.keys(value).some(key => !["message", "signature"].includes(key))) throw new GatewayError(400, "INVALID_CUSTOMER_AUTH")
  let message
  try { message = parseSiweMessage(value.message) } catch { throw new GatewayError(400, "INVALID_CUSTOMER_AUTH") }
  if (message.domain !== domain || message.uri !== origin || message.chainId !== 91342 || message.version !== "1"
    || (message.scheme !== undefined && message.scheme !== "http")) throw new GatewayError(400, "INVALID_CUSTOMER_AUTH_SCOPE")
  // The existing backend remains responsible for cryptographic verification and single-use nonce consumption.
  return JSON.stringify({ message: value.message, signature: value.signature })
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const clean = () => { request.off("data", data); request.off("end", end); request.off("error", error); signal.removeEventListener("abort", abort) }
    const error = (error: Error) => { clean(); request.resume(); reject(error) }
    const abort = () => error(new GatewayError(504, "CUSTOMER_API_TIMEOUT"))
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST) { error(new GatewayError(413, "CUSTOMER_REQUEST_TOO_LARGE")); return }
      chunks.push(chunk)
    }
    const end = () => { clean(); resolve(Buffer.concat(chunks).toString("utf8")) }
    request.on("data", data); request.once("end", end); request.once("error", error)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function validateRpc(text: string) {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new GatewayError(400, "INVALID_CUSTOMER_REQUEST") }
  const calls = Array.isArray(value) ? value : [value]
  if (!calls.length || calls.length > 100 || calls.some(value => {
    if (!value || typeof value !== "object") return true
    const call = value as Record<string, unknown>
    return call.jsonrpc !== "2.0" || typeof call.method !== "string" || !RPC_READS.has(call.method) || !Array.isArray(call.params)
  })) throw new GatewayError(403, "CUSTOMER_RPC_READ_ONLY")
}

async function responseBody(response: Response): Promise<Buffer> {
  if (!response.headers.get("content-type")?.includes("application/json")) throw new GatewayError(502, "CUSTOMER_API_UNAVAILABLE")
  const reader = response.body?.getReader()
  if (!reader) throw new GatewayError(502, "CUSTOMER_API_UNAVAILABLE")
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > MAX_RESPONSE) throw new GatewayError(502, "CUSTOMER_API_UNAVAILABLE")
      chunks.push(Buffer.from(part.value))
    }
    const body = Buffer.concat(chunks)
    JSON.parse(body.toString("utf8"))
    return body
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Authentication is explicitly enabled only for the existing fixed GIWA API. No trading writes. */
export function customerGateway({ origin, fetcher = fetch, timeoutMs = 15_000, authEnabled = false }: {
  origin: string; fetcher?: typeof fetch; timeoutMs?: number; authEnabled?: boolean
}) {
  const parsed = new URL(origin)
  if (parsed.origin !== origin || parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) throw new Error("INVALID_CUSTOMER_ORIGIN")
  const host = parsed.host
  const send = (response: ServerResponse, status: number, body: string | Buffer) => {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" })
    response.end(body)
  }
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const raw = request.url ?? "/"
    if (!raw.startsWith("/api/") && !raw.startsWith("/__fixture/") && !raw.startsWith("/__giwa/")) { next(); return }
    const method = request.method ?? "GET"
    const rpc = raw === "/__giwa/read-rpc" && method === "POST"
    const auth = authEnabled && method === "POST" ? raw === "/api/v1/auth/nonce" ? "nonce" : raw === "/api/v1/auth/verify" ? "verify" : null : null
    const privateGet = authEnabled && privateRead(raw, method)
    const fail = (status: number, code: string) => send(response, status, JSON.stringify({ error: code }))
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") return fail(403, "CUSTOMER_ORIGIN_DENIED")
    if (!rpc && !auth && !privateGet && !publicRead(raw, method)) return fail(503, raw.startsWith("/api/v1/auth/") ? "CUSTOMER_SIGN_IN_NOT_CONNECTED" : "CUSTOMER_ROUTE_NOT_CONNECTED")
    if ((rpc || auth) && request.headers.origin !== origin) return fail(403, "CUSTOMER_ORIGIN_DENIED")
    if ((rpc || auth) && !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) return fail(415, "CUSTOMER_JSON_REQUIRED")
    const bearer = request.headers.authorization
    if (privateGet && (typeof bearer !== "string" || bearer.length > 4103 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer))) return fail(401, "CUSTOMER_SESSION_REQUIRED")
    const abort = new AbortController()
    const close = () => abort.abort()
    response.once("close", close)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new GatewayError(504, "CUSTOMER_API_TIMEOUT")) }, timeoutMs) })
      const work = async () => {
        const headers: Record<string, string> = { accept: "application/json" }
        let body: string | undefined
        if (rpc) { body = await readBody(request, abort.signal); validateRpc(body); headers["content-type"] = "application/json" }
        if (auth) { body = authBody(await readBody(request, abort.signal), auth, origin); headers["content-type"] = "application/json" }
        if (privateGet) headers.authorization = bearer!
        const answer = await fetcher(rpc ? CUSTOMER_RPC : `${CUSTOMER_API}${raw}`, { method, headers, body, signal: abort.signal, redirect: "error", credentials: "omit", cache: "no-store" })
        if (answer.status >= 300 && answer.status < 400) throw new GatewayError(502, "CUSTOMER_API_UNAVAILABLE")
        return { status: answer.status, body: await responseBody(answer) }
      }
      const result = await Promise.race([work(), deadline])
      send(response, result.status, result.body)
    } catch (error) {
      fail(error instanceof GatewayError ? error.status : 502, error instanceof GatewayError ? error.code : "CUSTOMER_API_UNAVAILABLE")
    } finally { clearTimeout(timer); abort.abort(); response.off("close", close) }
  }
}
