// Trading limits: the contracts as the client reads them, checked against the server's own plugin (real Fastify
// injection) so the two cannot drift apart silently, plus the amount and reason rules the operator types against.
import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { stocksTradingLimitsPlugin } from "../../../../server/src/stocks-trading-limits/plugin"
import type { TradingLimitsPort } from "../../../../server/src/stocks-trading-limits/contracts"
import { StocksError } from "../../../../server/src/stocks/contracts"
import { StocksContractError } from "../stocks-admin/parse"
import { LIMITS_HISTORY_PATH, LIMITS_PATH, limitPath } from "./client"
import { LIM_DIGEST, LIM_PROFILE, LIM_WINDOW, limEvent, limRead, limRow, limState } from "./fixtures"
import {
  capInputText,
  capText,
  cashText,
  checkCapInput,
  checkReason,
  describeChange,
  describeEvent,
  limitStatus,
  parseLimitChange,
  parseLimitHistory,
  parseLimitsRead,
  usedShare,
} from "./parse"
import type { TradingLimitCommand, TradingLimitRow } from "./types"

const rejects = (name: string, run: () => unknown) => assert.throws(run, StocksContractError, name)
const command = (overrides: Partial<TradingLimitCommand> = {}): TradingLimitCommand => ({
  enabled: true,
  dailyCashLimit: "50000000000",
  expectedVersion: 0,
  idempotencyKey: "limit-key-0001",
  reason: "Reason for version 1",
  ...overrides,
})

test("read: the never-changed default is on with no cap; a changed row needs its time, operator and reason", () => {
  const read = parseLimitsRead(limRead())
  assert.deepEqual(read.window, LIM_WINDOW)
  assert.deepEqual(
    read.items.map((row) => [row.side, row.enabled, row.dailyCashLimit, row.version, row.usedToday]),
    [
      ["BUY", true, null, 0, "0"],
      ["SELL", true, null, 0, "0"],
    ],
  )
  const changed = parseLimitsRead(limRead([limRow("BUY", 3, { enabled: false, dailyCashLimit: "1" }, "12500000"), limRow("SELL", 1, { dailyCashLimit: "1".padEnd(31, "0") })]))
  assert.deepEqual([changed.items[0].enabled, changed.items[0].dailyCashLimit, changed.items[0].usedToday, changed.items[1].dailyCashLimit], [false, "1", "12500000", "1".padEnd(31, "0")])
  const sell = limRow("SELL")
  for (const [name, row] of [
    ["v0 turned off", limRow("BUY", 0, { enabled: false })],
    ["v0 with a cap", limRow("BUY", 0, { dailyCashLimit: "5" })],
    ["v0 with a reason", limRow("BUY", 0, { reason: "x" })],
    ["later without a time", limRow("BUY", 2, { updatedAt: null })],
    ["later with a loose time", limRow("BUY", 2, { updatedAt: "2026-09-26T01:02:00Z" })],
    ["later without an operator", limRow("BUY", 2, { operatorId: null })],
    ["untrimmed reason", limRow("BUY", 2, { reason: " padded " })],
    ["control character", limRow("BUY", 2, { reason: "line\nbreak" })],
    ["reason too long", limRow("BUY", 2, { reason: "x".repeat(501) })],
    ["zero cap", limRow("BUY", 2, { dailyCashLimit: "0" })],
    ["negative cap", limRow("BUY", 2, { dailyCashLimit: "-5" })],
    ["decimal cap", limRow("BUY", 2, { dailyCashLimit: "1.5" })],
    ["numeric cap", limRow("BUY", 2, { dailyCashLimit: 5 })],
    ["padded cap", limRow("BUY", 2, { dailyCashLimit: "05" })],
    ["cap above 10^30", limRow("BUY", 2, { dailyCashLimit: "1".padEnd(31, "0").replace(/0$/, "1") })],
    ["negative usage", limRow("BUY", 2, {}, "-1")],
    ["numeric usage", { ...limRow("BUY", 2), usedToday: 0 }],
    ["lower-case symbol", limRow("BUY", 0, { symbol: "nvda" })],
    ["unknown side", limRow("BUY", 0, { side: "HOLD" })],
    ["upper-case digest", limRow("BUY", 0, { deploymentDigest: LIM_DIGEST.toUpperCase() })],
    ["fractional version", limRow("BUY", 2.5)],
    ["extra field", { ...limRow("BUY"), idempotencyKey: "leak-0001" }],
    ["missing usage", limState("BUY")],
  ] as const)
    rejects(name, () => parseLimitsRead(limRead([row, sell])))
})

