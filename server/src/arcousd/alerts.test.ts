import assert from "node:assert/strict"
import test from "node:test"
import { HttpRequestError } from "viem"
import type { QueueAssetSummary } from "./admin.js"
import { parseArcoUSDAlertEnv, type ArcoUSDAlertEnv } from "./alert-config.js"
import {
  applyDelivery,
  ArcoUSDAlertsAdmin,
  formatDigest,
  inertArcoUSDAlerts,
  PrismaArcoUSDAlertStore,
  resolvedUnsent,
  stepAlerts,
  WATCHER_HEARTBEAT,
  type AlertRecord,
  type ArcoUSDAlertStore,
  type Heartbeat,
  type Notice,
} from "./alerts.js"
import { parseArcoUSDEnv } from "./config.js"
import { deliver, slackChannel, telegramChannel, type AlertChannel } from "./notify.js"
import { NO_PAUSES, type AssetState, type ReserveState, type StrategyState } from "./reader.js"
import type { RecallView } from "./recall.js"
import type { ArcoUSDRegistryFile } from "./registry.js"
import { safeErrorText } from "./safe-error.js"
import type { SavingsState } from "./savings.js"
import { evaluateWatch, SAVINGS_NO_YIELD_MS, SAVINGS_OVERDUE_MS, type Finding, type SavingsSeen, type WatchInput } from "./watch.js"
import { ArcoUSDWatcher } from "./watcher.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const RESERVE = A(0xabc)
const USDC = A(0xc1)
const USDT = A(0xc2)
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.parse("2026-10-19T12:00:00.000Z")
const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n
const e6 = (n: number) => BigInt(Math.round(n * 1e6))
const TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz0123456"
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX"

function registry(overrides: Partial<ArcoUSDRegistryFile> = {}): ArcoUSDRegistryFile {
  return {
    schemaVersion: 1,
    chainId: 91342,
    network: "giwa-sepolia",
    deployed: true,
    deploymentBlock: 100,
    arcoUSD: { proxy: A(1), implementation: A(2), bytecodeHash: null },
    reserve: { proxy: RESERVE, implementation: A(4), bytecodeHash: null },
    lens: { address: A(5), bytecodeHash: null },
    testAssets: [],
    reserveAssets: [
      { symbol: "tUSDC", address: USDC, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 0 },
      { symbol: "tUSDT", address: USDT, decimals: 6, minQueued: "1000000", instantFeeBps: 0, swapFeeBps: 10 },
    ],
    strategies: [],
    params: { mintCap: "1", mmfTargetBps: 5000, bufferFloorBps: 3000, queueMinDelay: 600 },
    ...overrides,
  }
}

function asset(over: Partial<AssetState> = {}): AssetState {
  return {
    symbol: "tUSDC",
    address: USDC,
    decimals: 6,
    depositEnabled: true,
    redeemEnabled: true,
    instantFeeBps: 0,
    swapFeeBps: 0,
    balance: e6(5_000).toString(),
    queued: "0",
    available: e6(5_000).toString(),
    balanceHuman: "5000",
    queuedHuman: "0",
    availableHuman: "5000",
    queueLength: 0,
    queueHead: 0,
    queueBacklog: 0,
    ...over,
  }
}

function strategy(over: Partial<StrategyState> = {}): StrategyState {
  return {
    strategyId: 1,
    productId: "umint",
    asset: USDC,
    productToken: A(0x77),
    enabled: true,
    shares: "0",
    value: "0",
    valueUsd: "0",
    navOk: true,
    pendingRecall: "0",
    maxAllocation: e18(1_000_000).toString(),
    ...over,
  }
}

function reserve(over: Partial<ReserveState> = {}): ReserveState {
  return {
    blockNumber: "1000",
    totalBacking: e18(10_000).toString(),
    totalLiabilities: e18(9_990).toString(),
    totalBackingUsd: "10000",
    totalLiabilitiesUsd: "9990",
    surplus: e18(10).toString(),
    navOk: true,
    mmfBps: 0,
    mmfTargetBps: 5000,
    bufferFloorBps: 3000,
    queueMinDelay: 600,
    mintCap: e18(1_000_000).toString(),
    ...NO_PAUSES,
    assets: [asset()],
    strategies: [],
    ...over,
  }
}

function summary(over: Partial<QueueAssetSummary> = {}): QueueAssetSummary {
  return {
    symbol: "tUSDC",
    asset: USDC,
    decimals: 6,
    queuedCount: 0,
    queuedAmount: "0",
    queuedAmountHuman: "0",
    overdueCount: 0,
    failedCount: 0,
    oldestRequestedAt: null,
    head: null,
    ...over,
  }
}

/** One QUEUED request of `amount` tUSDC, requested `ageMs` ago, eligible after 10 minutes. */
function queuedOne(amount: number, ageMs: number, over: Partial<QueueAssetSummary> = {}): QueueAssetSummary {
  const requestedAt = NOW - ageMs
  return summary({
    queuedCount: 1,
    queuedAmount: e6(amount).toString(),
    queuedAmountHuman: String(amount),
    oldestRequestedAt: new Date(requestedAt).toISOString(),
    head: { requestId: "7", assetAmount: e6(amount).toString(), assetAmountHuman: String(amount), eligibleAt: new Date(requestedAt + 10 * MIN).toISOString() },
    ...over,
  })
}

function input(over: Partial<WatchInput> = {}): WatchInput {
  return {
    now: NOW,
    stalledMs: 30 * MIN,
    indexerLagBlocks: 600,
    snapshotIntervalMs: 5 * MIN,
    state: reserve(),
    stateError: null,
    gate: null,
    pinnedToIndexer: true,
    queue: [summary()],
    queueError: null,
    indexer: { lagBlocks: 2 },
    lastSnapshotAt: new Date(NOW - MIN),
    recalls: [],
    ...over,
  }
}

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1]
const keys = (findings: readonly Finding[]) => findings.map((finding) => finding.key).sort()
const find = (findings: readonly Finding[], key: string) => {
  const found = findings.find((finding) => finding.key === key)
  assert.ok(found, `no finding ${key} in ${keys(findings).join(", ")}`)
  return found
}

// ─────────────────────────────── settings ───────────────────────────────

test("alert settings: defaults, bounds, and channel credentials that are never echoed", () => {
  const defaults = parseArcoUSDAlertEnv({})
  assert.deepEqual(
    [defaults.intervalMs, defaults.repeatCriticalMs, defaults.repeatWarningMs, defaults.stalledMs, defaults.indexerLagBlocks],
    [60_000, 60 * MIN, 360 * MIN, 30 * MIN, 600],
  )
  assert.deepEqual([defaults.telegram, defaults.slack, defaults.consoleUrl, defaults.invalid], [null, null, null, []])

  const set = parseArcoUSDAlertEnv({
    ARCOUSD_ALERT_INTERVAL_MS: "120000",
    ARCOUSD_ALERT_REPEAT_CRITICAL_MIN: "30",
    ARCOUSD_ALERT_STALLED_MIN: "15",
    ARCOUSD_ALERT_CONSOLE_URL: "https://admin.arco.financial/vaults/arcousd",
    ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN: TOKEN,
    ARCOUSD_ALERT_TELEGRAM_CHAT_ID: "-1001234567890",
    ARCOUSD_ALERT_SLACK_WEBHOOK_URL: WEBHOOK,
  })
  assert.deepEqual([set.intervalMs, set.repeatCriticalMs, set.stalledMs], [120_000, 30 * MIN, 15 * MIN])
  assert.deepEqual(set.telegram, { botToken: TOKEN, chatId: "-1001234567890" })
  assert.deepEqual(set.slack, { webhookUrl: WEBHOOK })
  assert.equal(set.consoleUrl, "https://admin.arco.financial/vaults/arcousd")
  assert.deepEqual(set.invalid, [])

  // Bad values fall back; only the KEYS are reported. Telegram needs both halves.
  const bad = parseArcoUSDAlertEnv({
    ARCOUSD_ALERT_INTERVAL_MS: "1000",
    ARCOUSD_ALERT_REPEAT_WARNING_MIN: "soon",
    ARCOUSD_ALERT_CONSOLE_URL: "http://admin.arco.financial",
    ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN: TOKEN,
    ARCOUSD_ALERT_SLACK_WEBHOOK_URL: "https://example.com/hook",
  })
  assert.equal(bad.intervalMs, 60_000)
  assert.equal(bad.repeatWarningMs, 360 * MIN)
  assert.deepEqual([bad.telegram, bad.slack, bad.consoleUrl], [null, null, null])
  assert.deepEqual([...bad.invalid].sort(), [
    "ARCOUSD_ALERT_CONSOLE_URL",
    "ARCOUSD_ALERT_INTERVAL_MS",
    "ARCOUSD_ALERT_REPEAT_WARNING_MIN",
    "ARCOUSD_ALERT_SLACK_WEBHOOK_URL",
    "ARCOUSD_ALERT_TELEGRAM_CHAT_ID",
  ])
  assert.ok(!JSON.stringify(bad).includes("example.com"))
  // A whitespace-only value is unset, not invalid.
  assert.deepEqual(parseArcoUSDAlertEnv({ ARCOUSD_ALERT_SLACK_WEBHOOK_URL: "  " }).invalid, [])
})

