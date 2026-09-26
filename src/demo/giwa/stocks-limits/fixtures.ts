// EXPLICIT FIXTURES — tests only. The panel never imports this file. Shapes mirror server/src/stocks-trading-limits/plugin.ts.
export const LIM_PROFILE = Object.freeze({ profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" })
export const LIM_DIGEST = "7a".repeat(32)
export const LIM_OBSERVED_AT = "2026-09-26T03:00:00.000Z"
/** 12:00:05 KST; the day resets at 15:00 UTC. */
export const LIM_NOW = Date.parse("2026-09-26T03:00:05.000Z")
export const LIM_WINDOW = Object.freeze({ start: "2026-09-25T15:00:00.000Z", resetsAt: "2026-09-26T15:00:00.000Z", timeZone: "Asia/Seoul" as const })

type Side = "BUY" | "SELL"
type Over = Record<string, unknown>

export function limEnvelope(data: unknown, observedAt: string = LIM_OBSERVED_AT) {
  return { ...LIM_PROFILE, observedAt, data }
}
export function limError(error: string) {
  return { ...LIM_PROFILE, observedAt: LIM_OBSERVED_AT, data: null, error }
}
export function limTime(version: number): string {
  return new Date(Date.parse("2026-09-26T01:00:00.000Z") + version * 60_000).toISOString()
}
export function limState(side: Side, version = 0, over: Over = {}) {
  if (version === 0) return { deploymentDigest: LIM_DIGEST, symbol: "NVDA", side, enabled: true, dailyCashLimit: null, version: 0, updatedAt: null, operatorId: null, reason: null, ...over }
  return { deploymentDigest: LIM_DIGEST, symbol: "NVDA", side, enabled: true, dailyCashLimit: null, version, updatedAt: limTime(version), operatorId: "ops-limits-a", reason: `Reason for version ${version}`, ...over }
}
export function limRow(side: Side, version = 0, over: Over = {}, usedToday = "0") {
  return { ...limState(side, version, over), usedToday }
}
export function limRead(items: unknown[] = [limRow("BUY"), limRow("SELL")], window: Over = LIM_WINDOW) {
  return { items, window: { ...window } }
}
export function limEvent(side: Side, version: number, over: Over = {}) {
  return {
    id: `limit-event-${side}-${version}`,
    deploymentDigest: LIM_DIGEST,
    symbol: "NVDA",
    side,
    version,
    previousEnabled: true,
    previousDailyCashLimit: null,
    enabled: true,
    dailyCashLimit: null,
    operatorId: "ops-limits-a",
    reason: `Reason for version ${version}`,
    createdAt: limTime(version),
    ...over,
  }
}