test("read: both sides of every symbol, once each, one deployment, one 24-hour KST day", () => {
  rejects("one side only", () => parseLimitsRead(limRead([limRow("BUY")])))
  rejects("duplicate side", () => parseLimitsRead(limRead([limRow("BUY"), limRow("BUY")])))
  rejects("no rows", () => parseLimitsRead(limRead([])))
  rejects("two deployments", () => parseLimitsRead(limRead([limRow("BUY"), limRow("SELL", 0, { deploymentDigest: "c".repeat(64) })])))
  rejects("a day of 25 hours", () => parseLimitsRead(limRead(undefined, { ...LIM_WINDOW, resetsAt: "2026-09-26T16:00:00.000Z" })))
  rejects("UTC day", () => parseLimitsRead(limRead(undefined, { ...LIM_WINDOW, timeZone: "UTC" })))
  rejects("loose start", () => parseLimitsRead(limRead(undefined, { ...LIM_WINDOW, start: "2026-09-25T15:00:00Z" })))
  rejects("extra window field", () => parseLimitsRead(limRead(undefined, { ...LIM_WINDOW, remaining: "1" })))
  rejects("extra data field", () => parseLimitsRead({ ...limRead(), cursor: null }))
})

test("history: newest first, one deployment, never more than asked", () => {
  const items = [limEvent("SELL", 2, { enabled: false, createdAt: "2026-09-26T02:00:00.000Z" }), limEvent("BUY", 1, { dailyCashLimit: "5000000" })]
  assert.deepEqual(parseLimitHistory({ items }).items.map((item) => [item.side, item.version]), [
    ["SELL", 2],
    ["BUY", 1],
  ])
  assert.deepEqual(parseLimitHistory({ items: [] }), { items: [] })
  rejects("oldest first", () => parseLimitHistory({ items: [...items].reverse() }))
  rejects("more than asked", () => parseLimitHistory({ items }, 1))
  rejects("two deployments", () => parseLimitHistory({ items: [items[0], { ...items[1], deploymentDigest: "c".repeat(64) }] }))
  rejects("version 0 event", () => parseLimitHistory({ items: [limEvent("BUY", 0)] }))
  rejects("bad id", () => parseLimitHistory({ items: [limEvent("BUY", 1, { id: "has space" })] }))
  rejects("idempotency key echoed", () => parseLimitHistory({ items: [{ ...limEvent("BUY", 1), idempotencyKey: "limit-key-0001" }] }))
  rejects("previous cap zero", () => parseLimitHistory({ items: [limEvent("BUY", 1, { previousDailyCashLimit: "0" })] }))
})

test("change: the event must be this command's for the same stock and side; the state may be later (replay)", () => {
  const sent = command()
  const event = limEvent("BUY", 1, { dailyCashLimit: sent.dailyCashLimit, reason: sent.reason })
  const state = limState("BUY", 1, { dailyCashLimit: sent.dailyCashLimit, reason: sent.reason, updatedAt: event.createdAt })
  const fresh = parseLimitChange({ state, change: event, replayed: false }, { symbol: "NVDA", side: "BUY", command: sent })
  assert.deepEqual([fresh.state.version, fresh.change.version, fresh.replayed], [1, 1, false])
  const later = limState("BUY", 2, { enabled: false })
  assert.equal(parseLimitChange({ state: later, change: event, replayed: true }, { symbol: "NVDA", side: "BUY", command: sent }).state.enabled, false)
  const target = { symbol: "NVDA", side: "BUY" as const, command: sent }
  rejects("other side", () => parseLimitChange({ state, change: event, replayed: false }, { ...target, side: "SELL" }))
  rejects("other expected version", () => parseLimitChange({ state, change: event, replayed: false }, { ...target, command: command({ expectedVersion: 1 }) }))
  rejects("other cap", () => parseLimitChange({ state, change: event, replayed: false }, { ...target, command: command({ dailyCashLimit: null }) }))
  rejects("other on/off", () => parseLimitChange({ state, change: event, replayed: false }, { ...target, command: command({ enabled: false }) }))
  rejects("other reason", () => parseLimitChange({ state, change: event, replayed: false }, { ...target, command: command({ reason: "Other" }) }))
  rejects("state older than the event", () => parseLimitChange({ state: limState("BUY"), change: event, replayed: false }, target))
  rejects("same version, other operator", () => parseLimitChange({ state: { ...state, operatorId: "someone-else" }, change: event, replayed: false }, target))
  rejects("same version, other time", () => parseLimitChange({ state: { ...state, updatedAt: "2026-09-26T02:59:00.000Z" }, change: event, replayed: false }, target))
  rejects("other deployment", () => parseLimitChange({ state, change: { ...event, deploymentDigest: "c".repeat(64) }, replayed: false }, target))
  rejects("replayed not boolean", () => parseLimitChange({ state, change: event, replayed: "no" }, target))
  rejects("usage in a change", () => parseLimitChange({ state: { ...state, usedToday: "0" }, change: event, replayed: false }, target))
})