// ─────────────────────────────── rules ───────────────────────────────

test("rules: a healthy reserve and an empty queue raise nothing", () => {
  assert.deepEqual(evaluateWatch(input()), [])
})

test("rules: unreadable reserve, NAV down, and under-backing", () => {
  const unread = evaluateWatch(input({ state: null, stateError: "RPC timeout" }))
  const read = find(unread, "reserve:read-failed")
  assert.equal(read.severity, "CRITICAL")
  assert.match(read.detail, /RPC timeout/)
  assert.equal(read.sustainMs, 5 * MIN)

  const short = find(evaluateWatch(input({ state: reserve({ totalBacking: e18(9_000).toString(), totalLiabilities: e18(9_500).toString() }) })), "reserve:under-backed")
  assert.equal(short.severity, "CRITICAL")
  assert.match(short.detail, /Backing \$9,000 is below ArcoUSD supply \$9,500 \(short \$500\)/)

  // With the NAV down the gap says nothing (MMF counted as 0): only the NAV alert.
  const nav = evaluateWatch(input({ state: reserve({ navOk: false, totalBacking: "0" }) }))
  assert.deepEqual(keys(nav), ["reserve:nav"])
})

test("rules: the queue reconciles against the chain only at the indexer's block", () => {
  const chain = asset({ queued: e6(150).toString(), queueBacklog: 1, queueLength: 3, queueHead: 2 })
  const indexed = queuedOne(100, 20 * MIN)
  const mismatch = find(evaluateWatch(input({ state: reserve({ assets: [chain] }), queue: [indexed] })), "reconcile:tUSDC")
  assert.equal(mismatch.severity, "CRITICAL")
  assert.match(mismatch.detail, /At block 1000 the Reserve owes 150 tUSDC to queued requests, the indexer has 100 \(difference 50\)/)

  // Read at the head (indexer behind) or from a truncated summary: no comparison at all.
  assert.ok(!keys(evaluateWatch(input({ state: reserve({ assets: [chain] }), queue: [indexed], pinnedToIndexer: false }))).includes("reconcile:tUSDC"))
  assert.ok(!keys(evaluateWatch(input({ state: reserve({ assets: [chain] }), queue: [indexed], queueTruncated: true }))).includes("reconcile:tUSDC"))

  // Same amount, but more QUEUED rows than the Reserve has left in front of its head.
  const tooMany = asset({ queued: e6(100).toString(), queueBacklog: 0 })
  assert.match(find(evaluateWatch(input({ state: reserve({ assets: [tooMany] }), queue: [indexed] })), "reconcile:tUSDC").detail, /1 queued requests but only 0/)

  // Matching amount and count: in sync.
  const synced = asset({ queued: e6(100).toString(), queueBacklog: 2 })
  assert.ok(!keys(evaluateWatch(input({ state: reserve({ assets: [synced] }), queue: [indexed] }))).includes("reconcile:tUSDC"))
})

