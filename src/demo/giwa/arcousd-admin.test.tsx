import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ArcoUSDAdminView, ProcessQueueControl } from "./AdminArcoUSD"
import { sendPreparedTransactionWithClients } from "./contracts"
import {
  amountText,
  arcoUSDAdminTab,
  batchSize,
  bpsText,
  countText,
  durationText,
  gateText,
  headVerdict,
  mintHeadroomUsd,
  pauseRows,
  queueFilter,
  usdCompact,
  usdText,
} from "./arcousd-admin"
import type { GiwaArcoUSDFlows, GiwaArcoUSDQueue, GiwaArcoUSDReserve, GiwaArcoUSDSnapshots } from "./types"

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

function page(tab: "overview" | "queue" | "flows", over: Record<string, unknown> = {}) {
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

test("helpers: gate wording, pause list, mint headroom", () => {
  assert.deepEqual(gateText(reserve().gate), { status: "closed", label: "Closed", detail: "Buys are paused (Router, deposit or mint)" })
  assert.equal(gateText({ ...reserve().gate, status: "open", reason: null }).label, "Open")
  assert.equal(gateText({ ...reserve().gate, status: "inactive", reason: "not-deployed" }).status, "inactive")
  const rows = pauseRows(reserve().reserve!)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows.filter((row) => row.paused).map((row) => row.label), ["Reserve deposit"])
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
