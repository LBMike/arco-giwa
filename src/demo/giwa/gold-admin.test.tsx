import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GoldAdminView } from "./AdminGold"
import {
  bpsPercentText,
  goldApyText,
  goldCover,
  goldHeadline,
  goldLiquidity,
  goldReservePauseRows,
  goldVaultPauseRows,
  mintHeadroomOunces,
  ounceSourceLabel,
  ouncesLabel,
  ouncesText,
  sharePercentText,
  waitText,
} from "./gold-admin"
import type { GiwaArcoGoldReserve, GiwaArcoGoldSavings } from "./types"
import { VAULT_TABS } from "../../admin/console-model"

const VAULT = {
  blockNumber: "41760000",
  totalAssets: "12500000000000000000",
  totalAssetsOunces: "12.5",
  totalSupply: "12400000000000000000",
  sharePrice: "1008064516129032258",
  sharePriceHuman: "1.008064516129032258",
  seeded: true,
  vaultPaused: false,
  depositPaused: false,
  withdrawPaused: false,
  depositsOpen: true,
  withdrawalsOpen: true,
}

function savings(over: Partial<GiwaArcoGoldSavings> = {}, vault: Partial<typeof VAULT> = {}): GiwaArcoGoldSavings {
  return {
    status: "live",
    chainId: 91342,
    contracts: { arcoGOLD: "0x1111111111111111111111111111111111111111", zap: "0x2222222222222222222222222222222222222222", unit: "0x3333333333333333333333333333333333333333", reserve: "0x4444444444444444444444444444444444444444" },
    readAt: "2026-11-20T08:00:00.000Z",
    savings: { ...VAULT, ...vault },
    apyPercent: 4,
    ounceUsd: 4000,
    ounceUsdSource: "coingecko:pax-gold",
    sharePriceUsd: 4032.26,
    totalAssetsUsd: "50000",
    ...over,
  }
}

function reserve(over: Partial<NonNullable<GiwaArcoGoldReserve["reserve"]>> = {}): GiwaArcoGoldReserve {
  return {
    status: "live",
    chainId: 91342,
    contracts: { unit: "0x3333333333333333333333333333333333333333", reserve: "0x4444444444444444444444444444444444444444", lens: "0x5555555555555555555555555555555555555555" },
    readAt: "2026-11-20T08:00:00.000Z",
    reserve: {
      blockNumber: "41760000",
      totalBacking: "13000000000000000000",
      totalLiabilities: "12500000000000000000",
      totalBackingOunces: "13",
      totalLiabilitiesOunces: "12.5",
      reservePaused: false,
      depositPaused: false,
      redeemPaused: false,
      redeemInstantOnlyPaused: false,
      arcoUSDPaused: false,
      arcoUSDMintPaused: false,
      arcoUSDBurnPaused: false,
      settlementPaused: false,
      queuePaused: false,
      mmfBps: 0,
      mmfTargetBps: 0,
      bufferFloorBps: 10000,
      queueMinDelay: 600,
      mintCap: "100000000000000000000000",
      assets: [
        {
          symbol: "tXAUT",
          address: "0x6666666666666666666666666666666666666666",
          decimals: 6,
          depositEnabled: true,
          redeemEnabled: true,
          instantFeeBps: 10,
          swapFeeBps: 0,
          balance: "13000000",
          queued: "500000",
          available: "12500000",
          balanceHuman: "13",
          queuedHuman: "0.5",
          availableHuman: "12.50834",
          queueLength: 2,
          queueHead: 1,
          queueBacklog: 1,
        },
      ],
      ...over,
    },
  }
}

test("gold admin: ounces show up to 4 decimals with no forced trailing zeros", () => {
  assert.equal(ouncesText("12.5"), "12.5")
  assert.equal(ouncesText("0.00834999"), "0.0083")
  assert.equal(ouncesText("1234.56789"), "1,234.5679")
  assert.equal(ouncesText(7), "7")
  assert.equal(ouncesText(null), "—")
  assert.equal(ouncesText("abc"), "—")
  assert.equal(ouncesLabel("0.5"), "0.5 oz")
  assert.equal(ouncesLabel(undefined), "—")
})

