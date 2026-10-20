import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AlertsCard, ArcoUSDAdminView, KeeperCard, ProcessQueueControl } from "./AdminArcoUSD"
import { sendPreparedTransactionWithClients } from "./contracts"
import {
  ARCOUSD_ADMIN_TABS,
  agoText,
  alertBadge,
  alertMeta,
  amountText,
  arcoUSDAdminTab,
  batchSize,
  bpsText,
  countText,
  deliveryText,
  distributionVerdict,
  durationText,
  gasText,
  keeperBadge,
  keeperDistributeText,
  keeperTxBadge,
  keeperTxText,
  gateText,
  gateAfterTopUp,
  headVerdict,
  mintHeadroomUsd,
  pauseRows,
  payoutsPaused,
  queueFilter,
  rewardsPerDayUsd,
  savingsPauseRows,
  sharePriceText,
  usdCompact,
  simulationText,
  TOP_UP_MAX,
  topUpAmount,
  topUpAssets,
  usdText,
  watcherStatus,
} from "./arcousd-admin"
import type { GiwaArcoUSDAlert, GiwaArcoUSDAlerts, GiwaArcoUSDKeeper, GiwaArcoUSDKeeperReport, GiwaArcoUSDFlows, GiwaArcoUSDQueue, GiwaArcoUSDReserve, GiwaArcoUSDSavings, GiwaArcoUSDSavingsAdmin, GiwaArcoUSDSavingsHistory, GiwaArcoUSDSavingsState, GiwaArcoUSDSnapshots } from "./types"

// Admin · ArcoUSD page: the pure helpers and the three views over fixed data.

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const NOW = Date.parse("2026-10-19T12:00:00.000Z")
const e18 = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString()
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ")

const asset = (symbol: string, address: string, balance: string, balanceHuman: string, swapFeeBps: number) => ({
  symbol,
  address,
  decimals: 6,
  depositEnabled: true,
  redeemEnabled: true,
  instantFeeBps: 0,
  swapFeeBps,
  balance,
  queued: "0",
  available: balance,
  balanceHuman,
  queuedHuman: "0",
  availableHuman: balanceHuman,
  queueLength: 0,
  queueHead: 0,
  queueBacklog: 0,
})

function reserve(over: Partial<NonNullable<GiwaArcoUSDReserve["reserve"]>> = {}, gate: Partial<GiwaArcoUSDReserve["gate"]> = {}): GiwaArcoUSDReserve {
  return {
    status: "live",
    chainId: 91342,
    contracts: { arcoUSD: A(1), reserve: A(3), lens: A(5), router: A(7), routerProducts: ["umint", "ibenji"] },
    readAt: "2026-10-19T11:59:00.000Z",
    reserve: {
      blockNumber: "123",
      totalBacking: e18(2001),
      totalLiabilities: e18(2000),
      totalBackingUsd: "2001",
      totalLiabilitiesUsd: "2000",
      surplus: e18(1),
      navOk: true,
      mmfBps: 4000,
      mmfTargetBps: 5000,
      bufferFloorBps: 3000,
      queueMinDelay: 600,
      mintCap: e18(10_000),
      reservePaused: false,
      settlementPaused: false,
      arcoUSDPaused: false,
      arcoUSDBurnPaused: false,
      depositPaused: true,
      arcoUSDMintPaused: false,
      routerPaused: false,
      assets: [asset("tUSDC", A(0xc1), "1200000000", "1200", 0), asset("tUSDT", A(0xc2), "50000000", "50", 10)],
      strategies: [
        { strategyId: 0, productId: "umint", asset: A(0xc1), productToken: A(9), enabled: true, shares: e18(400), value: e18(800), valueUsd: "800", navOk: true, pendingRecall: "0", maxAllocation: e18(1_000_000) },
      ],
      ...over,
    },
    gate: { status: "closed", reason: "buy-paused", asset: "tUSDC", available: "1200", threshold: "1000", checkedAt: "", ...gate },
  }
}

const snapshots: GiwaArcoUSDSnapshots = {
  status: "live",
  days: 30,
  total: 2,
  sampled: false,
  truncated: false,
  points: [
    { takenAt: "2026-10-18T00:00:00.000Z", blockNumber: "100", totalBackingUsd: "1000", totalLiabilitiesUsd: "1000", surplusUsd: "0", mmfBps: 0, navOk: true, paused: false, settlementPaused: false },
    { takenAt: "2026-10-19T00:00:00.000Z", blockNumber: "120", totalBackingUsd: "2001", totalLiabilitiesUsd: "2000", surplusUsd: "1", mmfBps: 4000, navOk: true, paused: false, settlementPaused: false },
  ],
}

const queue: GiwaArcoUSDQueue = {
  status: "live",
  filter: "open",
  targetSeconds: 172_800,
  queueMinDelay: 600,
  queueMinDelaySource: "chain",
  assets: [
    {
      symbol: "tUSDT",
      asset: A(0xc2),
      decimals: 6,
      queuedCount: 2,
      queuedAmount: "199800000",
      queuedAmountHuman: "199.8",
      overdueCount: 1,
      failedCount: 1,
      oldestRequestedAt: "2026-10-17T10:00:00.000Z",
      head: { requestId: "4", assetAmount: "99900000", assetAmountHuman: "99.9", eligibleAt: "2026-10-17T10:10:00.000Z" },
    },
    {
      symbol: "tUSDC",
      asset: A(0xc1),
      decimals: 6,
      queuedCount: 1,
      queuedAmount: "5000000",
      queuedAmountHuman: "5",
      overdueCount: 0,
      failedCount: 0,
      oldestRequestedAt: "2026-10-19T11:58:00.000Z",
      head: { requestId: "9", assetAmount: "5000000", assetAmountHuman: "5", eligibleAt: "2026-10-19T12:08:00.000Z" },
    },
  ],
  requests: [
    {
      requestId: "4",
      owner: A(0xa1),
      recipient: A(0xa1),
      asset: A(0xc2),
      symbol: "tUSDT",
      decimals: 6,
      status: "QUEUED",
      arcoUSDAmount: e18(100),
      arcoUSDAmountHuman: "100",
      assetAmount: "99900000",
      assetAmountHuman: "99.9",
      feeUsd: "0.1",
      requestedAt: "2026-10-17T10:00:00.000Z",
      eligibleAt: "2026-10-17T10:10:00.000Z",
      waitSeconds: 180_000,
      overdue: true,
      queuedTxHash: `0x${"aa".repeat(32)}`,
      closedTxHash: null,
      closedAt: null,
    },
  ],
  truncated: false,
  summaryTruncated: false,
}

