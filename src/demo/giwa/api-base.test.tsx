import assert from "node:assert/strict"
import test from "node:test"
import { createStocksHostSession } from "./stocks-host/session"
import { createGiwaStocksHttpClient } from "./stocks-investor/client"
import { createMarketClient } from "./stocks-market/client"
import { stocksAdminGet } from "./stocks-admin/client"
import { validateContext } from "./stocks-wallet/planner"
import type { ExecutionContext } from "./stocks-wallet/types"
import { createSubmissionGate } from "./stocks-wallet-submissions/client"
import { createStocksExecutionReads } from "./stocks-wallet-http/reads"
import { DIGEST, START, WALLET, manifest, read } from "./stocks-wallet-http/test-support"

// Loaded per test so the cross-module agreement below still runs where the helper does not exist yet.
const helpers = () => import("./api-base")

const TOKEN = "corpus-header.corpus-payload.corpus-signature"
const ORIGIN = "https://app.test"
const REJECTED: unknown[] = [
  "https://api.test?", "https://api.test#", "https://api.test/?", "https://api.test/#",
  "https://api.test/prefix?", "https://api.test/prefix#", "https://api.test?x=1", "https://api.test#x",
  "https://api.test/prefix?x=1", "https://user@api.test", "https://user:pass@api.test", "ftp://api.test",
  "javascript:alert(1)", "data:text/plain,x", "file:///etc", "", "not a url", "/relative", null, 42, {},
]
const ACCEPTED: [string, string][] = [
  ["https://api.test", "https://api.test"],
  ["https://api.test/", "https://api.test"],
  ["https://api.test/prefix/", "https://api.test/prefix"],
  ["https://api.test/prefix//", "https://api.test/prefix"],
  ["http://localhost:8080", "http://localhost:8080"],
  ["https://api.test/prefix%3Fsegment", "https://api.test/prefix%3Fsegment"],
]
/** Relative values the host (and only the host) resolves against the frontend origin. */
const HOST_RELATIVE = new Map<unknown, string>([["", ORIGIN], ["/relative", `${ORIGIN}/relative`], ["not a url", `${ORIGIN}/not%20a%20url`]])

test("normalizeApiBase refuses delimiters, credentials, other schemes, relative and non-string values", async () => {
  const { normalizeApiBase } = await helpers()
  for (const value of REJECTED) assert.equal(normalizeApiBase(value), null, JSON.stringify(value))
})

test("normalizeApiBase keeps the path prefix and percent-encoding and removes every trailing slash", async () => {
  const { normalizeApiBase } = await helpers()
  for (const [value, expected] of ACCEPTED) assert.equal(normalizeApiBase(value), expected, value)
})

test("resolveApiBase resolves only against a plain frontend origin and applies the same checks", async () => {
  const { resolveApiBase } = await helpers()
  assert.equal(resolveApiBase("", ORIGIN), ORIGIN)
  assert.equal(resolveApiBase("/api", ORIGIN), `${ORIGIN}/api`)
  assert.equal(resolveApiBase("/api/", `${ORIGIN}/`), `${ORIGIN}/api`)
  assert.equal(resolveApiBase("https://api.test/prefix/", ORIGIN), "https://api.test/prefix")
  for (const value of ["/api?", "/api#", "?", "#", "/api?x=1", "https://user:pass@api.test", "javascript:alert(1)", null, 42, {}]) {
    assert.equal(resolveApiBase(value, ORIGIN), null, JSON.stringify(value))
  }
  // A relative value can never add credentials: they would make it absolute, and absolute credentials are refused.
  assert.equal(resolveApiBase("//user:pass@api.test", ORIGIN), null)
  for (const origin of ["https://app.test?", "https://app.test#", "https://app.test/?x=1", "https://user@app.test", "ftp://app.test", "https://app.test/path", "/app", "", "not a url"]) {
    assert.equal(resolveApiBase("", origin), null, origin)
    assert.equal(resolveApiBase("/api", origin), null, origin)
  }
  assert.equal(resolveApiBase("", null as unknown as string), null)
})

type Verdict = { accepted: boolean; url: string | null; authorization: string | null; message: string }
type Recorded = { url: string; init: RequestInit }