test("cap input: whole tUSDC with up to 6 decimals, grouped or plain; zero and garbage are refused", () => {
  for (const [input, base] of [
    ["50000", "50000000000"],
    ["50,000", "50000000000"],
    [" 1,250,000.5 ", "1250000500000"],
    ["0.000001", "1"],
    ["1250.123456", "1250123456"],
    ["007", "7000000"],
    ["1".padEnd(25, "0"), "1".padEnd(31, "0")],
  ] as const) {
    const check = checkCapInput(input)
    assert.deepEqual(check, { ok: true, baseUnits: base }, input)
  }
  for (const input of ["", "   ", "0", "0.0000001", "0.000000", "1.2345678", "-5", "5e3", "50 000", "50,00", "5,0000", "1.", ".5", "１２", "0x10", "1".padEnd(26, "0")]) {
    assert.equal(checkCapInput(input).ok, false, input)
  }
  assert.match((checkCapInput("0") as { message: string }).message, /turn it off/)
  for (const base of ["1", "50000000000", "1250000500000", "1".padEnd(31, "0")]) assert.deepEqual(checkCapInput(capInputText(base)), { ok: true, baseUnits: base }, base)
  assert.equal(capInputText("1250000500000"), "1250000.5")
  assert.equal(capInputText("1"), "0.000001")
  assert.equal(capText(null), "No cap")
  assert.equal(capText("50000000000"), "50,000 tUSDC")
  assert.equal(cashText("12500000"), "12.5 tUSDC")
})

test("status, share and change wording follow the server's rule: at the cap even the smallest order is refused", () => {
  const row = (enabled: boolean, cap: string | null, used: string) => ({ ...(limRow("BUY", 1, { enabled, dailyCashLimit: cap }, used) as unknown as TradingLimitRow) })
  assert.equal(limitStatus(row(false, null, "0")), "off")
  assert.equal(limitStatus(row(false, "5", "9")), "off")
  assert.equal(limitStatus(row(true, null, "999999999")), "on")
  assert.equal(limitStatus(row(true, "100", "99")), "on")
  assert.equal(limitStatus(row(true, "100", "100")), "cap_reached")
  assert.equal(limitStatus(row(true, "100", "150")), "cap_reached")
  assert.equal(usedShare("12345", "50000"), "24.6%")
  assert.equal(usedShare("0", "50000"), "0.0%")
  assert.equal(usedShare("75000", "50000"), "150.0%")
  assert.equal(describeChange({ enabled: true, dailyCashLimit: null }, { enabled: false, dailyCashLimit: "50000000000" }), "On → Off · Cap No cap → 50,000 tUSDC")
  assert.equal(describeChange({ enabled: true, dailyCashLimit: null }, { enabled: true, dailyCashLimit: null }), "Saved again without a change (On · No cap)")
  assert.equal(describeEvent(parseLimitHistory({ items: [limEvent("SELL", 3, { previousEnabled: false, enabled: true })] }).items[0]), "Off → On")
})

