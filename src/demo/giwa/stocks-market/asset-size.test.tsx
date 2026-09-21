import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StaticRouter } from "react-router-dom"
import { assetSize } from "./display"
import { fixtureTop40Profile, fixtureTop40Quote, fixtureTop40Catalog, FIXTURE_TIME } from "./fixtures"
import type { Envelope } from "./contracts"
import { parseProfile } from "./validate"
import { StocksMarketTable } from "./StocksMarketTable"
import { StatisticsCard } from "./MarketDetail"
import { profile as normalizeProfile } from "../../../../server/src/stocks-market-data/normalize"
import { parseExactJson } from "../../../../server/src/stocks-market-data/exact-json"

function fixtureEnvelope<T>(data: T): Envelope<T> { return { status: "AVAILABLE", reason: null, fetchedAt: FIXTURE_TIME, cacheAgeMs: 0, feedDelay: "UNKNOWN", data } }

const profile = { ...fixtureTop40Profile("SOXL"), sharesOutstanding: "175700060" }
const quote = { ...fixtureTop40Quote("SOXL"), price: "123.67" }

test("ETF proxy uses share-class units exactly and preserves reported AUM separately", () => {
  const size = assetSize(true, profile, quote)
  assert.equal(size.value, "21728826420.2")
  assert.equal(size.label, "추정 AUM")
  assert.match(size.title, /기준일 미제공/)
  assert.match(size.title, new RegExp(quote.sourceTimestamp!))
  assert.equal(assetSize(true, { ...profile, sharesOutstanding: "9007199254740993.5" }, { ...quote, price: "0.1" }).value, "900719925474099.35")
  assert.equal(assetSize(true, { ...profile, aum: "12" }, quote).value, "12")
  assert.equal(assetSize(true, { ...profile, aum: "0" }, quote).estimated, false)
  assert.equal(assetSize(false, { ...profile, marketCap: "99" }, quote).value, "99")
})

test("missing, zero, mismatched or unavailable inputs never fabricate an AUM", () => {
  for (const sharesOutstanding of [undefined, null, "0"]) assert.equal(assetSize(true, { ...profile, sharesOutstanding }, quote).value, null)
  for (const q of [null, { ...quote, price: null }, { ...quote, price: "0" }, { ...quote, symbol: "MU" }, { ...quote, sourceTimestamp: null }, { ...quote, status: "UNAVAILABLE" as const }]) assert.equal(assetSize(true, profile, q).value, null)
  const stale = assetSize(true, profile, { ...quote, status: "STALE" })
  assert.equal(stale.value, "21728826420.2")
  assert.match(stale.title, /마지막 확인 가격/)
})

test("share-class outstanding units survive server and client validation without weighted substitution", () => {
  const raw = '{"status":"OK","results":{"ticker":"SOXL","locale":"us","market":"stocks","currency_name":"usd","name":"SOXL","type":"ETF","share_class_shares_outstanding":9007199254740993.5,"weighted_shares_outstanding":123}}'
  const parsed = normalizeProfile(parseExactJson(raw), "SOXL").profile
  assert.equal(parsed.sharesOutstanding, "9007199254740993.5")
  assert.equal(parseProfile(parsed, "SOXL", "https://fixture.invalid").sharesOutstanding, "9007199254740993.5")
  assert.equal(normalizeProfile(parseExactJson(raw.replace('"share_class_shares_outstanding":9007199254740993.5,', '')), "SOXL").profile.sharesOutstanding, null)
  assert.throws(() => normalizeProfile(parseExactJson(raw.replace('9007199254740993.5', '-1')), "SOXL"))
  assert.throws(() => parseProfile({ ...parsed, sharesOutstanding: "-1" }, "SOXL", "https://fixture.invalid"))
})

test("both list variants and ETF detail visibly label the computed value", () => {
  const quotes = { phase: "ready" as const, value: fixtureEnvelope([quote]) }
  for (const variant of ["full", "home"] as const) {
    const html = renderToStaticMarkup(<StaticRouter location="/stocks"><StocksMarketTable catalog={fixtureTop40Catalog()} quotes={quotes} capabilities={{ phase: "loading" }} series={{}} profiles={{ SOXL: profile }} variant={variant} /></StaticRouter>)
    assert.match(html, /\$21\.73B/)
    assert.match(html, />추정 AUM</)
  }
  const html = renderToStaticMarkup(<StatisticsCard symbol="SOXL" quote={quote} quotes={quotes} profile={{ phase: "ready", value: fixtureEnvelope(profile) }} day={null} />)
  assert.match(html, /추정 AUM/)
  assert.match(html, /\$21\.73B/)
  assert.doesNotMatch(html, /Total Market Cap/)
})
