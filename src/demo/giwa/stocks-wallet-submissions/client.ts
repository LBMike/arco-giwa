import type { HostSession } from "../stocks-host/session"
import { digest } from "../stocks-wallet/planner"
import type { AttemptRecord, ReconcileRequest, Side, SubmissionGate } from "../stocks-wallet/types"
import { attempt, digestString, ensure, envelope, exact, label, object, SubmissionError, transaction, wallet } from "./validate"

export type SubmissionClientOptions = {
  session: HostSession
  side: Side
  orderId: string
  deploymentDigest: string
  apiBase: string
  /** Optional identity already verified by the caller's active wallet source. */
  walletAddress?: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  monotonicNow?: () => number
  timeoutMs?: number
  onSessionRejected?: (capturedSessionId: string) => void
}
const MAX_BYTES = 32_768

/** Authenticated transport only. It cannot verify a wallet, grant policy permission or provide durable storage. */
export function createSubmissionGate(options: SubmissionClientOptions): SubmissionGate {
  const session = Object.freeze({ ...options.session })
  const side = options.side
  const orderId = label(options.orderId)
  const deploymentDigest = digestString(options.deploymentDigest)
  ensure(side === "BUY" || side === "SELL", "SUBMISSION_INVALID_SIDE")
  const owner = wallet(session.walletAddress)
  if (options.walletAddress !== undefined) ensure(wallet(options.walletAddress) === owner, "SUBMISSION_WALLET_MISMATCH")
  ensure(session.chainId === 91342 && typeof session.id === "string" && session.id.length > 0 && session.id.length <= 256, "SUBMISSION_AUTH_REQUIRED")
  ensure(typeof session.accessToken === "string" && /^[A-Za-z0-9._~-]{1,4096}$/.test(session.accessToken), "SUBMISSION_AUTH_REQUIRED")
  let url: URL
  try { url = new URL(options.apiBase) } catch { throw new SubmissionError("SUBMISSION_INVALID_API_BASE") }
  // Any "?" or "#" (even empty, which leaves url.search/url.hash empty) would move the API path into a query or fragment.
  ensure(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.href.includes("?") && !url.href.includes("#"), "SUBMISSION_INVALID_API_BASE")
  const base = url.href.replace(/\/+$/, "")
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const rejectSession = options.onSessionRejected
  const timeout = options.timeoutMs ?? 10_000
  ensure(Number.isFinite(timeout) && timeout > 0 && timeout <= 60_000, "SUBMISSION_INVALID_TIMEOUT")
  const capturedWall = now(), capturedMono = monotonicNow()
  ensure(Number.isFinite(capturedWall) && Number.isFinite(capturedMono), "SUBMISSION_INVALID_CLOCK")
  const remaining = session.expiresAt - capturedWall
  const auth = () => {
    const wall = now(), mono = monotonicNow()
    ensure(Number.isFinite(wall) && Number.isFinite(mono) && Number.isFinite(session.createdAt) && Number.isFinite(session.expiresAt) && wall >= capturedWall && wall >= session.createdAt && wall < session.expiresAt && mono >= capturedMono && mono - capturedMono < remaining, "SUBMISSION_AUTH_REQUIRED")
  }
  auth()
  let intent: string | null = null
  // Validation bindings only. No record is ever used to grant/replay claim permission.
  const observed = new Map<string, AttemptRecord>()
  function bind(value: unknown) {
    const key = digestString(value)
    ensure(intent === null || intent === key, "SUBMISSION_SCOPE_MISMATCH")
    intent = key
    return key
  }
  function sameBinding(actual: AttemptRecord, expected: AttemptRecord) {
    ensure(actual.claimId === expected.claimId && actual.intentKey === expected.intentKey && actual.stage === expected.stage && actual.transactionDigest === expected.transactionDigest, "SUBMISSION_SCOPE_MISMATCH")
  }
  const terminal = (row: AttemptRecord) => row.status === "CONFIRMED" || row.status === "REVERTED"
  function remember(row: AttemptRecord): AttemptRecord {
    const previous = observed.get(row.stage)
    if (previous) {
      sameBinding(row, previous)
      if (previous.txHash && row.txHash) ensure(previous.txHash === row.txHash, "SUBMISSION_HASH_MISMATCH")
      if (terminal(previous)) {
        if (terminal(row)) ensure(row.status === previous.status, "SUBMISSION_TERMINAL_MISMATCH")
        return previous // A late pending/outcome response cannot erase trusted evidence.
      }
      if (previous.status === "SUBMITTED" && !terminal(row) && row.status !== "SUBMITTED") return previous
      if (previous.txHash && !row.txHash) return previous
    }
    observed.set(row.stage, row)
    return row
  }
  async function request<T>(path: string, body: unknown | undefined, parse: (value: unknown) => T): Promise<T> {
    auth()
    const started = monotonicNow()
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectDeadline!: (reason: Error) => void
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject })
    const check = () => { auth(); const elapsed = monotonicNow() - started; ensure(Number.isFinite(elapsed) && elapsed >= 0 && elapsed < timeout && !abort.signal.aborted, "SUBMISSION_TIMEOUT") }
    const bound = <V,>(promise: Promise<V>) => Promise.race([promise, deadline])
    timer = setTimeout(() => { abort.abort(); rejectDeadline(new SubmissionError("SUBMISSION_TIMEOUT")) }, timeout)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let completed = false
    try {
      check()
      const response = await bound(fetcher(`${base}/api/v1/stocks/wallet-submissions/${path}`, {
        method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
        headers: { accept: "application/json", authorization: `Bearer ${session.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal,
      }))
      check()
      if (response.status === 401) {
        // Reentrant callbacks may replace the host account; never read a new session here.
        try { rejectSession?.(session.id) } catch { /* Rejection must still fail closed. */ }
        throw new SubmissionError("SUBMISSION_AUTH_REJECTED")
      }
      ensure(response.ok, "SUBMISSION_HTTP_ERROR")
      const length = response.headers.get("content-length")
      ensure(length === null || (/^\d+$/.test(length) && Number(length) <= MAX_BYTES), "SUBMISSION_BODY_TOO_LARGE")
      reader = response.body?.getReader()
      ensure(reader, "SUBMISSION_INVALID_RESPONSE")
      const chunks: Uint8Array[] = []; let bytes = 0
      for (;;) {
        const part = await bound(reader.read()); check()
        if (part.done) break
        bytes += part.value.byteLength
        ensure(bytes <= MAX_BYTES, "SUBMISSION_BODY_TOO_LARGE")
        chunks.push(part.value)
      }
      const joined = new Uint8Array(bytes); let offset = 0
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
      check()
      const result = parse(envelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined))))
      check()
      completed = true
      return result
    } catch (error) {
      if (error instanceof SubmissionError) throw error
      throw new SubmissionError("SUBMISSION_REQUEST_FAILED")
    } finally {
      clearTimeout(timer)
      if (!completed) { abort.abort(); if (reader) void reader.cancel().catch(() => {}) }
      reader?.releaseLock()
    }
  }
  return Object.freeze({
    async inspect(expectedIntent: string) {
      const key = bind(expectedIntent)
      const result = await request(`${side}/${encodeURIComponent(orderId)}`, undefined, value => {
        const row = object(value); exact(row, ["intentKey", "approval", "transfer"])
        ensure(row.intentKey === key, "SUBMISSION_SCOPE_MISMATCH")
        const approval = row.approval === null ? null : attempt(row.approval, true)
        const transfer = row.transfer === null ? null : attempt(row.transfer, true)
        for (const [stage, entry] of [["APPROVAL", approval], ["TRANSFER", transfer]] as const) if (entry) ensure(entry.stage === stage && entry.intentKey === key, "SUBMISSION_SCOPE_MISMATCH")
        return { approval, transfer }
      })
      auth()
      if (result.approval) result.approval = remember(result.approval)
      else ensure(!observed.has("APPROVAL"), "SUBMISSION_HISTORY_MISSING")
      if (result.transfer) result.transfer = remember(result.transfer)
      else ensure(!observed.has("TRANSFER"), "SUBMISSION_HISTORY_MISSING")
      return result
    },
    async claim(input: Parameters<SubmissionGate["claim"]>[0]) {
      const row = object(input); exact(row, ["intentKey", "stage", "transactionDigest", "transaction", "orderId", "deploymentDigest"])
      ensure(row.orderId === orderId && row.deploymentDigest === deploymentDigest, "SUBMISSION_SCOPE_MISMATCH")
      ensure(row.stage === "APPROVAL" || row.stage === "TRANSFER", "SUBMISSION_SCOPE_MISMATCH")
      const key = bind(row.intentKey), tx = transaction(row.transaction, owner), txDigest = digestString(row.transactionDigest)
      ensure(digest(tx) === txDigest, "SUBMISSION_TRANSACTION_MISMATCH")
      const body = { side, orderId, intentKey: key, stage: row.stage, transactionDigest: txDigest, transaction: tx, deploymentDigest }
      const result = await request("claims", body, value => {
        if (value === null) return null
        const result = attempt(value)
        ensure(result.intentKey === key && result.stage === body.stage && result.transactionDigest === txDigest && result.status === "REQUEST_MAY_START", "SUBMISSION_SCOPE_MISMATCH")
        return result
      })
      auth()
      if (result) { ensure(!observed.has(result.stage), "SUBMISSION_REPLAYED_PERMISSION"); remember(result) }
      return result
    },
    async record(input: AttemptRecord) {
      const row = attempt(input)
      ensure(row.status === "UNKNOWN" || row.status === "SUBMITTED", "SUBMISSION_OUTCOME_NOT_ALLOWED")
      ensure(row.intentKey === intent, "SUBMISSION_SCOPE_MISMATCH")
      const previous = observed.get(row.stage)
      ensure(previous, "SUBMISSION_UNOBSERVED_CLAIM")
      sameBinding(row, previous)
      if (previous.txHash && row.txHash) ensure(previous.txHash === row.txHash, "SUBMISSION_HASH_MISMATCH")
      const result = await request("outcomes", row, value => {
        const result = attempt(value, true); sameBinding(result, row)
        ensure(result.status === "UNKNOWN" || result.status === "SUBMITTED" || terminal(result), "SUBMISSION_SCOPE_MISMATCH")
        if (row.status === "SUBMITTED" || previous.status === "SUBMITTED") ensure(result.status === "SUBMITTED" || terminal(result), "SUBMISSION_SCOPE_MISMATCH")
        const expectedHash = row.txHash ?? previous.txHash
        if (expectedHash) ensure(result.txHash === expectedHash, "SUBMISSION_HASH_MISMATCH")
        return result
      })
      auth()
      // Outcomes may preserve a server terminal state, but only inspect/reconcile grants authority.
      if (terminal(result)) {
        const known = observed.get(row.stage)!
        if (terminal(known)) remember(result)
        else remember(row)
      } else remember(result)
    },
    async reconcile(input: ReconcileRequest) {
      const raw = object(input)
      exact(raw, ["claimId", "intentKey", "stage", "transactionDigest", "txHash"])
      const row = attempt({ ...raw, status: "SUBMITTED" })
      ensure(row.intentKey === intent, "SUBMISSION_SCOPE_MISMATCH")
      const previous = observed.get(row.stage)
      ensure(previous && previous.txHash === row.txHash, "SUBMISSION_UNOBSERVED_HASH")
      sameBinding(row, previous)
      const body = { claimId: row.claimId, intentKey: row.intentKey, stage: row.stage, transactionDigest: row.transactionDigest, txHash: row.txHash! }
      const result = await request("reconcile", body, value => {
        const result = attempt(value, true); sameBinding(result, row)
        ensure(result.txHash === row.txHash, "SUBMISSION_HASH_MISMATCH")
        return result
      })
      auth()
      return remember(result)
    },
  })
}