test("reason: required, trimmed, one line, at most 500 characters", () => {
  assert.deepEqual(checkReason("  Cap buys for the launch  "), { ok: true, reason: "Cap buys for the launch" })
  for (const bad of ["", "   ", "line\nbreak", "tab\there", "x".repeat(501), "lone \uD800 surrogate"]) assert.equal(checkReason(bad).ok, false, JSON.stringify(bad))
  assert.equal(checkReason("x".repeat(500)).ok, true)
  assert.equal(checkReason("😀 drill").ok, true)
})

// ---------------------------------------------------------------- parity with the real server plugin

const control = { operatorId: "ops-limits-a", permissions: ["stocks:read", "stocks:control"] }

async function limitsServer(service: Partial<TradingLimitsPort>) {
  const app = Fastify({ logger: false })
  const port: TradingLimitsPort = {
    symbols: ["NVDA"],
    read: async () => limRead() as never,
    change: async () => ({}) as never,
    history: async () => ({ items: [] }),
    ...service,
  }
  await app.register(stocksTradingLimitsPlugin, { service: port, resolveOperator: async () => control })
  await app.ready()
  return app
}

test("parity: whatever the real limits plugin returns, the client parses to the same values", async () => {
  for (const read of [limRead(), limRead([limRow("BUY", 4, { enabled: false, dailyCashLimit: "50000000000", reason: "😀 launch cap" }, "49999999999"), limRow("SELL", 1, {}, "7")])]) {
    const app = await limitsServer({ read: async () => read as never })
    const response = await app.inject({ method: "GET", url: LIMITS_PATH })
    assert.equal(response.statusCode, 200, response.body)
    const body = JSON.parse(response.body)
    assert.deepEqual(Object.keys(body).sort(), [...Object.keys(LIM_PROFILE), "data", "observedAt"].sort())
    assert.deepEqual(parseLimitsRead(body.data), read)
    await app.close()
  }
  // The client's own PUT body passes the server's input checks and its answer parses back.
  for (const [sent, replayedState] of [
    [command(), null],
    [command({ enabled: false, dailyCashLimit: null, expectedVersion: 6, idempotencyKey: "limit-key-0002" }), limState("SELL", 9)],
  ] as const) {
    const side = replayedState ? "SELL" : "BUY"
    let seen: unknown = null
    const app = await limitsServer({
      change: async (operator, symbol, sideArg, input) => {
        seen = { operator, symbol, side: sideArg, input }
        const change = limEvent(sideArg, input.expectedVersion + 1, { enabled: input.enabled, dailyCashLimit: input.dailyCashLimit, reason: input.reason })
        const state = replayedState ?? limState(sideArg, change.version, { enabled: input.enabled, dailyCashLimit: input.dailyCashLimit, reason: input.reason, updatedAt: change.createdAt })
        return { state, change, replayed: replayedState !== null } as never
      },
    })
    const response = await app.inject({ method: "PUT", url: limitPath("NVDA", side), payload: JSON.stringify(sent), headers: { "content-type": "application/json" } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(seen, { operator: control, symbol: "NVDA", side, input: sent })
    const parsed = parseLimitChange(JSON.parse(response.body).data, { symbol: "NVDA", side, command: sent })
    assert.equal(parsed.replayed, replayedState !== null)
    await app.close()
  }
  const items = [limEvent("SELL", 2, { createdAt: "2026-09-26T02:00:00.000Z" }), limEvent("BUY", 1)]
  const app = await limitsServer({ history: async (limit) => ({ items: items.slice(0, limit) }) as never })
  const history = await app.inject({ method: "GET", url: LIMITS_HISTORY_PATH })
  assert.equal(history.statusCode, 200, history.body)
  assert.deepEqual(parseLimitHistory(JSON.parse(history.body).data), { items })
  await app.close()
  // Error envelopes carry the fixed code the client classifies.
  const conflict = await limitsServer({ change: async () => { throw new StocksError("LIMIT_VERSION_CONFLICT", 409) } })
  const refused = await conflict.inject({ method: "PUT", url: limitPath("NVDA", "BUY"), payload: command() })
  assert.equal(refused.statusCode, 409)
  assert.equal(JSON.parse(refused.body).error, "LIMIT_VERSION_CONFLICT")
  await conflict.close()
})