const zeroTotals = {
  depositsUsd: "0",
  instantRedemptionsUsd: "0",
  queuedRedemptionsUsd: "0",
  queuedPaidUsd: "0",
  settlementsUsd: "0",
  routerBuysUsd: "0",
  feesUsd: "0",
  deposits: 0,
  instantRedemptions: 0,
  queuedRedemptions: 0,
  queuedPaid: 0,
  settlements: 0,
  routerBuys: 0,
}

const flows: GiwaArcoUSDFlows = {
  status: "live",
  days: 30,
  since: "2026-09-20T00:00:00.000Z",
  totals: { ...zeroTotals, depositsUsd: "1500", deposits: 2, instantRedemptionsUsd: "200", instantRedemptions: 1, queuedPaidUsd: "99.9", queuedPaid: 1, routerBuysUsd: "300", routerBuys: 1, settlementsUsd: "300", settlements: 1, feesUsd: "1.3" },
  daily: [{ day: "2026-10-19", ...zeroTotals, depositsUsd: "1500", feesUsd: "1.3" }],
  byAsset: [{ symbol: "tUSDT", asset: A(0xc2), ...zeroTotals, depositsUsd: "1000", feesUsd: "1.3" }],
  routerBuysByPayAsset: [{ symbol: "ArcoUSD", count: 1, volumeUsd: "300" }],
  recent: [
    { eventName: "Bought", contract: "router", txHash: `0x${"bb".repeat(32)}`, blockNumber: "130", logIndex: 1, at: "2026-10-19T11:00:00.000Z", symbol: null, account: A(0xa1), amountUsd: "300", feeUsd: null },
    { eventName: "Deposited", contract: "reserve", txHash: `0x${"cc".repeat(32)}`, blockNumber: "110", logIndex: 0, at: "2026-10-19T10:00:00.000Z", symbol: "tUSDT", account: A(0xa1), amountUsd: "1000", feeUsd: "1" },
  ],
  truncated: false,
  unknownAssetEvents: 0,
}

const noop = () => undefined
const pending = () => new Promise<never>(() => undefined)

function page(tab: "overview" | "queue" | "flows" | "savings", over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <ArcoUSDAdminView
      tab={tab}
      onTabChange={noop}
      hasAuth
      reserve={reserve()}
      overview={{ snapshots, days: 30, onDaysChange: noop }}
      queue={{ queue, filter: "open", onFilterChange: noop, walletAddress: A(0xee), onConnectWallet: noop, onPrepare: pending, onSend: pending, now: NOW }}
      flows={{ flows, days: 30, onDaysChange: noop }}
      {...over}
    />,
  )
}

test("helpers: money (max 2 decimals), basis points, durations, tabs, filters, batch sizes", () => {
  assert.deepEqual([usdText("1234.567"), usdText(-3.5), usdText(null), usdText("x")], ["$1,234.57", "-$3.5", "—", "—"])
  assert.deepEqual([amountText("99.9"), amountText("0.123456", 6)], ["99.9", "0.123456"])
  assert.deepEqual([bpsText(5000), bpsText(10), bpsText(null)], ["50%", "0.1%", "—"])
  assert.deepEqual(
    [durationText(180_000), durationText(172_800), durationText(12_000), durationText(600), durationText(45), durationText(-1)],
    ["2d 2h", "2d", "3h 20m", "10m", "45s", "—"],
  )
  assert.deepEqual([countText(1, "buy"), countText(3, "buy"), countText(0, "settleFor call")], ["1 buy", "3 buys", "0 settleFor calls"])
  assert.deepEqual([arcoUSDAdminTab("queue"), arcoUSDAdminTab("nope"), arcoUSDAdminTab(null)], ["queue", "overview", "overview"])
  assert.deepEqual([queueFilter("PAID"), queueFilter("bogus"), queueFilter(null)], ["PAID", "open", "open"])
  assert.deepEqual([batchSize("20"), batchSize("0"), batchSize("51"), batchSize("2.5"), batchSize(" 7 ")], [20, null, null, null, 7])
})

test("helpers: buffer top-up assets, amount and what it does to the gate", () => {
  // Deposits-on assets only, the gate's asset first.
  const assets = reserve({ assets: [asset("tUSDT", A(0xc2), "0", "0", 10), { ...asset("tRLUSD", A(0xc3), "0", "0", 10), depositEnabled: false }, asset("tUSDC", A(0xc1), "0", "0", 0)] })
  assert.deepEqual(topUpAssets(assets), [
    { symbol: "tUSDC", decimals: 6 },
    { symbol: "tUSDT", decimals: 6 },
  ])
  assert.deepEqual(
    [topUpAmount("1000", 6), topUpAmount(" 12.5 ", 6), topUpAmount("0.000001", 6), topUpAmount(String(TOP_UP_MAX), 6)],
    ["1000", "12.5", "0.000001", String(TOP_UP_MAX)],
  )
  assert.equal(topUpAmount(`${TOP_UP_MAX}.000`, 6), `${TOP_UP_MAX}.000`)
  for (const value of ["", "0", "0.000", "0.0000001", "-1", "1e3", "1,000", ".5", "1.", String(TOP_UP_MAX + 1), `${TOP_UP_MAX}.000001`, "abc"]) {
    assert.equal(topUpAmount(value, 6), null, value)
  }
  // The gate's asset: settleable after = max(0, balance + amount − queued); the mint cap must keep a threshold-sized buy.
  const gated = (assetOver: Record<string, unknown>, gate: Partial<GiwaArcoUSDReserve["gate"]>, over: Partial<NonNullable<GiwaArcoUSDReserve["reserve"]>> = {}) =>
    reserve({ assets: [{ ...asset("tUSDC", A(0xc1), "1000000", "1", 0), ...assetOver }, asset("tUSDT", A(0xc2), "0", "0", 10)], ...over }, gate)
  const short = { status: "closed" as const, reason: "insufficient-buffer" as const, available: "1", threshold: "1000" }
  assert.deepEqual(gateAfterTopUp(gated({}, short), "tUSDC", 999), { availableAfter: 1000, verdict: "Reaches the threshold: the gate opens on the next reserve read" })
  assert.deepEqual(gateAfterTopUp(gated({}, short), "tUSDC", 500), { availableAfter: 501, verdict: "Still $499 below the threshold" })
  // A queue backlog takes its share of the deposit first.
  const owed = gated({ balanceHuman: "100", queuedHuman: "600", availableHuman: "0" }, { ...short, available: "0" })
  assert.deepEqual(gateAfterTopUp(owed, "tUSDC", 1000), { availableAfter: 500, verdict: "Still $500 below the threshold" })
  // Enough buffer, but the ArcoUSD minted would leave less than one threshold-sized buy under the cap.
  const nearCap = gated({}, short, { mintCap: e18(1_500), totalLiabilities: e18(100) })
  assert.match(gateAfterTopUp(nearCap, "tUSDC", 1000)!.verdict, /less than one threshold-sized buy would be left under the mint cap: the gate stays closed/)
  assert.equal(gateAfterTopUp(gated({}, short), "tUSDT", 5000), null) // another asset does not move the gate
  assert.equal(gateAfterTopUp(gated({}, { status: "inactive", reason: "not-deployed" }), "tUSDC", 5), null)
  assert.equal(gateAfterTopUp({ ...gated({}, short), reserve: null }, "tUSDC", 5), null)
  assert.equal(gateAfterTopUp(gated({}, { status: "open", reason: null }), "tUSDC", 5)?.verdict, "The gate is already open")
  assert.equal(
    gateAfterTopUp(gated({}, { status: "open", reason: null }, { mintCap: e18(1_500), totalLiabilities: e18(100) }), "tUSDC", 1000)?.verdict,
    "Leaves less than one threshold-sized buy under the mint cap: the gate would close",
  )
  assert.equal(gateAfterTopUp(gated({}, { reason: "buy-paused", available: null }), "tUSDC", 5000)?.verdict, "The gate stays closed: Buys are paused (Router, deposit or mint)")
})