test("rules: T+2 overdue is critical, 36h+ is a warning, failed payouts are listed", () => {
  const synced = (amount: number) => reserve({ assets: [asset({ queued: e6(amount).toString(), queueBacklog: 1, balance: "0" })] })
  const overdue = evaluateWatch(input({ state: synced(10), queue: [queuedOne(10, 49 * HOUR, { overdueCount: 1 })] }))
  const late = find(overdue, "queue:tUSDC:overdue")
  assert.equal(late.severity, "CRITICAL")
  assert.equal(late.title, "1 redemption past T+2 (tUSDC)")
  assert.match(late.detail, /request #7, has waited 2d 1h/)
  assert.equal(late.fingerprint, "1") // one more overdue request re-notifies
  assert.ok(!keys(overdue).includes("queue:tUSDC:aging"))

  const aging = find(evaluateWatch(input({ state: synced(10), queue: [queuedOne(10, 37 * HOUR)] })), "queue:tUSDC:aging")
  assert.equal(aging.severity, "WARNING")
  assert.match(aging.detail, /waited 1d 13h; T\+2 is reached in 11h/)

  const failed = find(evaluateWatch(input({ queue: [summary({ failedCount: 2 })] })), "queue:tUSDC:payout-failed")
  assert.equal(failed.title, "2 payouts failed (tUSDC)")
  assert.equal(failed.fingerprint, "2")
})

test("rules: an eligible head is 'not processed' with liquidity, 'short' without, silent while payouts are paused", () => {
  const head = queuedOne(100, 20 * MIN)
  const withCash = reserve({ assets: [asset({ balance: e6(500).toString(), queued: e6(100).toString(), queueBacklog: 1 })] })
  const stalled = find(evaluateWatch(input({ state: withCash, queue: [head] })), "queue:tUSDC:stalled")
  assert.equal(stalled.sustainMs, 30 * MIN)
  assert.match(stalled.detail, /Request #7 \(100 tUSDC\) can be paid now/)

  // Still inside queueMinDelay: nothing yet.
  assert.deepEqual(keys(evaluateWatch(input({ state: withCash, queue: [queuedOne(100, 5 * MIN)] }))), [])

  // Short of cash: names the MMF strategy that could be recalled (operator approval).
  const short = reserve({
    assets: [asset({ balance: e6(40).toString(), queued: e6(100).toString(), queueBacklog: 1 })],
    strategies: [strategy({ value: e18(5_000).toString() }), strategy({ strategyId: 2, productId: "ibenji", asset: USDT, value: e18(9).toString() })],
  })
  const liquidity = find(evaluateWatch(input({ state: short, queue: [head] })), "queue:tUSDC:liquidity")
  assert.match(liquidity.detail, /needs 100 tUSDC; the Reserve holds 40 \(short 60\)\. Recall from strategy #1 umint \(\$5,000\) with operator approval\./)
  const noSource = find(evaluateWatch(input({ state: reserve({ assets: short.assets }), queue: [head] })), "queue:tUSDC:liquidity")
  assert.match(noSource.detail, /No MMF strategy holds this asset/)

  // processQueue paused (its own switch, the Reserve, or ArcoUSD burn): only the pause alert speaks.
  for (const flag of ["queuePaused", "reservePaused", "arcoUSDPaused", "arcoUSDBurnPaused"] as const) {
    const paused = evaluateWatch(input({ state: { ...withCash, [flag]: true }, queue: [head] }))
    assert.ok(!keys(paused).some((key) => key.endsWith(":stalled") || key.endsWith(":liquidity")), flag)
    assert.ok(keys(paused).includes("pauses"), flag)
  }
})

test("rules: gate, mint cap, MMF band, pauses, indexer and snapshot freshness", () => {
  const gate = find(
    evaluateWatch(input({ gate: { status: "closed", reason: "insufficient-buffer", asset: "tUSDC", available: "500", threshold: "1000", checkedAt: "" } })),
    "gate:closed",
  )
  assert.match(gate.detail, /settlement buffer is below the threshold\. tUSDC buffer 500, threshold 1,000\./)
  assert.equal(gate.fingerprint, "insufficient-buffer")
  assert.ok(!keys(evaluateWatch(input({ gate: { status: "open", reason: null, asset: "tUSDC", available: "5000", threshold: "1000", checkedAt: "" } }))).includes("gate:closed"))

  const capped = find(evaluateWatch(input({ state: reserve({ mintCap: e18(10_000).toString(), totalLiabilities: e18(9_500).toString(), totalBacking: e18(9_600).toString() }) })), "reserve:mint-cap")
  assert.match(capped.detail, /\$500 of the \$10,000 mint cap is left/)

  // MMF at 0% before any allocation is not drift; once invested, 30% vs 50% is.
  assert.ok(!keys(evaluateWatch(input({ state: reserve({ mmfBps: 0 }) }))).includes("reserve:mmf-band"))
  const band = find(evaluateWatch(input({ state: reserve({ mmfBps: 3000, strategies: [strategy({ value: e18(3_000).toString() })] }) })), "reserve:mmf-band")
  assert.match(band.detail, /MMF is 30% of backing against a 50% target \(band ±10%\)/)
  assert.equal(band.sustainMs, 60 * MIN)
  assert.ok(!keys(evaluateWatch(input({ state: reserve({ mmfBps: 4500, strategies: [strategy({ value: e18(4_500).toString() })] }) }))).includes("reserve:mmf-band"))

  const pauses = find(evaluateWatch(input({ state: reserve({ settlementPaused: true, routerPaused: true }) })), "pauses")
  assert.equal(pauses.title, "Paused: Reserve settleFor, Router buy")
  assert.equal(pauses.fingerprint, "settlementPaused,routerPaused")

  assert.match(find(evaluateWatch(input({ indexer: { lagBlocks: 1_200 } })), "indexer:lag").detail, /1,200 blocks behind/)
  assert.match(find(evaluateWatch(input({ lastSnapshotAt: new Date(NOW - 47 * MIN) })), "indexer:snapshots").detail, /47m old \(expected every 5m\)/)
})

test("rules: Reserve recalls that wait on an operator", () => {
  const recall = (over: Partial<RecallView>): RecallView => ({
    productId: "umint",
    requestId: "3",
    strategyId: 1,
    status: "SETTLED",
    state: "requested",
    action: null,
    pending: "0",
    open: true,
    lockedAssetsOut: "0",
    settledTxHash: null,
    createdAt: null,
    warning: null,
    error: null,
    ...over,
  })
  const found = evaluateWatch(
    input({ recalls: [recall({ state: "awaiting-acknowledgement" }), recall({ requestId: "4", state: "claimable" }), recall({ requestId: "5", warning: "Paid twice?" })] }),
  )
  assert.deepEqual(keys(found), ["recall:umint:3:acknowledge", "recall:umint:4:claim", "recall:umint:5:warning"])
  assert.match(find(found, "recall:umint:3:acknowledge").detail, /counts it twice until a reserve manager signs acknowledgeRecallPaid/)
})

// ─────────────────────────────── alert book ───────────────────────────────

const finding = (over: Partial<Finding> = {}): Finding => ({
  key: "reserve:under-backed",
  severity: "CRITICAL",
  title: "Reserve under-backed",
  detail: "short $5",
  sustainMs: 0,
  fingerprint: "",
  ...over,
})

const step = (
  active: AlertRecord[],
  findings: Finding[],
  at: number,
  over: { notify?: boolean; unknown?: (key: string) => boolean; quiet?: (key: string) => boolean; maxGapMs?: number } = {},
) =>
  stepAlerts({
    active,
    findings,
    now: new Date(at),
    repeatCriticalMs: HOUR,
    repeatWarningMs: 6 * HOUR,
    notify: over.notify ?? true,
    unknown: over.unknown,
    quiet: over.quiet,
    maxGapMs: over.maxGapMs,
  })

const delivered = { telegram: { ok: true, at: "" } }
const failedEverywhere = { telegram: { ok: false, at: "", error: "Telegram answered 401: Unauthorized" } }

test("alert book: sustain, open, repeat, change and resolve", () => {
  // Sustained conditions wait as PENDING and say nothing.
  let round = step([], [finding({ sustainMs: 5 * MIN })], NOW)
  assert.deepEqual([round.records[0].status, round.notices.length], ["PENDING", 0])
  round = step(round.records, [finding({ sustainMs: 5 * MIN })], NOW + 4 * MIN)
  assert.deepEqual([round.records[0].status, round.notices.length], ["PENDING", 0])
  round = step(round.records, [finding({ sustainMs: 5 * MIN })], NOW + 5 * MIN)
  assert.deepEqual([round.records[0].status, round.notices.map((n) => n.kind)], ["OPEN", ["opened"]])
  applyDelivery(round.notices, delivered, new Date(NOW + 5 * MIN))
  assert.equal(round.records[0].notifyCount, 1)

  // Open: quiet until the repeat interval, then "repeat"; a fingerprint change is sent at once.
  let open = step(round.records, [finding()], NOW + 30 * MIN)
  assert.equal(open.notices.length, 0)
  open = step(open.records, [finding()], NOW + 5 * MIN + HOUR)
  assert.deepEqual(open.notices.map((n) => n.kind), ["repeat"])
  applyDelivery(open.notices, delivered, new Date(NOW + 5 * MIN + HOUR))
  const changed = step(open.records, [finding({ fingerprint: "2" })], NOW + 2 * HOUR)
  assert.deepEqual(changed.notices.map((n) => n.kind), ["updated"])
  applyDelivery(changed.notices, delivered, new Date(NOW + 2 * HOUR))
  assert.equal(changed.records[0].fingerprint, "2")

  // Cleared: RESOLVED, with a "resolved" message because the opening was sent.
  const cleared = step(changed.records, [], NOW + 3 * HOUR)
  assert.deepEqual([cleared.records[0].status, cleared.notices.map((n) => n.kind)], ["RESOLVED", ["resolved"]])

  // A blip that never opened resolves silently.
  const blip = step(step([], [finding({ sustainMs: 5 * MIN })], NOW).records, [], NOW + MIN)
  assert.deepEqual([blip.records[0].status, blip.notices.length], ["RESOLVED", 0])
})

test("alert book: unseen is not cleared, failed sends retry, and no channel means no queue", () => {
  const opened = step([], [finding()], NOW)
  applyDelivery(opened.notices, delivered, new Date(NOW))
  // The reserve could not be read this round: its alerts stay exactly as they were.
  const unknown = step(opened.records, [], NOW + MIN, { unknown: (key) => key.startsWith("reserve:") })
  assert.deepEqual([unknown.records.length, unknown.notices.length], [0, 0])

  // Every channel failed: the row stays unmarked and the next round sends "opened" again.
  const first = step([], [finding({ key: "pauses", severity: "WARNING" })], NOW)
  applyDelivery(first.notices, failedEverywhere, new Date(NOW))
  assert.deepEqual([first.records[0].lastNotifiedAt, first.records[0].delivery], [null, failedEverywhere])
  const retry = step(first.records, [finding({ key: "pauses", severity: "WARNING" })], NOW + MIN)
  assert.deepEqual(retry.notices.map((n) => n.kind), ["opened"])

  // No channel configured: rows move, nothing is queued — until a channel exists.
  const silent = step([], [finding()], NOW, { notify: false })
  assert.deepEqual([silent.records[0].status, silent.notices.length], ["OPEN", 0])
  assert.equal(step(silent.records, [finding()], NOW + MIN, { notify: false }).notices.length, 0)
  assert.deepEqual(step(silent.records, [finding()], NOW + MIN).notices.map((n) => n.kind), ["opened"])
})

test("digest: critical, then warning, then resolved; console link; long rounds are cut", () => {
  const record = (key: string, severity: "CRITICAL" | "WARNING", title: string): AlertRecord => ({
    key, severity, status: "OPEN", title, detail: `${title} detail`, fingerprint: "", firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW),
    openedAt: new Date(NOW - 2 * HOUR), resolvedAt: null, lastNotifiedAt: null, notifyCount: 0, delivery: null,
  })
  const notices: Notice[] = [
    { kind: "resolved", record: { ...record("gate:closed", "WARNING", "Fund buys blocked"), status: "RESOLVED" }, fingerprint: "" },
    { kind: "opened", record: record("pauses", "WARNING", "Paused: Router buy"), fingerprint: "" },
    { kind: "repeat", record: record("reserve:nav", "CRITICAL", "MMF NAV unavailable"), fingerprint: "" },
  ]
  const text = formatDigest(notices, { network: "GIWA Sepolia", consoleUrl: "https://admin.arco.financial/vaults/arcousd", now: new Date(NOW) })
  assert.equal(
    text,
    [
      "ArcoUSD alerts · GIWA Sepolia\n1 critical · 1 warning · 1 resolved",
      "🔴 CRITICAL (open 2h) · MMF NAV unavailable\nMMF NAV unavailable detail",
      "🟠 WARNING · Paused: Router buy\nPaused: Router buy detail",
      "✅ RESOLVED · Fund buys blocked after 2h",
    ].join("\n\n") + "\nConsole: https://admin.arco.financial/vaults/arcousd",
  )
  const many = Array.from({ length: 80 }, (_, i): Notice => ({ kind: "opened", record: record(`k${i}`, "WARNING", `Alert number ${i} with a fairly long title`), fingerprint: "" }))
  const cut = formatDigest(many, { network: "GIWA Sepolia", consoleUrl: null, now: new Date(NOW) })
  assert.ok(cut.length <= 3_800)
  assert.match(cut, /…and \d+ more in the console\.$/)
})

// ─────────────────────────────── channels ───────────────────────────────

type Call = { url: string; body: Record<string, unknown> }
function fakeFetch(respond: (call: Call) => { status: number; body: string } | Promise<never>) {
  const calls: Call[] = []
  const impl = async (url: string, init: { body: string }) => {
    const call = { url, body: JSON.parse(init.body) as Record<string, unknown> }
    calls.push(call)
    const answer = await respond(call)
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => answer.body }
  }
  return { calls, impl }
}

test("channels: Telegram and Slack payloads, and errors that never quote the credentials", async () => {
  const tg = fakeFetch(() => ({ status: 200, body: JSON.stringify({ ok: true }) }))
  await telegramChannel({ botToken: TOKEN, chatId: "-100" }, tg.impl).send("hello", AbortSignal.timeout(1000))
  assert.equal(tg.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.deepEqual(tg.calls[0].body, { chat_id: "-100", text: "hello", disable_web_page_preview: true })

  const slack = fakeFetch(() => ({ status: 200, body: "ok" }))
  await slackChannel({ webhookUrl: WEBHOOK }, slack.impl).send("hello", AbortSignal.timeout(1000))
  assert.deepEqual([slack.calls[0].url, slack.calls[0].body], [WEBHOOK, { text: "hello" }])

  const refused = fakeFetch(() => ({ status: 401, body: JSON.stringify({ ok: false, description: `Unauthorized ${TOKEN}` }) }))
  const broken = fakeFetch(() => Promise.reject(new Error(`connect ECONNREFUSED ${WEBHOOK}`)))
  const result = await deliver(
    [telegramChannel({ botToken: TOKEN, chatId: "-100" }, refused.impl), slackChannel({ webhookUrl: WEBHOOK }, broken.impl)],
    "hello",
  )
  assert.deepEqual([result.telegram?.ok, result.slack?.ok], [false, false])
  assert.equal(result.telegram?.error, "Telegram answered 401: Unauthorized [token]")
  assert.equal(result.slack?.error, "could not connect")
  assert.ok(!JSON.stringify(result).includes(TOKEN) && !JSON.stringify(result).includes("XXXXXXXX"))
})

test("channels: one failing or hanging channel never stops the other", async () => {
  const ok: AlertChannel = { id: "slack", send: async () => undefined }
  const hangs: AlertChannel = {
    id: "telegram",
    send: (_text, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))),
  }
  const started = Date.now()
  const result = await deliver([hangs, ok], "x".repeat(5_000), Date.now, 50)
  assert.ok(Date.now() - started < 2_000)
  assert.equal(result.telegram?.error, "timed out")
  assert.deepEqual([result.slack?.ok, result.telegram?.ok], [true, false])
})

