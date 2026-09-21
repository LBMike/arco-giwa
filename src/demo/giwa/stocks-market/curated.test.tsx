import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { CURATED_SELECTION, CURATED_STOCKS, curatedStock, matchesCuratedSelection, stockLogoPath } from "./curated"
import { symbol } from "./validate"

const LOGOS = join(process.cwd(), "public/logos/stocks")
const manifest = JSON.parse(readFileSync(join(LOGOS, "manifest.json"), "utf8")) as { files: { file: string; sha256: string; bytes: number }[] }
const symbols = CURATED_STOCKS.map(item => item.symbol)

test("the curated catalog is 40 frozen rows with contiguous unique ranks, valid symbols and valid unique ISINs", () => {
  assert.equal(CURATED_STOCKS.length, 40)
  assert.ok(Object.isFrozen(CURATED_STOCKS) && CURATED_STOCKS.every(item => Object.isFrozen(item)))
  assert.deepEqual(CURATED_STOCKS.map(item => item.rank), Array.from({ length: 40 }, (_, index) => index + 1))
  assert.equal(new Set(symbols).size, 40)
  for (const name of symbols) assert.equal(symbol(name), name)
  const isins = CURATED_STOCKS.map(item => item.isin)
  assert.equal(new Set(isins).size, 40)
  for (const isin of isins) assert.match(isin, /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/)
  for (const item of CURATED_STOCKS) { assert.ok(item.name.trim() && item.name.length <= 200, item.symbol); assert.ok(item.logoOwner.trim(), item.symbol) }
})

test("kinds: 26 stocks including one ADS, 14 ETFs including six leveraged or inverse", () => {
  const count = (predicate: (item: (typeof CURATED_STOCKS)[number]) => boolean) => CURATED_STOCKS.filter(predicate).length
  assert.equal(count(item => item.kind === "STOCK"), 26)
  assert.equal(count(item => item.kind === "STOCK" && item.detail === "ADS"), 1)
  assert.equal(curatedStock("SKHY")?.detail, "ADS")
  assert.equal(count(item => item.kind === "ETF"), 14)
  assert.deepEqual(CURATED_STOCKS.filter(item => item.detail === "LEVERAGED_OR_INVERSE").map(item => item.symbol), ["SOXL", "SOXS", "KORU", "TQQQ", "QLD", "RAM"])
  assert.ok(CURATED_STOCKS.filter(item => item.detail === "LEVERAGED_OR_INVERSE").every(item => item.kind === "ETF"))
})

test("every mapped logo is a same-origin PNG in public/logos/stocks whose sha256 matches manifest.json", () => {
  const byFile = new Map(manifest.files.map(entry => [entry.file, entry]))
  for (const item of CURATED_STOCKS) {
    const entry = byFile.get(item.logoFile)
    assert.ok(entry, `${item.symbol} → ${item.logoFile} is in the manifest`)
    const bytes = readFileSync(join(LOGOS, item.logoFile))
    assert.equal(bytes.length, entry.bytes, item.logoFile)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, item.logoFile)
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${item.logoFile} is a PNG`)
  }
  const files = readdirSync(LOGOS).filter(name => name.endsWith(".png")).sort()
  assert.equal(files.length, 34)
  assert.deepEqual(files, [...new Set(CURATED_STOCKS.map(item => item.logoFile))].sort(), "the PNG files are exactly the mapped files")
  assert.deepEqual(manifest.files.map(entry => entry.file).sort(), files)
  for (const name of symbols) assert.match(stockLogoPath(name)!, /^\/logos\/stocks\/[a-z0-9-]+\.png$/)
  assert.equal(stockLogoPath("AAPL"), null)
  assert.equal(stockLogoPath("nvda"), null)
  assert.equal(curatedStock("AAPL"), null)
})

test("no settlement figure is carried and the selection provenance is recorded as a dated reference", () => {
  const source = readFileSync(join(process.cwd(), "src/demo/giwa/stocks-market/curated.ts"), "utf8")
  assert.doesNotMatch(source, /buySettlementUsd|settlementUsd|"[0-9]{6,}"|\b[0-9]{6,}n?\b/)
  for (const item of CURATED_STOCKS) assert.deepEqual(Object.keys(item).sort(), ["detail", "isin", "kind", "logoFile", "logoOwner", "name", "rank", "symbol"])
  assert.deepEqual({ ...CURATED_SELECTION, note: undefined }, { source: "한국예탁결제원 SEIBro 해외주식 종목별내역(주식TOP50)", metric: "매수결제금액 상위 40", period: "2026-08-16~2026-09-15", retrievedDate: "2026-09-16", note: undefined })
  assert.match(CURATED_SELECTION.note, /다시 조회하지 않았습니다/)
  assert.match(CURATED_SELECTION.note, /투자 추천이나 시가총액 순위가 아닙니다/)
  assert.doesNotMatch(source, /import .*\.json|from "\.\.\/\.\.\/\.\.\/\.\.\//)
})

test("matchesCuratedSelection requires exactly the 40 symbols, in any order", () => {
  assert.equal(matchesCuratedSelection(symbols), true)
  assert.equal(matchesCuratedSelection([...symbols].reverse()), true)
  assert.equal(matchesCuratedSelection(symbols.slice(1)), false)
  assert.equal(matchesCuratedSelection(["NVDA"]), false)
  assert.equal(matchesCuratedSelection([...symbols.slice(1), "AAPL"]), false)
  assert.equal(matchesCuratedSelection([...symbols.slice(1), symbols[1]]), false)
  assert.equal(matchesCuratedSelection([...symbols, "AAPL"]), false)
})