test("gold admin: display rate and ounce source read in words", () => {
  assert.equal(goldApyText(4), "4%")
  assert.equal(goldApyText(4.256), "4.26%")
  assert.equal(goldApyText(null), "Not set")
  assert.equal(ounceSourceLabel("coingecko:pax-gold"), "PAX Gold on CoinGecko")
  assert.equal(ounceSourceLabel("kraken:paxg"), "PAX Gold on Kraken (fallback)")
  assert.equal(ounceSourceLabel(""), "—")
})

test("gold admin: cover is backing less what is owed", () => {
  assert.deepEqual(goldCover({ totalBackingOunces: "13", totalLiabilitiesOunces: "12.5" }), { surplusOunces: 0.5, covered: true })
  assert.deepEqual(goldCover({ totalBackingOunces: "12", totalLiabilitiesOunces: "12" }), { surplusOunces: 0, covered: true })
  assert.equal(goldCover({ totalBackingOunces: "11", totalLiabilitiesOunces: "12" })?.covered, false)
  assert.equal(goldCover({ totalBackingOunces: "x", totalLiabilitiesOunces: "12" }), null)
})

test("gold admin: headline says whether deposits and withdrawals are open", () => {
  assert.equal(goldHeadline(null).label, "Loading")
  assert.equal(goldHeadline(savings({ status: "not-deployed", savings: null })).label, "Not deployed")
  assert.equal(goldHeadline(savings({ status: "unavailable", savings: null })).label, "Unavailable")
  assert.equal(goldHeadline(savings()).label, "Open")
  assert.equal(goldHeadline(savings({}, { seeded: false, depositsOpen: false })).label, "Not seeded")
  assert.equal(goldHeadline(savings({}, { depositsOpen: false })).label, "Deposits paused")
  assert.equal(goldHeadline(savings({}, { withdrawalsOpen: false })).label, "Withdrawals paused")
  assert.equal(goldHeadline(savings({}, { depositsOpen: false, withdrawalsOpen: false })).label, "Paused")
})

test("gold admin: pause lists carry each switch", () => {
  const vaultRows = goldVaultPauseRows({ ...VAULT, withdrawPaused: true })
  assert.deepEqual(vaultRows.map((row) => [row.label, row.paused]), [
    ["ArcoGOLD deposit", false],
    ["ArcoGOLD withdraw", true],
    ["ArcoGOLD (all)", false],
  ])
  const reserveRows = goldReservePauseRows({ ...reserve().reserve!, redeemInstantOnlyPaused: true, arcoUSDMintPaused: true })
  assert.equal(reserveRows.length, 9)
  assert.deepEqual(reserveRows.filter((row) => row.paused).map((row) => row.label), ["Reserve instant redeem", "ArcoXAU mint"])
})

test("gold admin: the page shows totals, cover, coins and contracts", () => {
  const html = renderToStaticMarkup(<GoldAdminView savings={savings()} reserve={reserve()} />)
  assert.match(html, /Admin · Gold/)
  assert.match(html, /Deposits and withdrawals are open/)
  assert.match(html, /12\.5 oz/)
  assert.match(html, /\$50,000 at the ounce price/)
  assert.match(html, /1\.0081 oz/)
  assert.match(html, /\$4,000/)
  assert.match(html, /PAX Gold on CoinGecko/)
  assert.match(html, /Fully backed/)
  assert.match(html, /tXAUT/)
  assert.match(html, /12\.5083/)
  assert.match(html, /0\.1%/)
  assert.match(html, /0x1111…1111/)
  assert.match(html, /0x5555…5555/)
  assert.doesNotMatch(html, /<button/)
})

test("gold admin: an under-backed reserve and a paused vault are called out", () => {
  const html = renderToStaticMarkup(
    <GoldAdminView
      savings={savings({}, { withdrawPaused: true, withdrawalsOpen: false })}
      reserve={reserve({ totalBackingOunces: "12", totalLiabilitiesOunces: "12.5" })}
    />,
  )
  assert.match(html, /Withdrawals paused/)
  assert.match(html, /Under-backed/)
  assert.match(html, /-0\.5 oz/)
  assert.match(html, /Paused/)
})