test("overview: the gate card offers the buffer top-up to operators of a live reserve only", () => {
  const topUp = { walletAddress: A(0xee), onConnectWallet: noop, onPrepare: pending, onSend: pending }
  const withTopUp = page("overview", { overview: { snapshots, days: 30, onDaysChange: noop, topUp } })
  assert.match(withTopUp, /Top up the buffer/)
  assert.match(withTopUp, /Deposits from your operator wallet into the Reserve \(Reserve\.deposit\)/)
  assert.doesNotMatch(page("overview"), /Top up the buffer/)
  assert.doesNotMatch(page("overview", { hasAuth: false, overview: { snapshots, days: 30, onDaysChange: noop, topUp } }), /Top up the buffer/)
})

test("helpers: gate wording, pause list, mint headroom", () => {
  assert.deepEqual(gateText(reserve().gate), { status: "closed", label: "Closed", detail: "Buys are paused (Router, deposit or mint)" })
  assert.equal(gateText({ ...reserve().gate, status: "open", reason: null }).label, "Open")
  assert.equal(gateText({ ...reserve().gate, status: "inactive", reason: "not-deployed" }).status, "inactive")
  const rows = pauseRows(reserve().reserve!)
  assert.equal(rows.length, 8)
  assert.deepEqual(rows.filter((row) => row.paused).map((row) => row.label), ["Reserve deposit"])
  // processQueue's own switch (absent from older API builds = running) stops queue payouts.
  assert.deepEqual(pauseRows(reserve({ queuePaused: true }).reserve!).filter((row) => row.paused).map((row) => row.label), ["Reserve deposit", "Reserve processQueue"])
  assert.deepEqual([payoutsPaused(reserve().reserve), payoutsPaused(reserve({ queuePaused: true }).reserve), payoutsPaused(null)], [false, true, false])
  assert.equal(mintHeadroomUsd(reserve().reserve!), 8000)
})

test("the queue head is judged against the Reserve's whole balance, after its delay", () => {
  const [usdt, usdc] = queue.assets
  const assets = reserve().reserve!.assets
  // 50 tUSDT held < 99.9 owed: short by 49.9.
  assert.deepEqual(headVerdict(usdt, assets, NOW), { kind: "waiting-liquidity", shortBy: "49.9" })
  // Plenty of tUSDT, even though `available` (balance − queue) would read 0.
  assert.deepEqual(headVerdict(usdt, [{ ...assets[1], balance: "99900000" }], NOW), { kind: "payable" })
  assert.equal(headVerdict(usdc, assets, NOW).kind, "waiting-delay")
  assert.equal(headVerdict({ ...usdc, head: null }, assets, NOW).kind, "empty")
  assert.equal(headVerdict(usdt, [], NOW).kind, "unknown")
  // A paused Reserve or ArcoUSD (burn) makes processQueue revert, whatever the balance.
  assert.equal(headVerdict(usdt, [{ ...assets[1], balance: "99900000" }], NOW, true).kind, "paused")
})

test("axis labels are compact; the operator wallet sends a transaction the server already simulated", async () => {
  assert.deepEqual([usdCompact(950), usdCompact(12_500), usdCompact(28_530_000), usdCompact(1.2e9), usdCompact(-1500)], ["$950", "$12.5K", "$28.53M", "$1.2B", "-$1.5K"])
  const tx = { chainId: 91342, to: A(3) as `0x${string}`, value: "0x0", data: "0x01" as `0x${string}`, description: "processQueue" }
  const sent: unknown[] = []
  const clients = {
    publicClient: { estimateGas: async () => 21_000n },
    wallet: { sendTransaction: async (args: unknown) => (sent.push(args), `0x${"ab".repeat(32)}`) },
  }
  const ok = await sendPreparedTransactionWithClients(A(0xee) as `0x${string}`, { ...tx, simulation: { status: "simulated", reason: "eth_call at block 7: pays 2 request(s)" } }, clients as never)
  assert.equal(ok, `0x${"ab".repeat(32)}`)
  await assert.rejects(
    sendPreparedTransactionWithClients(A(0xee) as `0x${string}`, { ...tx, simulation: { status: "failed", reason: "FP: fn paused" } }, clients as never),
    /Backend simulation failed: FP: fn paused/,
  )
  assert.equal(sent.length, 1)
})

test("overview: totals, gate and its reason, pauses, assets, strategies, chart legend and contracts", () => {
  const html = page("overview")
  const body = text(html)
  for (const expected of [
    "Total backing $2,001",
    "ArcoUSD supply $2,000",
    "Surplus $1",
    "MMF allocation 40%",
    "target 50% · buffer floor 30%",
    "Closed Buys are paused (Router, deposit or mint)",
    "Room under the mint cap $8,000",
    "Reserve deposit",
    "Paused",
    "tUSDT 50",
    "0.1%",
    "umint $800 OK",
    "Total backing ArcoUSD supply", // chart legend
    "Router buys umint, ibenji",
  ]) {
    assert.ok(body.includes(expected), expected)
  }
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Overview</)
  assert.match(html, /role="tabpanel" aria-labelledby="arcousd-tab-overview"/)
  assert.match(body, /Live Block 123/)
})