function recorder(status = 403) {
  const calls: Recorded[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ error: "FIXTURE_REFUSED" }), { status, headers: { "content-type": "application/json" } })
  }
  return { calls, fetch }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}:${String((error as { code?: unknown }).code ?? "")}` : JSON.stringify(error)
}

function verdict(calls: Recorded[], thrown: unknown): Verdict {
  const call = calls[0]
  const authorization = call ? new Headers(call.init.headers).get("authorization") : null
  return { accepted: calls.length > 0, url: call?.url ?? null, authorization, message: thrown === undefined ? "" : messageOf(thrown) }
}

async function host(value: unknown): Promise<Verdict> {
  const { calls, fetch } = recorder()
  let signed = 0
  let controller: ReturnType<typeof createStocksHostSession>
  try {
    controller = createStocksHostSession({ walletAddress: WALLET, chainId: 91342, frontendOrigin: ORIGIN, apiBase: value as string }, {
      now: () => START, fetch: fetch as typeof globalThis.fetch, signMessage: async () => { signed++; throw Error("never signs") },
    })
  } catch (error) {
    return verdict(calls, error)
  }
  try {
    assert.equal(await controller.signIn(), null)
    assert.equal(signed, 0)
    return verdict(calls, calls.length ? undefined : controller.getSnapshot().error)
  } finally { controller.dispose() }
}

async function investor(value: unknown): Promise<Verdict> {
  const { calls, fetch } = recorder()
  try {
    const client = createGiwaStocksHttpClient({ baseUrl: value as string, fetch })
    await client.createQuote("BUY", { symbol: "NVDA", quantity: "1" }, TOKEN, new AbortController().signal).catch(() => {})
    return verdict(calls, undefined)
  } catch (error) {
    return verdict(calls, error)
  }
}

async function market(value: unknown): Promise<Verdict> {
  const { calls, fetch } = recorder()
  try {
    const client = createMarketClient(value as string, fetch)
    await client.catalog(new AbortController().signal).catch(() => {})
    return verdict(calls, undefined)
  } catch (error) {
    return verdict(calls, error)
  }
}

async function admin(value: unknown): Promise<Verdict> {
  const { calls, fetch } = recorder()
  const result = await stocksAdminGet({ apiBase: value as string, path: "/api/v1/admin/stocks/orders", accessToken: TOKEN, signal: new AbortController().signal, parse: data => data, fetch })
  return verdict(calls, calls.length ? undefined : result)
}

function planner(value: unknown): true | string {
  const session = { id: "corpus-session", walletAddress: WALLET, chainId: 91342 as const, accessToken: TOKEN, createdAt: START - 1000, expiresAt: START + 60_000 }
  const deployment = { status: "VERIFIED", evidenceId: "corpus-evidence", manifestDigest: DIGEST, manifest: manifest(), verifiedAt: START - 1000, validUntil: START + 10_000 }
  const context = { session, walletAddress: WALLET, chainId: 91342, walletEpoch: "corpus:1", apiBase: value, deployment } as unknown as ExecutionContext
  try {
    validateContext(context, START)
    return true
  } catch (error) {
    return messageOf(error)
  }
}

function submission(value: unknown): true | string {
  const session = { id: "corpus-session", walletAddress: WALLET, chainId: 91342 as const, accessToken: TOKEN, createdAt: START - 1000, expiresAt: START + 60_000 }
  const { calls, fetch } = recorder()
  try {
    createSubmissionGate({ session, side: "BUY", orderId: "corpus-order", deploymentDigest: DIGEST, apiBase: value as string, now: () => START, monotonicNow: () => 100, fetch: fetch as typeof globalThis.fetch })
    return true
  } catch (error) {
    assert.equal(calls.length, 0)
    return messageOf(error)
  }
}

async function reads(value: unknown, normalized: string | null): Promise<Verdict> {
  const { calls, fetch } = recorder()
  try {
    const client = createStocksExecutionReads({ apiBase: value as string, fetch, now: () => START, monotonicNow: () => 100 })
    await client.readCatalog(read("BUY", { apiBase: normalized ?? (value as string) })).catch(() => {})
    return verdict(calls, undefined)
  } catch (error) {
    return verdict(calls, error)
  }
}

/** Authorization per accepted request: only the investor quote and the admin read carry the session. */
const BEARERS = { host: null, investor: `Bearer ${TOKEN}`, market: null, admin: `Bearer ${TOKEN}`, reads: null }

function assertNoLeak(label: string, value: unknown, message: string) {
  assert.ok(!message.includes(TOKEN), `${label} leaks the token`)
  if (typeof value === "string" && value.length > 0) assert.ok(!message.includes(value), `${label} leaks the base ${value}: ${message}`)
}

test("host, investor, market, admin, planner, submission gate and wallet reads agree on every base", async () => {
  const disagreements: string[] = []
  const expect = (label: string, value: unknown, actual: boolean, expected: boolean) => {
    if (actual !== expected) disagreements.push(`${label} ${JSON.stringify(value)}: ${actual ? "accepted" : "refused"}`)
  }
  const corpus: [unknown, string | null][] = [...REJECTED.map(value => [value, null] as [unknown, null]), ...ACCEPTED]
  for (const [value, normalized] of corpus) {
    const expected = normalized !== null
    const hostBase = HOST_RELATIVE.get(value) ?? normalized
    const results: [string, Verdict, string | null][] = [
      ["host", await host(value), hostBase === null ? null : `${hostBase}/api/v1/auth/nonce`],
      ["investor", await investor(value), expected ? `${normalized}/api/v1/stocks/quotes` : null],
      ["market", await market(value), expected ? `${normalized}/api/v1/stocks/market/catalog` : null],
      ["admin", await admin(value), expected ? `${normalized}/api/v1/admin/stocks/orders` : null],
      ["reads", await reads(value, normalized), expected ? `${normalized}/api/v1/stocks/catalog` : null],
    ]
    for (const [label, result, url] of results) {
      expect(label, value, result.accepted, url !== null)
      if (url !== null && result.accepted && result.url !== url) disagreements.push(`${label} ${JSON.stringify(value)}: sent ${result.url}`)
      if (!result.accepted) assertNoLeak(label, value, result.message)
    }
    const authorizations = Object.fromEntries(results.filter(([, result]) => result.accepted).map(([label, result]) => [label, result.authorization]))
    if (expected && JSON.stringify(authorizations) !== JSON.stringify(BEARERS)) disagreements.push(`${JSON.stringify(value)}: Authorization ${JSON.stringify(authorizations)}`)
    for (const [label, result] of [["planner", planner(value)], ["submission", submission(value)]] as const) {
      expect(label, value, result === true, expected)
      if (result === true) continue
      assertNoLeak(label, value, result)
      // Values that parse as a URL must be refused with the module's fixed code, not a parser error.
      if (typeof value === "string" && URL.canParse(value)) assert.match(result, label === "planner" ? /INVALID_API_BASE/ : /SUBMISSION_INVALID_API_BASE/, `${label} ${value}`)
    }
  }
  assert.deepEqual(disagreements, [])
})