// ─────────────────────────────── watcher ───────────────────────────────

class MemoryAlertStore implements ArcoUSDAlertStore {
  rows = new Map<string, AlertRecord>()
  beats: { name: string; at: Date; ok: boolean; error?: string; data?: unknown }[] = []
  async active() {
    return [...this.rows.values()].filter((row) => row.status !== "RESOLVED" || resolvedUnsent(row)).map((row) => ({ ...row }))
  }
  async recent(_chainId: number, since: Date) {
    return [...this.rows.values()].filter((row) => row.status !== "RESOLVED" || (row.resolvedAt && row.resolvedAt >= since)).map((row) => ({ ...row }))
  }
  async save(_chainId: number, record: AlertRecord) {
    this.rows.set(record.key, { ...record })
  }
  async beat(_chainId: number, name: string, beat: { at: Date; ok: boolean; error?: string; data?: unknown }) {
    this.beats.push({ name, ...beat })
  }
  async heartbeat(_chainId: number, name: string): Promise<Heartbeat | null> {
    const last = [...this.beats].reverse().find((beat) => beat.name === name)
    if (!last) return null
    const lastOk = [...this.beats].reverse().find((beat) => beat.name === name && beat.ok)
    return { lastRunAt: last.at, lastOkAt: lastOk?.at ?? null, lastError: last.ok ? null : (last.error ?? null), data: last.data }
  }
}

function watcherWith(over: {
  registry?: () => ArcoUSDRegistryFile | null
  savings?: NonNullable<ConstructorParameters<typeof ArcoUSDWatcher>[0]["savings"]>
  readState?: (at?: bigint) => Promise<ReserveState>
  latest?: bigint
  indexed?: bigint | null
  queue?: QueueAssetSummary[]
  channels?: AlertChannel[]
  alertEnv?: ArcoUSDAlertEnv
  now?: () => number
}) {
  const store = new MemoryAlertStore()
  const reads: (bigint | undefined)[] = []
  const sent: string[] = []
  const watcher = new ArcoUSDWatcher({
    chainId: 91342,
    network: "GIWA Sepolia",
    env: parseArcoUSDEnv({}),
    alertEnv: over.alertEnv ?? parseArcoUSDAlertEnv({}),
    loadRegistry: over.registry ?? (() => registry()),
    readState: async (_deployment, at) => {
      reads.push(at)
      return over.readState ? over.readState(at) : reserve()
    },
    latestBlock: async () => over.latest ?? 1_002n,
    indexedBlock: async () => (over.indexed === undefined ? 1_000n : over.indexed),
    admin: {
      queue: async () =>
        ({ status: "live", filter: "open", targetSeconds: 0, queueMinDelay: 600, queueMinDelaySource: "chain", assets: over.queue ?? [summary()], requests: [], truncated: false, summaryTruncated: false }) as never,
    },
    lastSnapshotAt: async () => new Date(NOW - MIN),
    recalls: async () => ({ status: "live", recalls: [] }),
    savings: over.savings,
    store,
    channels: over.channels ?? [{ id: "slack", send: async (text) => void sent.push(text) }],
    now: over.now ?? (() => NOW),
    log: () => undefined,
  })
  return { watcher, store, reads, sent }
}

test("watcher: inert until deployed, then reads at the indexer's block and reconciles", async () => {
  const inert = watcherWith({ registry: () => null })
  assert.deepEqual(await inert.watcher.runOnce(), { mode: "inert", reason: "ArcoUSD registry missing or not deployed" })
  assert.equal(inert.store.beats.length, 0)

  // Chain owes 150, the indexer has 100, at the same block (indexer 2 blocks behind the head).
  const chainAsset = asset({ queued: e6(150).toString(), queueBacklog: 1, balance: "0" })
  const { watcher, store, reads, sent } = watcherWith({ readState: async () => reserve({ assets: [chainAsset] }), queue: [queuedOne(100, 20 * MIN)] })
  const round = await watcher.runOnce()
  assert.equal(round.mode, "run")
  assert.deepEqual(reads, [1_000n])
  const row = store.rows.get("reconcile:tUSDC")
  assert.equal(row?.status, "PENDING") // held 10 minutes before anyone is told
  assert.equal(sent.length, 0)
  assert.equal(last(store.beats)?.ok, true)
  assert.deepEqual((last(store.beats)?.data as { pinnedToIndexer: boolean }).pinnedToIndexer, true)
})

test("watcher: falls back to the head without reconciling when the indexer's block cannot be read", async () => {
  const chainAsset = asset({ queued: e6(150).toString(), queueBacklog: 1, balance: "0" })
  const { watcher, store, reads } = watcherWith({
    readState: async (at) => {
      if (at !== undefined) throw new Error("missing trie node")
      return reserve({ assets: [chainAsset] })
    },
    queue: [queuedOne(100, 20 * MIN)],
  })
  await watcher.runOnce()
  assert.deepEqual(reads, [1_000n, undefined])
  assert.equal(store.rows.has("reconcile:tUSDC"), false)

  // Far behind the head: no pinned read at all.
  const far = watcherWith({ latest: 5_000n, indexed: 1_000n })
  await far.watcher.runOnce()
  assert.deepEqual(far.reads, [undefined])
})

test("watcher: opens, sends one digest, keeps unseen alerts, and records failures in the heartbeat", async () => {
  let now = NOW
  let state: ReserveState | null = reserve({ settlementPaused: true })
  const { watcher, store, sent } = watcherWith({
    now: () => now,
    readState: async () => {
      if (!state) throw new Error("rpc down")
      return state
    },
  })
  await watcher.runOnce()
  assert.equal(store.rows.get("pauses")?.status, "OPEN")
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^ArcoUSD alerts · GIWA Sepolia\n1 warning\n\n🟠 WARNING · Paused: Reserve settleFor/)
  assert.ok(store.rows.get("pauses")?.lastNotifiedAt)

  // The reserve becomes unreadable: the pause alert is neither resolved nor re-sent.
  now += MIN
  state = null
  await watcher.runOnce()
  assert.equal(store.rows.get("pauses")?.status, "OPEN")
  assert.equal(store.rows.get("reserve:read-failed")?.status, "PENDING")
  assert.equal(sent.length, 1)

  // Readable again and unpaused: both clear; only the one that was sent says "resolved".
  now += MIN
  state = reserve()
  await watcher.runOnce()
  assert.equal(store.rows.get("pauses")?.status, "RESOLVED")
  assert.equal(store.rows.get("reserve:read-failed")?.status, "RESOLVED")
  assert.match(sent[1], /✅ RESOLVED · Paused: Reserve settleFor/)
  assert.doesNotMatch(sent[1], /unreadable/i)

  // A store failure surfaces as an error heartbeat (and to the caller).
  const failing = watcherWith({})
  failing.store.active = async () => {
    throw new Error("db down")
  }
  await assert.rejects(failing.watcher.runOnce(), /db down/)
  assert.deepEqual([last(failing.store.beats)?.ok, last(failing.store.beats)?.error], [false, "db down"])
})

