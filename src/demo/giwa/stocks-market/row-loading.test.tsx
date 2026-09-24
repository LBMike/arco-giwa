import assert from "node:assert/strict"
import test from "node:test"
import { loadMarketRows } from "./useMarketRows"
import type { MarketClient } from "./client"
import { fixtureChart, fixtureEnvelope, fixtureProfile } from "./fixtures"
import { parseProfile } from "./validate"

test("row enrichment is bounded to three requests, isolates failures and loads every listed chart/profile", async () => {
  let active = 0, peak = 0
  const calls: string[] = [], published: string[] = []
  const delay = async (key: string) => { calls.push(key); peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active-- }
  const client = {
    async chart(symbol: string) { await delay(`chart:${symbol}`); if (symbol === "FAIL") throw new Error("offline"); return fixtureEnvelope(fixtureChart(symbol)) },
    async profile(symbol: string) { await delay(`profile:${symbol}`); return fixtureEnvelope(fixtureProfile(symbol)) },
  } as unknown as MarketClient
  await loadMarketRows(client, ["NVDA", "MU", "TSLA", "FAIL"], new AbortController().signal, true, (symbol, kind, data) => published.push(`${kind}:${symbol}:${data !== null}`))
  assert.equal(peak, 3)
  assert.equal(calls.length, 8)
  assert.equal(published.length, 8)
  assert.ok(published.includes("chart:FAIL:false"))
  assert.ok(published.includes("chart:TSLA:true"))
})
test("aborted owners never publish even when transports ignore cancellation; budget wait aborts promptly", async () => {
  const controller = new AbortController()
  let releases: (() => void)[] = [], published = 0, calls = 0
  const client = { async profile(symbol: string) { calls++; await new Promise<void>(resolve => releases.push(resolve)); return fixtureEnvelope(fixtureProfile(symbol)) } } as unknown as MarketClient
  const loading = loadMarketRows(client, ["NVDA", "MU", "TSLA", "AAPL"], controller.signal, false, () => published++)
  controller.abort(); releases.forEach(fn => fn()); await loading
  assert.equal(calls, 1); assert.equal(published, 0)
  const budget = new AbortController()
  const limited = { async profile() { return { ...fixtureEnvelope(null, "UNAVAILABLE"), reason: "REQUEST_BUDGET_EXHAUSTED" } } } as unknown as MarketClient
  const waiting = loadMarketRows(limited, ["NVDA"], budget.signal, false, () => published++)
  await new Promise(resolve => setImmediate(resolve)); budget.abort(); await waiting
  assert.equal(published, 0)
})
test("a throttled fundamentals feed cannot block the independent chart feed", async () => {
  const controller = new AbortController()
  let completed = 0, release!: () => void
  const allCharts = new Promise<void>(resolve => { release = resolve })
  const client = {
    async chart(symbol: string) { return fixtureEnvelope(fixtureChart(symbol)) },
    async profile() { return { ...fixtureEnvelope(null, "UNAVAILABLE"), reason: "REQUEST_BUDGET_EXHAUSTED" } },
  } as unknown as MarketClient
  const loading = loadMarketRows(client, ["NVDA", "MU", "TSLA"], controller.signal, true, (_symbol, kind, data) => {
    if (kind === "chart" && data && ++completed === 3) release()
  })
  await allCharts
  assert.equal(completed, 3)
  controller.abort()
  await loading
})
test("AUM is optional for old servers but malformed new values cannot pass validation", () => {
  const profile = fixtureProfile()
  assert.equal(parseProfile(profile, "NVDA", "https://fixture.invalid").aum, null)
  assert.equal(parseProfile({ ...profile, aum: "123.45", aumAsOf: "2026-09-16" }, "NVDA", "https://fixture.invalid").aum, "123.45")
  assert.throws(() => parseProfile({ ...profile, aum: "-1" }, "NVDA", "https://fixture.invalid"))
})
