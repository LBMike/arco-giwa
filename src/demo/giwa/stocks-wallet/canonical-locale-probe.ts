// TEST ONLY: run in a fresh process whose default locale is chosen by canonical-locale.test.tsx. No network, DB or
// secrets. Applies the backend's frozen en-US golden vectors (never regenerated here) to the browser planner.
import { fileURLToPath } from "node:url"

import { createStocksExecutionReads } from "../stocks-wallet-http/reads"
import { canonical, digest, planOrder } from "./planner"
import type { ExecutionContext, ManifestV2, ReviewedDeployment, Side } from "./types"

type Vector = { name: string; value: unknown; canonical: string; digest: string }
type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const repo = fileURLToPath(new URL("../../../../", import.meta.url))
const fixtures: AnyModule = await import(`${repo}server/src/stocks/canonical-locale-fixtures.ts`)
const serverContracts: AnyModule = await import(`${repo}server/src/stocks/contracts.ts`)
const serverSubmissions: AnyModule = await import(`${repo}server/src/stocks-submissions/contracts.ts`)
const vectors = fixtures.canonicalLocaleVectors as Vector[]
const byName = new Map(vectors.map((vector) => [vector.name, vector]))
const failures: string[] = []
const verify = (name: string, check: () => boolean) => {
  try {
    if (!check()) failures.push(name)
  } catch {
    failures.push(`${name}:threw`)
  }
}

function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed) // Array order is meaningful and never sorted.
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)]))
  return value
}

// 1. Every frozen vector through the browser canonical form and digest, also with reordered keys.
for (const vector of vectors) {
  verify(`${vector.name}:canonical`, () => canonical(vector.value) === vector.canonical)
  verify(`${vector.name}:digest`, () => digest(vector.value) === vector.digest)
  const reordered = JSON.parse(JSON.stringify(reversed(vector.value)))
  verify(`${vector.name}:reordered`, () => canonical(reordered) === vector.canonical && digest(reordered) === vector.digest)
}

// 2. Real planner entry points: BUY against the frozen transaction/intent vectors, SELL against server deriveOrder.
const manifest = byName.get("manifest")!.value as ManifestV2
const manifestDigest = byName.get("manifest")!.digest
const binding = byName.get("orderBinding")!.value as Record<string, string>
const now = Date.parse(binding.quoteExpiresAt!) - 60_000
const context: ExecutionContext = {
  session: { id: "locale-session", walletAddress: binding.wallet as `0x${string}`, chainId: 91342, accessToken: "locale.token.value", createdAt: now - 1_000, expiresAt: now + 60_000 },
  walletAddress: binding.wallet!,
  chainId: 91342,
  walletEpoch: "locale:1",
  apiBase: "https://locale.test",
  deployment: { status: "VERIFIED", evidenceId: "locale-evidence", manifestDigest, manifest, verifiedAt: now - 1_000, validUntil: now + 10_000 },
}
function row(side: Side) {
  const orderKey = side === "BUY" ? binding.orderKey : serverContracts.operationKey(`sell:${manifest.networkInstance}:${binding.orderId}`)
  // The binding vector is a BUY row; a SELL row carries side "SELL" like the server's SELL rows.
  return { ...binding, side, id: binding.orderId, orderKey, quoteId: "locale-quote", state: side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW", version: 0, idempotencyKey: "locale-idempotency" }
}
verify("planOrder:BUY", () => {
  const plan = planOrder({ side: "BUY", order: row("BUY") }, context, now)
  return digest(plan.approval) === byName.get("approvalTransaction")!.digest && digest(plan.transfer) === byName.get("transferTransaction")!.digest && plan.intentKey === byName.get("intentArray")!.digest && plan.manifestDigest === manifestDigest
})
verify("planOrder:SELL-vs-server-deriveOrder", () => {
  const plan = planOrder({ side: "SELL", order: row("SELL") }, context, now)
  const server = serverSubmissions.deriveOrder(manifest, row("SELL"), "SELL")
  return canonical(plan.approval) === canonical(server.approval) && canonical(plan.transfer) === canonical(server.transfer) && digest(plan.approval) === serverSubmissions.digest(server.approval) && digest(plan.transfer) === serverSubmissions.digest(server.transfer) && plan.intentKey === server.intentKey
})

// 3. Server DTO → read adapter → planner validation: en-US server evidence is accepted in this locale.
const evidenceAt = Date.UTC(2026, 8, 17, 0, 0, 0)
const evidence: ReviewedDeployment = { status: "VERIFIED", evidenceId: "locale-evidence", manifestDigest, manifest, verifiedAt: evidenceAt - 100, validUntil: evidenceAt + 14_900 }
const body = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE", observedAt: new Date(evidenceAt).toISOString(), data: evidence }
const reads = createStocksExecutionReads({ apiBase: "https://locale.test", fetch: async () => new Response(JSON.stringify(body), { status: 200 }), now: () => evidenceAt, monotonicNow: () => 1_000 })
let adapter = "not-run"
try {
  const lease = await reads.readDeployment({ apiBase: "https://locale.test", token: "locale.token.value", sessionId: "locale-session", signal: new AbortController().signal, deploymentDigest: manifestDigest })
  adapter = lease.deployment.manifestDigest === manifestDigest ? "ACCEPTED" : "WRONG_DIGEST"
} catch (error) {
  adapter = `REJECTED:${(error as { code?: string }).code ?? "unknown"}`
}
verify("readDeployment:en-US-evidence", () => adapter === "ACCEPTED")

// Negative control: the default locale really changes key order for cs/sk (and not for en-US).
const defaultOrder = JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))))
const goldenTopLevel = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(byName.get("manifest")!.canonical) as object)))

console.log(JSON.stringify({ locale: Intl.Collator().resolvedOptions().locale, node: process.version, icu: process.versions.icu, vectorCount: vectors.length, failures, adapter, defaultLocaleOrderMatchesGolden: Object.keys(JSON.parse(defaultOrder)).join() === Object.keys(JSON.parse(goldenTopLevel)).join() }))
if (failures.length) process.exitCode = 1