test("watcher: an invalid registry raises its own alert and leaves the others alone", async () => {
  let broken = false
  const { watcher, store } = watcherWith({
    registry: () => {
      if (broken) throw new Error("reserve.proxy is not an address")
      return registry()
    },
    readState: async () => reserve({ routerPaused: true }),
  })
  await watcher.runOnce()
  assert.equal(store.rows.get("pauses")?.status, "OPEN")
  broken = true
  await watcher.runOnce()
  assert.equal(store.rows.get("registry:invalid")?.status, "OPEN")
  assert.equal(store.rows.get("pauses")?.status, "OPEN")
})

test("watcher: runs once per interval", async () => {
  let now = NOW
  const { watcher } = watcherWith({ now: () => now, channels: [] })
  assert.equal((await watcher.maybeRun()).mode, "run")
  now += 30_000
  assert.equal((await watcher.maybeRun()).mode, "not-due")
  now += 30_000
  assert.equal((await watcher.maybeRun()).mode, "run")
})

// ─────────────────────────────── console view ───────────────────────────────

test("console view: channels, heartbeat staleness, ordering, and the test send", async () => {
  assert.equal((await inertArcoUSDAlerts(91342).view()).status, "not-deployed")

  const store = new MemoryAlertStore()
  const record = (key: string, over: Partial<AlertRecord>): AlertRecord => ({
    key, severity: "WARNING", status: "OPEN", title: key, detail: "", fingerprint: "", firstSeenAt: new Date(NOW - HOUR), lastSeenAt: new Date(NOW - MIN),
    openedAt: new Date(NOW - HOUR), resolvedAt: null, lastNotifiedAt: null, notifyCount: 0, delivery: null, ...over,
  })
  await store.save(91342, record("pauses", {}))
  await store.save(91342, record("reserve:nav", { severity: "CRITICAL", delivery: { slack: { ok: false, at: "", error: "Slack answered 404: no_service" } } }))
  await store.save(91342, record("indexer:lag", { status: "PENDING", openedAt: null }))
  await store.save(91342, record("gate:closed", { status: "RESOLVED", resolvedAt: new Date(NOW - 2 * HOUR) }))
  await store.save(91342, record("indexer:snapshots", { status: "RESOLVED", openedAt: null, resolvedAt: new Date(NOW - HOUR) }))
  await store.beat(91342, WATCHER_HEARTBEAT, { at: new Date(NOW - 10 * MIN), ok: true })

  let now = NOW
  const sent: string[] = []
  const env = parseArcoUSDAlertEnv({ ARCOUSD_ALERT_SLACK_WEBHOOK_URL: WEBHOOK })
  const admin = new ArcoUSDAlertsAdmin({
    chainId: 91342,
    network: "GIWA Sepolia",
    loadRegistry: () => registry(),
    store,
    env,
    channels: [{ id: "slack", send: async (text) => void sent.push(text) }],
    now: () => now,
  })
  const view = await admin.view()
  assert.equal(view.status, "live")
  assert.deepEqual(view.channels, { telegram: false, slack: true })
  assert.deepEqual(view.alerts.map((alert) => alert.key), ["reserve:nav", "pauses", "indexer:lag", "gate:closed"]) // never-opened blip hidden
  assert.deepEqual(view.alerts[0].deliveryErrors, [{ channel: "slack", error: "Slack answered 404: no_service" }])
  assert.equal(view.watcher?.stale, true) // 10 minutes without a run at a 1-minute interval
  assert.ok(!JSON.stringify(view).includes("hooks.slack.com"))

  const ok = await admin.sendTest("0x00000000000000000000000000000000000000ee")
  assert.equal(ok.ok, true)
  assert.match(sent[0], /^ArcoUSD test alert · GIWA Sepolia\nSent from the admin console by 0x0000…00ee\./)
  assert.deepEqual(await admin.sendTest(null), { ok: false, status: 429, error: "Wait 30 seconds between test alerts" })
  now += 30_000
  assert.equal((await admin.sendTest(null)).ok, true)

  const none = new ArcoUSDAlertsAdmin({ chainId: 91342, network: "GIWA Sepolia", loadRegistry: () => registry(), store, env: parseArcoUSDAlertEnv({}), channels: [] })
  assert.equal(((await none.sendTest(null)) as { status: number }).status, 409)
})

// ─────────────────────────────── review follow-ups ───────────────────────────────

const RPC_KEY = "a1b2c3d4e5f6SECRETKEY"
const rpcError = () =>
  new HttpRequestError({ url: `https://rpc.example.invalid/${RPC_KEY}`, status: 503, body: { method: "eth_blockNumber" }, details: "Service Unavailable" })

test("error text that leaves the process never carries an RPC URL's key", () => {
  const text = safeErrorText(rpcError())
  assert.ok(!text.includes(RPC_KEY), text)
  assert.equal(text, "HTTP request failed (rpc.example.invalid, HTTP 503)")
  assert.equal(safeErrorText(new Error(`fetch failed https://rpc.example/${RPC_KEY}?x=1 next`)), "fetch failed https://rpc.example/… next")
  assert.equal(safeErrorText("plain"), "plain")
})

test("watcher: an RPC outage raises 'Reserve unreadable' (no key in any text) and keeps the DB rules running", async () => {
  let now = NOW
  const { watcher, store, sent } = watcherWith({
    now: () => now,
    queue: [queuedOne(10, 49 * HOUR, { overdueCount: 1 })],
  })
  // The chain head itself cannot be read.
  ;(watcher as unknown as { deps: { latestBlock: () => Promise<bigint>; readState: () => Promise<never> } }).deps.latestBlock = async () => {
    throw rpcError()
  }
  await watcher.runOnce()
  assert.equal(store.rows.get("reserve:read-failed")?.status, "PENDING")
  assert.equal(store.rows.get("queue:tUSDC:overdue")?.status, "OPEN") // read from the indexer DB, still evaluated
  for (let minute = 0; minute < 5; minute++) {
    now += MIN // one round a minute, as in the worker
    await watcher.runOnce()
  }
  assert.equal(store.rows.get("reserve:read-failed")?.status, "OPEN")
  const everything = JSON.stringify([...store.rows.values(), store.beats, sent])
  assert.ok(!everything.includes(RPC_KEY))
  assert.match(sent.join("\n"), /Reserve unreadable/)
  assert.match(store.rows.get("reserve:read-failed")?.detail ?? "", /HTTP request failed \(rpc\.example\.invalid, HTTP 503\)/)

  // A round that fails outright (the alert store) keeps the key out of the heartbeat too.
  const failing = watcherWith({})
  failing.store.active = async () => {
    throw rpcError()
  }
  await assert.rejects(failing.watcher.runOnce())
  assert.ok(!(last(failing.store.beats)?.error ?? "").includes(RPC_KEY))
})

test("watcher: NAV down does not resolve 'under-backed'; a recall whose read failed stays as it was", async () => {
  let now = NOW
  let state = reserve({ totalBacking: e18(9_000).toString(), totalLiabilities: e18(9_500).toString() })
  let recalls: RecallView[] = [
    { productId: "umint", requestId: "3", strategyId: 1, status: "SETTLED", state: "awaiting-acknowledgement", action: "acknowledge", pending: "1", open: true, lockedAssetsOut: "1", settledTxHash: null, createdAt: null, warning: null, error: null },
  ]
  const { watcher, store, sent } = watcherWith({ now: () => now, readState: async () => state })
  ;(watcher as unknown as { deps: { recalls: () => Promise<unknown> } }).deps.recalls = async () => ({ status: "live", recalls })
  await watcher.runOnce()
  for (let minute = 0; minute < 30; minute++) {
    now += MIN
    await watcher.runOnce()
  }
  assert.equal(store.rows.get("reserve:under-backed")?.status, "OPEN")
  assert.equal(store.rows.get("recall:umint:3:acknowledge")?.status, "OPEN")
  const before = sent.length

  now += MIN
  state = reserve({ navOk: false, totalBacking: "0", totalLiabilities: e18(9_500).toString() })
  recalls = [{ ...recalls[0], state: "unknown", error: "read failed" }]
  await watcher.runOnce()
  assert.equal(store.rows.get("reserve:under-backed")?.status, "OPEN")
  assert.equal(store.rows.get("recall:umint:3:acknowledge")?.status, "OPEN")
  assert.ok(!sent.slice(before).join("\n").includes("RESOLVED"))
})