test("gold admin: not deployed and failed reads say so instead of showing zeros", () => {
  const html = renderToStaticMarkup(
    <GoldAdminView
      savings={savings({ status: "not-deployed", savings: null, contracts: null, ounceUsd: null, sharePriceUsd: null, totalAssetsUsd: null, apyPercent: null })}
      reserve={null}
      reserveError="Request failed"
    />,
  )
  assert.match(html, /Not deployed/)
  assert.match(html, /The gold Reserve could not be loaded: Request failed/)
  assert.match(html, /No price from the rate source/)
  assert.doesNotMatch(html, /0 oz/)
})

test("gold admin: the console menu lists Gold after ArcoUSD", () => {
  const ids = VAULT_TABS.map((tab) => tab.id)
  assert.equal(ids.indexOf("gold"), ids.indexOf("arcousd") + 1)
  assert.equal(VAULT_TABS.find((tab) => tab.id === "gold")?.path, "/vaults/gold")
})

test("gold admin: liquidity splits the backing into buffer and strategies", () => {
  const state = reserve().reserve!
  const all = goldLiquidity(state)
  assert.equal(all.bufferOunces, 13)
  assert.equal(all.queuedOunces, 0.5)
  assert.equal(all.instantOunces, 12.50834)
  assert.equal(all.deployedOunces, 0)
  assert.equal(all.bufferPercent, 100)
  assert.equal(all.deployedPercent, 0)
  const partly = goldLiquidity({ ...state, totalBackingOunces: "20" })
  assert.equal(partly.deployedOunces, 7)
  assert.equal(partly.bufferPercent, 65)
  assert.equal(partly.deployedPercent, 35)
  const empty = goldLiquidity({ totalBackingOunces: "0", assets: [] })
  assert.equal(empty.bufferPercent, null)
  assert.equal(empty.instantOunces, 0)
})

test("gold admin: shares, waits and mint headroom read plainly", () => {
  assert.equal(sharePercentText(100), "100%")
  assert.equal(sharePercentText(62.456), "62.46%")
  assert.equal(sharePercentText(null), "—")
  assert.equal(bpsPercentText(10000), "100%")
  assert.equal(bpsPercentText(250), "2.5%")
  assert.equal(bpsPercentText(undefined), "—")
  assert.equal(waitText(600), "10 minutes")
  assert.equal(waitText(60), "1 minute")
  assert.equal(waitText(45), "45 seconds")
  assert.equal(waitText(5400), "1.5 hours")
  assert.equal(waitText(172800), "2 days")
  assert.equal(waitText(undefined), "—")
  assert.equal(mintHeadroomOunces({ mintCap: "100000000000000000000000", totalLiabilities: "12500000000000000000" }), 99987.5)
  assert.equal(mintHeadroomOunces({ mintCap: "1000000000000000000", totalLiabilities: "2000000000000000000" }), 0)
  assert.equal(mintHeadroomOunces({ totalLiabilities: "2000000000000000000" }), null)
})

test("gold admin: the Liquidity card shows instant liquidity, buffer, strategies and the limits", () => {
  const html = renderToStaticMarkup(<GoldAdminView savings={savings()} reserve={reserve()} />)
  assert.match(html, /Liquidity/)
  assert.match(html, /12\.5083 oz/)
  assert.match(html, /\$50,033\.36 payable at once/)
  assert.match(html, /100% of the backing/)
  assert.match(html, /0% of the backing/)
  assert.match(html, /Buffer 100%, strategies 0%/)
  assert.match(html, /Owed to the Standard queue/)
  assert.match(html, /10 minutes/)
  assert.match(html, /99,987\.5 oz/)
  assert.match(html, /Instant liquidity<\/th>/)
  assert.doesNotMatch(html, />Available</)
  assert.doesNotMatch(html, /<button/)
})

test("gold admin: an older server without the liquidity fields shows dashes, not zeros", () => {
  const state = reserve().reserve!
  const { mmfBps, mmfTargetBps, bufferFloorBps, queueMinDelay, mintCap, settlementPaused, queuePaused, ...older } = state
  void [mmfBps, mmfTargetBps, bufferFloorBps, queueMinDelay, mintCap, settlementPaused, queuePaused]
  const html = renderToStaticMarkup(<GoldAdminView savings={savings()} reserve={{ ...reserve(), reserve: older }} />)
  assert.match(html, /Buffer floor<\/dt><dd[^>]*>—</)
  assert.equal(goldReservePauseRows(older).length, 7)
})