test("overview: not deployed and unavailable say so", () => {
  const notDeployed = text(page("overview", { reserve: { ...reserve(), status: "not-deployed", contracts: null, reserve: null } }))
  assert.match(notDeployed, /ArcoUSD is not deployed yet\./)
  const unavailable = text(page("overview", { reserve: { ...reserve(), status: "unavailable", reserve: null } }))
  assert.match(unavailable, /could not read the reserve\. Fund buys are blocked/)
})

test("queue: per-asset verdicts and process controls, requests with T+2 marks", () => {
  const html = page("queue")
  const body = text(html)
  assert.match(body, /tUSDT Short 49\.9/)
  assert.match(body, /tUSDC In delay until/)
  assert.match(body, /Queued 2 · 199\.8 tUSDT/)
  assert.match(body, /Past T\+2 1/)
  assert.match(body, /Next to pay #4 · 99\.9 tUSDT/)
  assert.match(body, /#4 QUEUED Past T\+2 tUSDT 99\.9 \$0\.1/)
  assert.match(body, /Standard redemptions are paid in request order once they are 10m old and the Reserve holds the head's payout/)
  assert.equal((html.match(/>Preview</g) ?? []).length, 2)
  assert.equal((html.match(/>Sign &amp; send</g) ?? []).length, 2)
  // No wallet: the send button asks to connect first.
  const noWallet = page("queue", { queue: { queue, filter: "open", onFilterChange: noop, walletAddress: null, onConnectWallet: noop, onPrepare: pending, onSend: pending, now: NOW } })
  assert.equal((noWallet.match(/>Connect wallet</g) ?? []).length, 2)
})

test("queue and flows need an operator session; overview still shows the public reserve", () => {
  assert.match(text(page("queue", { hasAuth: false })), /Sign in as an operator to load this section\./)
  assert.match(text(page("overview", { hasAuth: false })), /Total backing \$2,001/)
})

test("flows: totals, the overlap note, per-asset and Router tables, recent events", () => {
  const body = text(page("flows"))
  for (const expected of [
    "the rows overlap and are not meant to be added up",
    "Deposits $1,500",
    "Redemptions paid $299.9",
    "1 instant · 1 from the queue",
    "Router buys $300",
    "Fees kept $1.3",
    "tUSDT $1,000",
    "ArcoUSD 1 $300",
    "Router buy Router",
    "Deposit Reserve tUSDT $1,000 $1",
  ]) {
    assert.ok(body.includes(expected), expected)
  }
})

test("ProcessQueueControl: preview is disabled for an empty queue or a bad batch", () => {
  const html = renderToStaticMarkup(
    <ProcessQueueControl symbol="tUSDC" disabled walletAddress={A(0xee)} onConnectWallet={noop} onPrepare={pending} onSend={pending} />,
  )
  assert.match(html, /<button[^>]*disabled=""[^>]*>Preview</)
  assert.match(html, /<button[^>]*disabled=""[^>]*>Sign &amp; send</) // nothing prepared yet
  assert.match(html, /aria-invalid="false"/)
})

// ── Alerts ─────────────────────────────────────────────────────────────────

const alert = (over: Partial<GiwaArcoUSDAlert>): GiwaArcoUSDAlert => ({
  key: "pauses",
  severity: "WARNING",
  status: "OPEN",
  title: "Paused: Router buy",
  detail: "Router buy: fund buys through the Router.",
  firstSeenAt: "2026-10-19T10:00:00.000Z",
  lastSeenAt: "2026-10-19T11:59:00.000Z",
  openedAt: "2026-10-19T10:00:00.000Z",
  resolvedAt: null,
  lastNotifiedAt: "2026-10-19T11:45:00.000Z",
  notifyCount: 1,
  deliveryErrors: [],
  ...over,
})

const alerts = (over: Partial<GiwaArcoUSDAlerts> = {}): GiwaArcoUSDAlerts => ({
  status: "live",
  channels: { telegram: true, slack: false },
  invalidSettings: [],
  intervalMs: 60_000,
  watcher: { lastRunAt: "2026-10-19T11:59:20.000Z", lastOkAt: "2026-10-19T11:59:20.000Z", lastError: null, stale: false },
  alerts: [
    alert({ key: "reserve:nav", severity: "CRITICAL", title: "MMF NAV unavailable", detail: "A strategy's NAV could not be read.", deliveryErrors: [{ channel: "slack", error: "Slack answered 404: no_service" }] }),
    alert({}),
    alert({ key: "indexer:lag", status: "PENDING", title: "ArcoUSD indexer behind", openedAt: null, lastNotifiedAt: null, firstSeenAt: "2026-10-19T11:57:00.000Z" }),
    alert({ key: "gate:closed", status: "RESOLVED", title: "Fund buys blocked", resolvedAt: "2026-10-19T11:00:00.000Z" }),
  ],
  ...over,
})

test("alert helpers: badges, ages, the watcher's pulse and delivery results", () => {
  assert.deepEqual(
    [alertBadge(alert({ severity: "CRITICAL" })), alertBadge(alert({})), alertBadge(alert({ status: "PENDING" })), alertBadge(alert({ status: "RESOLVED" }))],
    [
      { label: "Critical", tone: "negative" },
      { label: "Warning", tone: "attention" },
      { label: "Pending", tone: "neutral" },
      { label: "Resolved", tone: "positive" },
    ],
  )
  assert.deepEqual([agoText("2026-10-19T11:59:30.000Z", NOW), agoText("2026-10-19T09:55:00.000Z", NOW), agoText(null, NOW)], ["just now", "2h 5m ago", "—"])
  assert.equal(alertMeta(alert({}), NOW), "Open 2h 0m · last sent 15m ago")
  assert.equal(alertMeta(alert({ lastNotifiedAt: null }), NOW), "Open 2h 0m · not sent yet")
  assert.equal(alertMeta(alert({ status: "PENDING", firstSeenAt: "2026-10-19T11:57:00.000Z" }), NOW), "Seen 3m ago; sent only if it lasts")
  assert.equal(alertMeta(alert({ status: "RESOLVED", resolvedAt: "2026-10-19T11:00:00.000Z" }), NOW), "Resolved 1h 0m ago")

  assert.deepEqual(watcherStatus(alerts(), NOW), { tone: "positive", text: "The watcher ran just now." })
  assert.equal(watcherStatus(alerts({ watcher: null }), NOW).tone, "attention")
  assert.match(watcherStatus(alerts({ watcher: { lastRunAt: "2026-10-19T11:40:00.000Z", lastOkAt: null, lastError: null, stale: true } }), NOW).text, /last ran 20m ago\. The indexer worker may be down\./)
  assert.match(watcherStatus(alerts({ watcher: { lastRunAt: "2026-10-19T11:59:00.000Z", lastOkAt: null, lastError: "db down", stale: false } }), NOW).text, /last run failed 1m ago: db down/)
  const unreconciled = watcherStatus(alerts({ watcher: { lastRunAt: "2026-10-19T11:59:30.000Z", lastOkAt: null, lastError: null, stale: false, reconciled: false } }), NOW)
  assert.deepEqual([unreconciled.tone, /could not compare the queue with the chain/.test(unreconciled.text)], ["attention", true])

  assert.equal(deliveryText({ telegram: { ok: true, at: "" }, slack: { ok: false, at: "", error: "timed out" } }), "Telegram: sent · Slack: failed (timed out)")
  assert.equal(deliveryText({}), "No channel answered")
})

test("alerts card: open first, pending and resolved after, channel and send problems, test button", () => {
  const html = renderToStaticMarkup(<AlertsCard hasAuth alerts={alerts()} onTest={pending} now={NOW} />)
  const body = text(html)
  for (const expected of [
    "Alerts 2 open",
    "Sends to Telegram",
    "The watcher ran just now.",
    "Critical MMF NAV unavailable A strategy's NAV could not be read.",
    "Slack did not take the last send: Slack answered 404: no_service",
    "Warning Paused: Router buy",
    "Pending ArcoUSD indexer behind",
    "Seen 3m ago; sent only if it lasts",
    "Resolved Fund buys blocked Resolved 1h 0m ago",
  ]) {
    assert.ok(body.includes(expected), expected)
  }
  assert.ok(!body.includes("Fund buys blocked Router buy")) // a resolved alert drops its detail
  assert.match(html, /<button[^>]*>Send test alert</)
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Send test alert</)

  // No channel: recorded only, and the test button explains what to set.
  const quiet = renderToStaticMarkup(<AlertsCard hasAuth alerts={alerts({ channels: { telegram: false, slack: false }, alerts: [], invalidSettings: ["ARCOUSD_ALERT_SLACK_WEBHOOK_URL"] })} onTest={pending} now={NOW} />)
  const quietText = text(quiet)
  assert.match(quietText, /No channel configured: alerts are only recorded here/)
  assert.match(quietText, /Ignored invalid settings: ARCOUSD_ALERT_SLACK_WEBHOOK_URL/)
  assert.match(quietText, /Nothing open, pending or resolved in the last 24 hours\./)
  assert.match(quiet, /<button[^>]*disabled=""[^>]*>Send test alert</)

  // A stopped watcher is called out; without a session the card asks for one.
  assert.match(text(renderToStaticMarkup(<AlertsCard hasAuth alerts={alerts({ watcher: { lastRunAt: "2026-10-19T11:40:00.000Z", lastOkAt: null, lastError: null, stale: true } })} onTest={pending} now={NOW} />)), /The indexer worker may be down/)
  assert.match(text(renderToStaticMarkup(<AlertsCard hasAuth={false} alerts={null} onTest={pending} />)), /Sign in as an operator to load alerts\./)
  assert.match(text(renderToStaticMarkup(<AlertsCard hasAuth alerts={alerts({ status: "not-deployed", watcher: null, alerts: [] })} onTest={pending} />)), /ArcoUSD is not deployed: there is nothing to watch yet\./)

  // The card does not depend on the public reserve read: it stays when that read has nothing.
  const noReserve = text(page("overview", { reserve: null, overview: { snapshots, days: 30, onDaysChange: noop, alerts: { alerts: alerts(), onTest: pending, now: NOW } } }))
  assert.match(noReserve, /Alerts 2 open/)

  // On the overview it sits above the totals.
  const overview = text(page("overview", { overview: { snapshots, days: 30, onDaysChange: noop, alerts: { alerts: alerts(), onTest: pending, now: NOW } } }))
  assert.ok(overview.indexOf("Alerts 2 open") < overview.indexOf("Total backing"))
})

// ── Keeper bot ──────────────────────────────────────────────────────────────

const keeperReport = (over: Partial<GiwaArcoUSDKeeperReport> = {}): GiwaArcoUSDKeeperReport => ({
  mode: "live",
  address: A(0xee),
  intervalMs: 60_000,
  batch: 20,
  gasBalanceWei: "48500000000000000",
  lowGasWei: "10000000000000000",
  lowGas: false,
  canAffordTx: true,
  simulations: [
    { symbol: "tUSDC", paid: 3, error: null },
    { symbol: "tUSDT", paid: 0, error: null },
  ],
  lastTx: { hash: `0x${"cd".repeat(32)}`, symbol: "tUSDC", nonce: 12, sentAt: "2026-10-19T11:58:00.000Z", status: "success", paid: 3, blockNumber: "900", error: null },
  pending: null,
  note: "Sent 1 transaction",
  ...over,
})

const keeper = (report: GiwaArcoUSDKeeperReport | null, over: Partial<NonNullable<GiwaArcoUSDKeeper["keeper"]>> = {}): GiwaArcoUSDKeeper => ({
  status: "live",
  keeper: { lastRunAt: "2026-10-19T11:59:30.000Z", lastOkAt: "2026-10-19T11:59:30.000Z", lastError: null, stale: false, report, ...over },
})

test("keeper bot helpers: mode badge, gas with 4 decimals, simulations and transaction states", () => {
  assert.deepEqual(keeperBadge(null), { label: "Off", tone: "neutral" })
  assert.deepEqual(keeperBadge(keeper(keeperReport({ mode: "off" })).keeper), { label: "Off", tone: "neutral" })
  assert.deepEqual(keeperBadge(keeper(keeperReport()).keeper), { label: "Live", tone: "positive" })
  assert.deepEqual(keeperBadge(keeper(keeperReport({ mode: "dry-run" })).keeper), { label: "Dry run", tone: "attention" })
  assert.deepEqual(keeperBadge(keeper(keeperReport(), { stale: true }).keeper), { label: "Not running", tone: "negative" })
  assert.deepEqual(keeperBadge(keeper(keeperReport(), { lastError: "x", lastOkAt: "2026-10-19T11:45:00.000Z" }).keeper, NOW), { label: "Live · failing", tone: "negative" })
  assert.deepEqual([gasText("48500000000000000"), gasText("4200000000000"), gasText(null), gasText("x")], ["0.0485 ETH", "0 ETH", "—", "—"])
  assert.equal(simulationText(keeperReport()), "tUSDC would pay 3 requests · tUSDT nothing payable now")
  assert.equal(
    simulationText({ simulations: [{ symbol: "tUSDC", paid: 1, error: null }, { symbol: "tRLUSD", paid: null, error: "reverted" }, { symbol: "tUSDT", paid: 0, error: null, clearing: true }] }),
    "tUSDC would pay 1 request · tRLUSD failed: reverted · tUSDT would first step past cancelled or failed entries",
  )
  assert.equal(simulationText({ simulations: [] }), "No backlog to check")
  assert.equal(simulationText({ simulations: [], simulated: false }), "Not checked this round")
  // A failure right after a good round is "retrying"; ten minutes without one is "failing".
  assert.deepEqual(keeperBadge(keeper(keeperReport(), { lastError: "x", lastOkAt: "2026-10-19T11:58:00.000Z" }).keeper, NOW), { label: "Live · retrying", tone: "attention" })
  assert.deepEqual(keeperTxBadge("reverted"), { label: "Reverted", tone: "negative" })
})

test("keeper bot card: live, dry run, off, never run, and its trouble states", () => {
  const live = text(renderToStaticMarkup(<KeeperCard keeper={keeper(keeperReport())} now={NOW} />))
  assert.doesNotMatch(live, /Savings/) // a keeper from before Savings reports no distribute step
  for (const expected of ["Keeper bot Live", "Last run just now", "Gas 0.0485 ETH", "Now tUSDC would pay 3 requests · tUSDT nothing payable now", "Mined tUSDC · paid 3 · 2m ago", "Sent 1 transaction"]) {
    assert.ok(live.includes(expected), expected)
  }
  const holdingCard = text(renderToStaticMarkup(<KeeperCard keeper={keeper(keeperReport({ holdUntil: "2026-10-19T12:08:00.000Z", simulated: false }))} now={NOW} />))
  assert.match(holdingCard, /Now Not checked this round/)
  assert.match(holdingCard, /Holding until .* \(after a reverted transaction\)/)
  const dry = text(renderToStaticMarkup(<KeeperCard keeper={keeper(keeperReport({ mode: "dry-run", lastTx: null, note: "Dry run: would pay tUSDC" }))} now={NOW} />))
  assert.match(dry, /Keeper bot Dry run/)
  assert.doesNotMatch(dry, /Gas/) // a dry run spends nothing
  assert.match(dry, /Last transaction —/)
  assert.match(text(renderToStaticMarkup(<KeeperCard keeper={keeper(keeperReport({ mode: "off" }))} now={NOW} />)), /The keeper bot is off\. Pay the queue with Preview and Sign (&amp;|&) send below, and distribute Savings yield from the Savings tab\./)
  assert.match(text(renderToStaticMarkup(<KeeperCard keeper={{ status: "live", keeper: null }} now={NOW} />)), /has not run yet/)

  const trouble = renderToStaticMarkup(
    <KeeperCard
      keeper={keeper(keeperReport({ lowGas: true, gasBalanceWei: "4200000000000000", pending: { hash: null, nonce: 13, since: "2026-10-19T11:45:00.000Z", stuck: true } }), {
        stale: true,
        lastRunAt: "2026-10-19T11:50:00.000Z",
        lastError: "Send failed: nonce too low",
      })}
      now={NOW}
    />,
  )
  const troubleText = text(trouble)
  for (const expected of ["Keeper bot Not running", "Last run 10m ago (not running)", "Gas 0.0042 ETH (low)", "Waiting on nonce 13 for 15m (stuck)", "Send failed: nonce too low"]) {
    assert.ok(troubleText.includes(expected), expected)
  }

  // On the Queue tab it sits above the per-asset cards.
  const queuePage = text(page("queue", { queue: { queue, filter: "open", onFilterChange: noop, walletAddress: A(0xee), onConnectWallet: noop, onPrepare: pending, onSend: pending, now: NOW, keeper: { keeper: keeper(keeperReport()) } } }))
  assert.ok(queuePage.indexOf("Keeper bot") < queuePage.indexOf("Standard redemptions are paid"))
})

test("keeper bot: its Savings step in words, a distribute transaction, and a distribute hold", () => {
  const step = (state: NonNullable<GiwaArcoUSDKeeperReport["distribute"]>["state"], over: Partial<NonNullable<GiwaArcoUSDKeeperReport["distribute"]>> = {}) => ({
    state,
    nextAt: "2026-10-20T11:00:00.000Z",
    amountUsd: "12.345678",
    detail: null,
    ...over,
  })
  assert.equal(keeperDistributeText(null, NOW), "Not checked this round")
  assert.equal(keeperDistributeText(step("waiting"), NOW), "Due in 23h 0m · $12.35 accrued")
  assert.equal(keeperDistributeText(step("off", { detail: "x" }), NOW), "Off (ARCOUSD_KEEPER_DISTRIBUTE=off): distribute from the Savings tab")
  assert.equal(keeperDistributeText(step("not-deployed"), NOW), "Savings is not deployed")
  assert.equal(keeperDistributeText(step("nothing"), NOW), "Due, nothing to distribute now (under $0.01)")
  assert.equal(keeperDistributeText(step("ready", { detail: "Dry run: would distribute" }), NOW), "Dry run: would distribute: $12.35")
  assert.equal(keeperDistributeText(step("sent", { detail: "Distributed", amountUsd: "7.99" }), NOW), "Distributed $7.99")
  assert.equal(keeperDistributeText(step("sent", { detail: "Sent; waiting for the receipt" }), NOW), "Sent; waiting for the receipt ($12.35)")
  assert.equal(keeperDistributeText(step("reverts", { detail: "Pausable: paused" }), NOW), "distribute() would revert: Pausable: paused")
  assert.equal(keeperDistributeText(step("error", { detail: "preview() could not be read: HTTP 503" }), NOW), "Could not check: preview() could not be read: HTTP 503")

  const distributeTx = { hash: `0x${"ab".repeat(32)}`, action: "distribute" as const, symbol: "sArcoUSD", nonce: 13, sentAt: "2026-10-19T11:58:00.000Z", status: "success" as const, paid: null, amountUsd: "7.99", blockNumber: "901", error: null }
  assert.equal(keeperTxText(distributeTx), "distribute · $7.99")
  assert.equal(keeperTxText({ ...distributeTx, amountUsd: null }), "distribute")
  assert.equal(keeperTxText(keeperReport().lastTx!), "tUSDC · paid 3")

  const card = text(
    renderToStaticMarkup(
      <KeeperCard
        keeper={keeper(keeperReport({ lastTx: distributeTx, distribute: step("ready", { detail: "Held after a reverted distribute()" }), distributeHoldUntil: "2026-10-19T12:08:00.000Z" }))}
        now={NOW}
      />,
    ),
  )
  for (const expected of ["Savings Held after a reverted distribute(): $12.35", "Mined distribute · $7.99 · 2m ago"]) assert.ok(card.includes(expected), expected)
  assert.match(card, /Savings held until .* \(after a reverted distribute\(\)\)/)
  const failing = renderToStaticMarkup(<KeeperCard keeper={keeper(keeperReport({ distribute: step("error", { detail: "socket hang up" }) }))} now={NOW} />)
  assert.match(text(failing), /Savings Could not check: socket hang up/)
})

// ─────────────────────────────── Savings ───────────────────────────────

const SAVINGS_NOW = Date.parse("2026-10-21T12:00:00.000Z")

function savingsState(over: Partial<GiwaArcoUSDSavingsState> = {}, distributor: Partial<GiwaArcoUSDSavingsState["distributor"]> = {}): GiwaArcoUSDSavingsState {
  const base: GiwaArcoUSDSavingsState = {
    blockNumber: "900",
    totalAssets: (10_000n * 10n ** 18n).toString(),
    totalAssetsUsd: "10000",
    totalSupply: (9_990n * 10n ** 18n).toString(),
    sharePrice: "1001001001001001001",
    sharePriceHuman: "1.001001001001001001",
    unvested: (3n * 10n ** 18n).toString(),
    unvestedUsd: "3",
    vestingAmount: (6n * 10n ** 18n).toString(),
    vestingPeriodSeconds: 86_400,
    vestingStartedAt: "2026-10-21T00:00:00.000Z",
    vestingEndsAt: "2026-10-22T00:00:00.000Z",
    rewardRate: ((6n * 10n ** 18n) / 86_400n).toString(),
    currentAprBps: 2189,
    currentApyBps: 2447,
    seeded: true,
    vaultPaused: false,
    depositPaused: false,
    withdrawPaused: false,
    rewardsPaused: false,
    depositsOpen: true,
    withdrawalsOpen: true,
    distributor: {
      paused: false,
      reservePaused: false,
      arcoUSDMintPaused: false,
      minIntervalSeconds: 86_400,
      maxAprBps: 2000,
      reserveMarginBps: 50,
      lastDistributionAt: "2026-10-20T11:00:00.000Z",
      nextDistributionAt: "2026-10-21T11:00:00.000Z",
      preview: { amount: (5n * 10n ** 18n).toString(), amountUsd: "5", surplus: (40n * 10n ** 18n).toString(), rateCap: (5n * 10n ** 18n).toString(), mintHeadroom: (10n ** 24n).toString(), navOk: true },
      ...distributor,
    },
  }
  return { ...base, ...over }
}

function savingsResponse(state: GiwaArcoUSDSavingsState | null = savingsState(), status: GiwaArcoUSDSavings["status"] = "live"): GiwaArcoUSDSavings {
  return {
    status,
    chainId: 91342,
    contracts: status === "not-deployed" ? null : { sArcoUSD: A(0x51), distributor: A(0x52), zap: A(0x53), arcoUSD: A(0x01), reserve: A(0x02) },
    readAt: "2026-10-21T12:00:00.000Z",
    savings: state,
  }
}

const savingsHistory: GiwaArcoUSDSavingsHistory = {
  status: "live",
  chainId: 91342,
  days: 30,
  total: 2,
  sampled: false,
  truncated: false,
  points: [
    { takenAt: "2026-10-19T12:00:00.000Z", blockNumber: "800", sharePrice: "1", totalAssetsUsd: "9000", aprBps: 1800 },
    { takenAt: "2026-10-21T12:00:00.000Z", blockNumber: "900", sharePrice: "1.001", totalAssetsUsd: "10000", aprBps: 2189 },
  ],
  realizedApyBps: 2002,
}

const savingsActivity: GiwaArcoUSDSavingsAdmin = {
  status: "live",
  days: 30,
  contracts: { sArcoUSD: A(0x51), distributor: A(0x52), zap: A(0x53) },
  totals: { depositsUsd: "10000", deposits: 3, withdrawalsUsd: "250", withdrawals: 1, distributedUsd: "12", distributions: 2, toppedUpUsd: "1" },
  daily: [],
  distributions: [{ at: "2026-10-20T11:00:00.000Z", txHash: `0x${"dd".repeat(32)}`, caller: A(0x77), amountUsd: "6", surplusUsd: "40", rateCapUsd: "6", backingUsd: "10050", liabilitiesUsd: "10000" }],
  rewards: [
    { at: "2026-10-20T11:00:00.000Z", txHash: `0x${"dd".repeat(32)}`, caller: A(0x52), amountUsd: "6", fromDistributor: true },
    { at: "2026-10-19T09:00:00.000Z", txHash: `0x${"ee".repeat(32)}`, caller: A(0x99), amountUsd: "1", fromDistributor: false },
  ],
  activity: [
    { at: "2026-10-21T10:00:00.000Z", txHash: `0x${"11".repeat(32)}`, kind: "withdraw", account: A(0xa1), sender: A(0x53), amountUsd: "250", viaZap: true },
    { at: "2026-10-19T08:00:00.000Z", txHash: `0x${"22".repeat(32)}`, kind: "seed", account: "0x000000000000000000000000000000000000dead", sender: A(0x99), amountUsd: "1", viaZap: false },
  ],
  zapAssets: [{ asset: A(0xc1), symbol: "tUSDC", deposits: 2, depositAmount: "9000", redemptions: 1, redeemAmount: "249.5" }],
  truncated: false,
}

function savingsPage(over: Partial<Record<string, unknown>> = {}) {
  return page("savings", {
    savings: {
      savings: savingsResponse(),
      history: savingsHistory,
      activity: savingsActivity,
      days: 30,
      onDaysChange: noop,
      walletAddress: A(0xee),
      onConnectWallet: noop,
      onPrepareDistribute: pending,
      onSendDistribute: pending,
      now: SAVINGS_NOW,
      ...over,
    },
  })
}

test("savings helpers: share price to 4 decimals, rewards per day, switches, the Savings tab", () => {
  assert.deepEqual([sharePriceText("1"), sharePriceText("1.001001001"), sharePriceText(1.23456), sharePriceText(null)], ["1.00", "1.001", "1.2346", "—"])
  assert.equal(Math.round(rewardsPerDayUsd(savingsState())! * 1e6) / 1e6, 6)
  assert.deepEqual(
    savingsPauseRows(savingsState({ withdrawPaused: true }, { paused: true, reservePaused: true })).filter((row) => row.paused).map((row) => row.label),
    ["sArcoUSD withdraw", "Distributor", "Reserve (all)"],
  )
  assert.equal(savingsPauseRows(savingsState({ seeded: false }))[0].effect, "Deposits and mints (closed until the seed)")
  assert.deepEqual([arcoUSDAdminTab("savings"), ARCOUSD_ADMIN_TABS.map((item) => item.id)], ["savings", ["overview", "queue", "flows", "savings"]])
})

test("distribution verdict: paused, unreadable, NAV, waiting, nothing (and why), ready", () => {
  const verdict = (state: GiwaArcoUSDSavingsState, now = SAVINGS_NOW) => distributionVerdict(state, now)
  assert.deepEqual(verdict(savingsState()), { kind: "ready", amountUsd: "5" })
  assert.deepEqual(verdict(savingsState({}, { paused: true })), { kind: "paused", what: "The distributor" })
  assert.deepEqual(verdict(savingsState({}, { reservePaused: true })), { kind: "paused", what: "The Reserve" })
  assert.deepEqual(verdict(savingsState({ rewardsPaused: true })), { kind: "paused", what: "sArcoUSD addRewards" })
  assert.deepEqual(verdict(savingsState({ vaultPaused: true })), { kind: "paused", what: "sArcoUSD" })
  assert.deepEqual(verdict(savingsState({}, { arcoUSDMintPaused: true })), { kind: "paused", what: "ArcoUSD mint" })
  assert.deepEqual(verdict(savingsState({}, { preview: null, previewError: "preview-unreadable" })), { kind: "unknown", error: "The distributor preview could not be read (see the API log)" })
  assert.deepEqual(verdict(savingsState({}, { preview: { ...savingsState().distributor.preview!, navOk: false } })), { kind: "nav" })
  assert.deepEqual(verdict(savingsState(), Date.parse("2026-10-21T10:00:00.000Z")), { kind: "waiting", until: "2026-10-21T11:00:00.000Z" })
  assert.deepEqual(verdict(savingsState({ seeded: false })), { kind: "nothing", why: "No savers yet (the vault is not seeded)" })
  const zeroWith = (field: "surplus" | "rateCap" | "mintHeadroom") =>
    verdict(savingsState({}, { preview: { ...savingsState().distributor.preview!, amount: "0", amountUsd: "0", [field]: "0" } }))
  assert.deepEqual(zeroWith("mintHeadroom"), { kind: "nothing", why: "The Reserve mint cap is reached" })
  assert.deepEqual(zeroWith("surplus"), { kind: "nothing", why: "No Reserve surplus above the margin" })
  assert.deepEqual(zeroWith("rateCap"), { kind: "nothing", why: "Nothing saved long enough to earn yet" })
})

test("savings tab: totals, distribution with its verdict, vesting, switches, chart, activity and contracts", () => {
  const html = savingsPage()
  const plain = text(html)
  assert.match(html, /aria-selected="true"[^>]*>Savings</)
  for (const expected of [
    /Saved \$10,000/,
    /Share price 1\.001 ArcoUSD per sArcoUSD/,
    /APY now 24\.47% APR 21\.89% of what is vesting, compounded daily/,
    /Realized APY \(30d\) 20\.02%/,
    /Distribution Ready distribute\(\) would mint \$5 into sArcoUSD now\./,
    /Reserve surplus above the margin \$40/,
    /APR cap since the last distribution \$5/,
    /Rules every 1d · cap 20% APR · margin 0\.5%/,
    /Last distribution \(or deploy\) 1d 1h ago/,
    /Still vesting \$3/,
    /Released per day now \$6/,
    /Seed \(1 sArcoUSD for 0x…dEaD\) Done/,
    /Deposits Open/,
    /Share price \(ArcoUSD\)/,
    /Deposits \(30d\) \$10,000 3 deposits/,
    /Operator top-ups \(30d\) \$1/,
    /Top-up by 0x0000…0099/,
    /Withdrawal .* \$250 Zap/,
    /Seed .* \$1 Direct/,
    /tUSDC 2 9,000 1 249\.5/,
    /Savings Zap 0x0000…0053/,
  ]) {
    assert.match(plain, expected)
  }
  assert.ok(!/Deposits are closed until/.test(plain))
})

test("savings tab: not deployed, unseeded, a waiting distributor and an unreadable activity view", () => {
  assert.match(text(savingsPage({ savings: savingsResponse(null, "not-deployed") })), /Savings is not deployed yet\./)
  const unseeded = text(savingsPage({ savings: savingsResponse(savingsState({ seeded: false, depositsOpen: false, depositPaused: true })) }))
  assert.match(unseeded, /Deposits are closed until sArcoUSD\.seed\(\) runs\./)
  assert.match(unseeded, /Nothing to distribute No savers yet/)
  const waiting = savingsPage({ now: Date.parse("2026-10-21T10:00:00.000Z") })
  assert.match(text(waiting), /Next at .* The interval since the last distribution has not passed yet\./)
  // Preview stays disabled until the distributor is ready.
  assert.match(waiting, /<button type="button" disabled="" class="[^"]*">Preview<\/button>/)
  assert.match(text(savingsPage({ activity: { ...savingsActivity, status: "unavailable", error: "Event read failed: db down" } })), /Savings activity is unavailable: Event read failed: db down/)
  // Ready by the numbers, but the vault's addRewards is paused: distribute() would revert.
  const paused = text(savingsPage({ savings: savingsResponse(savingsState({ rewardsPaused: true })) }))
  assert.match(paused, /Distribution Paused sArcoUSD addRewards is paused, so distribute\(\) would revert\./)
  assert.match(text(savingsPage({ savings: savingsResponse(null, "unavailable") })), /The API could not read the Savings contracts\./)
  assert.match(text(savingsPage({ history: { ...savingsHistory, points: [], realizedApyBps: null } })), /needs a day of share price history .* No snapshots in this window yet/)
})