test("alert book: a 'resolved' line no channel took is sent again; a replaced alert resolves quietly", async () => {
  const opened = step([], [finding()], NOW)
  applyDelivery(opened.notices, delivered, new Date(NOW))
  const cleared = step(opened.records, [], NOW + MIN)
  assert.deepEqual(cleared.notices.map((n) => n.kind), ["resolved"])
  applyDelivery(cleared.notices, failedEverywhere, new Date(NOW + MIN))
  assert.equal(resolvedUnsent(cleared.records[0]), true)
  // Next round: the RESOLVED row is still owed its line.
  const retry = step(cleared.records, [], NOW + 2 * MIN)
  assert.deepEqual(retry.notices.map((n) => n.kind), ["resolved"])
  applyDelivery(retry.notices, delivered, new Date(NOW + 2 * MIN))
  assert.equal(resolvedUnsent(retry.records[0]), false)
  // If the condition comes back first, nobody was told it cleared: it carries on as the same open alert.
  const back = step(cleared.records, [finding({ sustainMs: 5 * MIN })], NOW + 2 * MIN)
  assert.deepEqual([back.records[0].status, back.records[0].resolvedAt, back.records[0].firstSeenAt.getTime(), back.notices.length], ["OPEN", null, NOW, 0])
  // …and its later clearing still owes (and sends) the one "resolved" line.
  assert.deepEqual(step(back.records, [], NOW + 3 * MIN).notices.map((n) => n.kind), ["resolved"])

  // Aging that turned into overdue resolves without a message.
  const aging = step([], [finding({ key: "queue:tUSDC:aging", severity: "WARNING" })], NOW)
  applyDelivery(aging.notices, delivered, new Date(NOW))
  const replaced = step(aging.records, [finding({ key: "queue:tUSDC:overdue" })], NOW + MIN, { quiet: (key) => key === "queue:tUSDC:aging" })
  assert.deepEqual(replaced.notices.map((n) => `${n.kind}:${n.record.key}`), ["opened:queue:tUSDC:overdue"])
  const agingRow = replaced.records.find((r) => r.key === "queue:tUSDC:aging")!
  assert.deepEqual([agingRow.status, resolvedUnsent(agingRow)], ["RESOLVED", false]) // no line owed later either
})

test("alert book: continuity is counted in rounds — a slow round is not a gap, a skipped one is", () => {
  const sustained = finding({ key: "reserve:read-failed", sustainMs: 5 * MIN })
  // Rounds 80 seconds apart (a slow loop) with the condition seen every round: it opens after 5 minutes.
  let rows: AlertRecord[] = []
  let previous: Date | null = null
  let at = NOW
  for (let round = 0; round <= 4; round++, at += 80_000) {
    const result = stepAlerts({ active: rows, findings: [sustained], now: new Date(at), repeatCriticalMs: HOUR, repeatWarningMs: HOUR, notify: true, previousRoundAt: previous })
    rows = result.records
    previous = new Date(at)
  }
  assert.equal(rows[0].status, "OPEN")
  // Seen by the previous round, but that round came after a long run of failed ones: a break too.
  const stale = stepAlerts({ active: step([], [sustained], NOW).records, findings: [sustained], now: new Date(NOW + HOUR), repeatCriticalMs: HOUR, repeatWarningMs: HOUR, notify: true, previousRoundAt: new Date(NOW), maxGapMs: 5 * MIN })
  assert.deepEqual([stale.records[0].status, stale.records[0].firstSeenAt.getTime()], ["PENDING", NOW + HOUR])
  // Not seen by the previous round (it could not tell): the clock starts again.
  const first = step([], [sustained], NOW)
  const skipped = stepAlerts({ active: first.records, findings: [sustained], now: new Date(NOW + 2 * MIN), repeatCriticalMs: HOUR, repeatWarningMs: HOUR, notify: true, previousRoundAt: new Date(NOW + MIN) })
  assert.equal(skipped.records[0].firstSeenAt.getTime(), NOW + 2 * MIN)
})

test("alert book: a waiting condition seen again after a gap restarts its sustain clock", () => {
  const sustained = finding({ key: "reconcile:tUSDC", sustainMs: 10 * MIN })
  const first = step([], [sustained], NOW, { maxGapMs: 2.5 * MIN })
  // Unknown for half an hour (indexer far behind), then seen again: not 30 minutes "held".
  const gap = step(first.records, [], NOW + 30 * MIN, { unknown: (key) => key.startsWith("reconcile:"), maxGapMs: 2.5 * MIN })
  assert.equal(gap.records.length, 0)
  const again = step(first.records, [sustained], NOW + 30 * MIN, { maxGapMs: 2.5 * MIN })
  assert.deepEqual([again.records[0].status, again.records[0].firstSeenAt.getTime(), again.notices.length], ["PENDING", NOW + 30 * MIN, 0])
  // Seen every round: it opens after its 10 minutes.
  let rows = first.records
  for (let minute = 1; minute <= 10; minute++) rows = step(rows, [sustained], NOW + minute * MIN, { maxGapMs: 2.5 * MIN }).records
  assert.equal(rows[0].status, "OPEN")
})

test("watcher: a slow loop still opens sustained alerts; an indexer that moved mid-round is not reconciled", async () => {
  let now = NOW
  const { watcher, store } = watcherWith({
    now: () => now,
    alertEnv: parseArcoUSDAlertEnv({ ARCOUSD_ALERT_INTERVAL_MS: "30000" }),
    readState: async () => {
      throw rpcError()
    },
  })
  for (let round = 0; round < 6; round++, now += 80_000) await watcher.runOnce()
  assert.equal(store.rows.get("reserve:read-failed")?.status, "OPEN")

  // The cursor moves between the pinned read and the queue read: no reconciliation this round.
  let cursor = 1_000n
  const chainAsset = asset({ queued: e6(150).toString(), queueBacklog: 1, balance: "0" })
  const moved = watcherWith({ readState: async () => reserve({ assets: [chainAsset] }), queue: [queuedOne(100, 20 * MIN)] })
  ;(moved.watcher as unknown as { deps: { indexedBlock: () => Promise<bigint> } }).deps.indexedBlock = async () => cursor++
  const round = await moved.watcher.runOnce()
  assert.equal(round.mode === "run" && round.pinnedToIndexer, false)
  assert.equal(moved.store.rows.has("reconcile:tUSDC"), false)

  // Same cursor, but a poll started meanwhile (it may have written rows before moving its cursor).
  let polls = 7
  const overlapped = watcherWith({ readState: async () => reserve({ assets: [chainAsset] }), queue: [queuedOne(100, 20 * MIN)] })
  ;(overlapped.watcher as unknown as { deps: { admin: { queue: () => Promise<unknown> } } }).deps.admin.queue = async () => {
    polls++
    return { status: "live", filter: "open", targetSeconds: 0, queueMinDelay: 600, queueMinDelaySource: "chain", assets: [queuedOne(100, 20 * MIN)], requests: [], truncated: false, summaryTruncated: false }
  }
  const overlapRound = await overlapped.watcher.runOnce({ pollSeq: () => polls })
  assert.equal(overlapRound.mode === "run" && overlapRound.pinnedToIndexer, false)
})

test("watcher: a round still running answers 'busy' with its age", async () => {
  let release: () => void = () => undefined
  let now = NOW
  const { watcher } = watcherWith({ now: () => now })
  ;(watcher as unknown as { deps: { latestBlock: () => Promise<bigint> } }).deps.latestBlock = () =>
    new Promise((resolve) => {
      release = () => resolve(1_002n)
    })
  const first = watcher.maybeRun()
  now += 45_000
  assert.deepEqual(await watcher.maybeRun(), { mode: "busy", sinceMs: 45_000 })
  release()
  assert.equal((await first).mode, "run")
})

test("alert book: one channel taking the message counts as sent", () => {
  const opened = step([], [finding()], NOW)
  applyDelivery(opened.notices, { telegram: { ok: true, at: "" }, slack: { ok: false, at: "", error: "timed out" } }, new Date(NOW))
  assert.equal(opened.records[0].notifyCount, 1)
  assert.equal(step(opened.records, [finding()], NOW + MIN).notices.length, 0)
})

test("Prisma alert store: upsert by key, an empty delivery for a fresh occurrence, owed 'resolved' rows stay active", async () => {
  const calls: { op: string; args: Record<string, any> }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  const rowsBack = [
    { key: "pauses", severity: "WARNING", status: "OPEN", title: "t", detail: "d", fingerprint: "", firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW), openedAt: new Date(NOW), resolvedAt: null, lastNotifiedAt: new Date(NOW), notifyCount: 1, delivery: {} },
    { key: "gate:closed", severity: "WARNING", status: "RESOLVED", title: "t", detail: "d", fingerprint: "", firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW), openedAt: new Date(NOW), resolvedAt: new Date(NOW + MIN), lastNotifiedAt: new Date(NOW), notifyCount: 1, delivery: { slack: { ok: false, at: "", error: "x" } } },
    { key: "reserve:nav", severity: "CRITICAL", status: "RESOLVED", title: "t", detail: "d", fingerprint: "", firstSeenAt: new Date(NOW), lastSeenAt: new Date(NOW), openedAt: new Date(NOW), resolvedAt: new Date(NOW), lastNotifiedAt: new Date(NOW + MIN), notifyCount: 2, delivery: null },
  ]
  const store = new PrismaArcoUSDAlertStore({
    arcoUSDAlert: {
      findMany: async (args) => (calls.push({ op: "findMany", args: args as never }), rowsBack),
      upsert: async (args) => (calls.push({ op: "upsert", args: args as never }), {}),
    },
    arcoUSDHeartbeat: { upsert: async () => ({}), findUnique: async () => null },
  })
  const active = await store.active(91342, new Date(NOW + 2 * MIN))
  assert.deepEqual(active.map((row) => row.key), ["pauses", "gate:closed"]) // reserve:nav's resolved line went out
  assert.equal(active[0].delivery, null) // {} reads back as "no send"
  const where = calls[0].args.where
  assert.equal(where.OR[1].status, "RESOLVED")
  assert.equal(where.OR[1].resolvedAt.gte.getTime(), NOW + 2 * MIN - 24 * HOUR)

  await store.save(91342, { ...active[0], delivery: null, status: "PENDING" })
  const upsert = calls[1].args
  assert.deepEqual(upsert.where, { chainId_key: { chainId: 91342, key: "pauses" } })
  assert.deepEqual([upsert.update.delivery, upsert.create.delivery, upsert.create.chainId], [{}, {}, 91342])
})

// ─────────────────────────────── queue keeper health ───────────────────────────────

test("rules: the queue keeper's own health (nothing while it is off)", () => {
  const seen = (over: Record<string, unknown>, beat: Partial<{ lastRunAt: Date; lastOkAt: Date | null; lastError: string | null }> = {}) => ({
    lastRunAt: new Date(NOW - MIN),
    lastOkAt: new Date(NOW - MIN),
    lastError: null,
    ...beat,
    report: { mode: "live", intervalMs: 60_000, address: A(0xee), gasBalanceWei: "50000000000000000", lowGasWei: "10000000000000000", lowGas: false, pending: null, ...over },
  })
  assert.deepEqual(evaluateWatch(input({ keeper: seen({}) })), [])
  assert.deepEqual(evaluateWatch(input({ keeper: seen({ mode: "off" }, { lastRunAt: new Date(NOW - 5 * HOUR) }) })), [])

  const stale = evaluateWatch(input({ keeper: seen({ lowGas: true }, { lastRunAt: new Date(NOW - 20 * MIN), lastError: "rpc down", lastOkAt: null }) }))
  assert.deepEqual(keys(stale), ["keeper:stale"]) // older readings are not judged
  assert.match(find(stale, "keeper:stale").detail, /The live keeper last ran 20m ago/)

  const failing = find(evaluateWatch(input({ keeper: seen({}, { lastError: "Send failed: nonce too low", lastOkAt: new Date(NOW - 11 * MIN) }) })), "keeper:failing")
  assert.equal(failing.detail, "Send failed: nonce too low")
  assert.deepEqual(keys(evaluateWatch(input({ keeper: seen({}, { lastError: "blip", lastOkAt: new Date(NOW - 2 * MIN) }) }))), [])

  const gas = find(evaluateWatch(input({ keeper: seen({ lowGas: true, gasBalanceWei: "4200000000000000" }) })), "keeper:low-gas")
  assert.match(gas.detail, /holds 0\.0042 ETH \(warns below 0\.01 ETH\)/)
  assert.deepEqual(keys(evaluateWatch(input({ keeper: seen({ mode: "dry-run", lowGas: true }) }))), []) // dry-run spends no gas

  const stuck = find(evaluateWatch(input({ keeper: seen({ pending: { nonce: 7, since: "2026-10-19T11:40:00.000Z", stuck: true } }) })), "keeper:stuck")
  assert.match(stuck.detail, /Nonce 7 has been pending since 2026-10-19T11:40:00\.000Z/)
})

test("watcher: the keeper heartbeat feeds its rules; an unreadable one keeps keeper alerts as they were", async () => {
  let now = NOW
  const { watcher, store } = watcherWith({ now: () => now })
  await store.beat(91342, "keeper", { at: new Date(NOW - 30 * MIN), ok: true, data: { mode: "live", intervalMs: 60_000 } })
  await watcher.runOnce()
  assert.equal(store.rows.get("keeper:stale")?.status, "OPEN")
  now += MIN
  const heartbeat = store.heartbeat.bind(store)
  store.heartbeat = async (chainId: number, name: string) => {
    if (name === "keeper") throw new Error("db down")
    return heartbeat(chainId, name)
  }
  await watcher.runOnce()
  assert.equal(store.rows.get("keeper:stale")?.status, "OPEN")
})

test("console keeper view: never run, stale, and its report", async () => {
  const store = new MemoryAlertStore()
  let now = NOW
  const admin = new ArcoUSDAlertsAdmin({ chainId: 91342, network: "GIWA Sepolia", loadRegistry: () => registry(), store, env: parseArcoUSDAlertEnv({}), channels: [], now: () => now })
  assert.deepEqual(await admin.keeper(), { status: "live", keeper: null })
  assert.deepEqual(await inertArcoUSDAlerts(91342).keeper(), { status: "not-deployed", keeper: null })
  await store.beat(91342, "keeper", { at: new Date(NOW - MIN), ok: true, data: { mode: "live", intervalMs: 60_000, address: A(0xee), lastTx: null } })
  const fresh = await admin.keeper()
  assert.deepEqual([fresh.keeper?.stale, fresh.keeper?.report?.mode, fresh.keeper?.report?.address], [false, "live", A(0xee)])
  now += 10 * MIN
  assert.equal((await admin.keeper()).keeper?.stale, true)
  await store.beat(91342, "keeper", { at: new Date(now - 30 * MIN), ok: true, data: { mode: "off" } })
  assert.equal((await admin.keeper()).keeper?.stale, false) // off is never "stale"
})

// ─────────────────────────────── Savings ───────────────────────────────

const VAULT = A(0x5a)
const DISTRIBUTOR = A(0x5b)
const DAY = 24 * HOUR

/** A healthy, seeded vault with savers; distributed an hour ago, next in 23 hours, nothing to send yet. */
function savingsState(over: Partial<SavingsState> = {}, distributor: Partial<SavingsState["distributor"]> = {}, preview: Partial<NonNullable<SavingsState["distributor"]["preview"]>> = {}): SavingsState {
  return {
    blockNumber: "1000",
    totalAssets: e18(5000).toString(),
    totalAssetsUsd: "5000",
    totalSupply: e18(4990).toString(),
    sharePrice: e18(1.002).toString(),
    sharePriceHuman: "1.002",
    unvested: "0",
    unvestedUsd: "0",
    vestingAmount: "0",
    vestingPeriodSeconds: 86_400,
    vestingStartedAt: null,
    vestingEndsAt: null,
    rewardRate: "0",
    currentAprBps: 0,
    currentApyBps: 0,
    seeded: true,
    vaultPaused: false,
    depositPaused: false,
    withdrawPaused: false,
    rewardsPaused: false,
    depositsOpen: true,
    withdrawalsOpen: true,
    ...over,
    distributor: {
      paused: false,
      reservePaused: false,
      arcoUSDMintPaused: false,
      minIntervalSeconds: 86_400,
      maxAprBps: 2000,
      reserveMarginBps: 50,
      lastDistributionAt: new Date(NOW - HOUR).toISOString(),
      nextDistributionAt: new Date(NOW + 23 * HOUR).toISOString(),
      preview: { amount: "0", amountUsd: "0", surplus: e18(40).toString(), rateCap: "0", mintHeadroom: e18(1e6).toString(), navOk: true, ...preview },
      ...distributor,
    },
  }
}

const seenSavings = (state: SavingsState | null, over: Partial<SavingsSeen> = {}): SavingsSeen => ({
  state,
  error: state ? null : "rpc.example.invalid, HTTP 503",
  lagBlocks: 2,
  lastSnapshotAt: new Date(NOW - MIN),
  ...over,
})
const savingsFindings = (state: SavingsState | null, over: Partial<SavingsSeen> = {}) => evaluateWatch(input({ savings: seenSavings(state, over) }))

test("rules: Savings — healthy raises nothing; unreadable, not seeded, and its own switches", () => {
  assert.deepEqual(savingsFindings(savingsState()), [])
  assert.deepEqual(evaluateWatch(input({ savings: null })), [])

  const unreadable = find(savingsFindings(null), "savings:read-failed")
  assert.deepEqual([unreadable.severity, unreadable.sustainMs], ["WARNING", 5 * MIN])
  assert.match(unreadable.detail, /could not read sArcoUSD or its distributor \(rpc\.example\.invalid, HTTP 503\)/)

  // Before the seed deposits are closed by design: "not seeded" says so, the deposit switch is not a pause.
  const unseeded = savingsFindings(savingsState({ seeded: false, depositPaused: true, totalSupply: "0" }))
  assert.deepEqual(keys(unseeded), ["savings:not-seeded"])
  assert.equal(find(unseeded, "savings:not-seeded").sustainMs, 30 * MIN)

  const paused = find(savingsFindings(savingsState({ withdrawPaused: true, rewardsPaused: true }, { paused: true })), "savings:pauses")
  assert.equal(paused.title, "Savings paused: Savings distributor, sArcoUSD withdraw, sArcoUSD addRewards")
  assert.equal(paused.fingerprint, "distributor,withdraw,rewards")
  assert.match(paused.detail, /sArcoUSD withdraw: savings withdrawals, the Zap's too\./)

  const noPreview = savingsFindings(savingsState({}, { preview: null, previewError: "preview-unreadable" }))
  assert.deepEqual(keys(noPreview), ["savings:preview"])
})

test("rules: Savings — a due distribution unsent for 2 hours is overdue; none for a week says why; silent while blocked", () => {
  const due = (ago: number, amount = e18(3.21)) =>
    savingsState({}, { lastDistributionAt: new Date(NOW - DAY - ago).toISOString(), nextDistributionAt: new Date(NOW - ago).toISOString() }, { amount: amount.toString(), rateCap: amount.toString() })

  assert.deepEqual(savingsFindings(due(SAVINGS_OVERDUE_MS - MIN)), []) // the keeper still has time
  const overdue = find(savingsFindings(due(3 * HOUR)), "savings:overdue")
  assert.deepEqual([overdue.severity, overdue.sustainMs], ["WARNING", 10 * MIN]) // the keeper's to send first
  assert.match(overdue.detail, /^Due for 3h, and \$3\.21 can be distributed now\./)
  assert.deepEqual(savingsFindings(due(3 * HOUR, 10n ** 16n - 1n)), []) // under a cent is not worth a transaction

  // Anything that makes distribute() revert, or a NAV that is down, is said by its own alert instead.
  const late = due(3 * HOUR)
  for (const [vault, distributor] of [
    [{ rewardsPaused: true }, {}],
    [{ vaultPaused: true }, {}],
    [{}, { paused: true }],
    [{}, { reservePaused: true }],
    [{}, { arcoUSDMintPaused: true }],
  ] as const) {
    const state: SavingsState = { ...late, ...vault, distributor: { ...late.distributor, ...distributor } }
    assert.ok(!keys(savingsFindings(state)).includes("savings:overdue"))
  }
  const navDown = due(3 * HOUR)
  assert.deepEqual(savingsFindings({ ...navDown, distributor: { ...navDown.distributor, preview: { ...navDown.distributor.preview!, navOk: false } } }), [])

  // A week with nothing to send while savers hold sArcoUSD: say why.
  const quiet = (preview: Partial<NonNullable<SavingsState["distributor"]["preview"]>>, over: Partial<SavingsState> = {}) =>
    savingsFindings(savingsState(over, { lastDistributionAt: new Date(NOW - SAVINGS_NO_YIELD_MS - HOUR).toISOString(), nextDistributionAt: new Date(NOW - 6 * DAY).toISOString() }, preview))
  assert.match(find(quiet({ surplus: "0", rateCap: e18(9).toString() }), "savings:no-yield").detail, /^No distribution for 7d 1h .*no surplus above its 0\.5% margin/)
  assert.match(find(quiet({ mintHeadroom: "0" }), "savings:no-yield").detail, /mint cap is reached; raise mintCap/)
  assert.match(find(quiet({ surplus: e18(0.004).toString(), rateCap: e18(9).toString() }), "savings:no-yield").detail, /no surplus above/) // under a cent is none
  // Only the APR cap binds (a vault too small or too new to earn a cent a day): nothing anyone can fix.
  assert.deepEqual(quiet({ rateCap: e18(0.009).toString() }), [])
  assert.deepEqual(quiet({ surplus: "0" }, { totalSupply: (10n ** 18n).toString() }), []) // only the seed: nobody to pay
})

test("rules: the savings indexer behind, and its snapshots stale", () => {
  const lag = find(savingsFindings(savingsState(), { lagBlocks: 700 }), "savings:indexer-lag")
  assert.match(lag.detail, /700 blocks behind/)
  const stale = find(savingsFindings(savingsState(), { lastSnapshotAt: new Date(NOW - 20 * MIN) }), "savings:snapshots")
  assert.match(stale.detail, /20m old \(expected every 5m\)/)
  assert.deepEqual(savingsFindings(savingsState(), { lagBlocks: null, lastSnapshotAt: null }), [])
})

test("watcher: reads Savings once it is in the registry; what it could not read keeps its alerts as they were", async () => {
  const withSavings = () =>
    registry({
      savings: {
        vault: { proxy: VAULT, implementation: A(0x50), bytecodeHash: null, blockNumber: 150 },
        distributor: { address: DISTRIBUTOR, bytecodeHash: null, blockNumber: 151 },
        zap: { address: A(0x5c), bytecodeHash: null, blockNumber: 152 },
        seeded: true,
      },
    })
  const overdue = savingsState({}, { lastDistributionAt: new Date(NOW - 2 * DAY).toISOString(), nextDistributionAt: new Date(NOW - DAY).toISOString() }, { amount: e18(4).toString() })
  let read: () => Promise<SavingsState> = async () => overdue
  let cursor: () => Promise<bigint | null> = async () => 1_000n
  const asked: string[] = []
  let now = NOW
  const { watcher, store } = watcherWith({
    registry: withSavings,
    now: () => now,
    savings: {
      read: async (savings) => (asked.push(savings.vaultAddress), read()),
      indexedBlock: () => cursor(),
      lastSnapshotAt: async () => new Date(now - MIN),
    },
  })
  await watcher.runOnce()
  assert.deepEqual(asked, [VAULT])
  assert.equal(store.rows.get("savings:overdue")?.status, "PENDING") // the keeper's to send first
  for (let round = 0; round < 3; round++) {
    now += 4 * MIN
    await watcher.runOnce()
  }
  assert.equal(store.rows.get("savings:overdue")?.status, "OPEN")

  // The preview unreadable: what could be distributed is unknown, so "overdue" stays as it was.
  now += MIN
  read = async () => ({ ...overdue, distributor: { ...overdue.distributor, preview: null, previewError: "preview-unreadable" } })
  await watcher.runOnce()
  assert.equal(store.rows.get("savings:overdue")?.status, "OPEN")
  assert.equal(store.rows.get("savings:preview")?.status, "PENDING")

  // RPC down: "unreadable" waits its 5 minutes, and "overdue" is neither re-judged nor resolved.
  now += MIN
  read = async () => {
    throw new HttpRequestError({ url: "https://rpc.example.invalid/SECRETKEY42", status: 503, body: {}, details: "Unavailable" })
  }
  cursor = async () => {
    throw new Error("db down")
  }
  await watcher.runOnce()
  assert.equal(store.rows.get("savings:overdue")?.status, "OPEN")
  assert.equal(store.rows.get("savings:read-failed")?.status, "PENDING")
  assert.ok(!JSON.stringify([...store.rows.values()]).includes("SECRETKEY42"))

  // Read again and distributed: resolved.
  now += MIN
  read = async () => savingsState()
  cursor = async () => 1_000n
  await watcher.runOnce()
  assert.equal(store.rows.get("savings:overdue")?.status, "RESOLVED")

  // Without Savings in the registry nothing is read.
  let plainReads = 0
  const plain = watcherWith({ savings: { read: async () => (plainReads++, overdue), indexedBlock: async () => null, lastSnapshotAt: async () => null } })
  await plain.watcher.runOnce()
  assert.equal(plainReads, 0)
})
