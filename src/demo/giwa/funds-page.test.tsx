// The Funds page: Featured Funds on the green-aurora card, then the ember-style list with its tabs. The lineup is
// HOME, JX and PPLUS; cash management funds, the Strategies cards and the Base Asset / Asset Manager / Issuer columns
// are gone.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import GiwaInvestorPage from "./Investor"
import { FUNDS_LINEUP, FUNDS_TABS, lineupForTab, nextTabIndex, sortLineup } from "./funds-lineup"
import { RiskProfile } from "./RiskProfile"

function renderPage(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/funds"]}>
      <GiwaInvestorPage />
    </MemoryRouter>,
  )
}

test("the lineup is HOME, JX and PPLUS; Credit holds HOME and PPLUS, Equity holds JX", () => {
  assert.deepEqual(FUNDS_LINEUP.map((entry) => entry.fund.symbol), ["HOME", "JX", "PPLUS"])
  assert.deepEqual(FUNDS_TABS.map((tab) => tab.label), ["All Funds", "Credit", "Equity"])
  assert.deepEqual(lineupForTab("credit").map((entry) => entry.fund.symbol), ["HOME", "PPLUS"])
  assert.deepEqual(lineupForTab("equity").map((entry) => entry.fund.symbol), ["JX"])
  assert.deepEqual(
    FUNDS_LINEUP.map((entry) => [entry.type, entry.risk]),
    [
      ["HELOC Private Credit", "medium"],
      ["Japan Equity", "high"],
      ["Levered Credit", "high"],
    ],
  )
  for (const entry of FUNDS_LINEUP) {
    assert.ok(entry.risks.length >= 2 && entry.risks.every((risk) => risk.endsWith(".")), `${entry.fund.symbol} risks`)
    assert.ok(entry.blurb.length > 40, `${entry.fund.symbol} blurb`)
  }
})

test("tabs narrow the list, arrow keys wrap between tabs, and AUM / APY sort it", () => {
  const symbols = (funds: readonly { fund: { symbol: string } }[]) => funds.map((entry) => entry.fund.symbol)
  assert.deepEqual(symbols(lineupForTab("all", FUNDS_LINEUP)), ["HOME", "JX", "PPLUS"])
  assert.deepEqual(symbols(lineupForTab("credit", FUNDS_LINEUP.slice(1))), ["PPLUS"])
  assert.deepEqual(symbols(sortLineup(FUNDS_LINEUP, null)), ["HOME", "JX", "PPLUS"])
  assert.deepEqual(symbols(sortLineup(FUNDS_LINEUP, { key: "aum", dir: "desc" })), ["JX", "PPLUS", "HOME"])
  assert.deepEqual(symbols(sortLineup(FUNDS_LINEUP, { key: "aum", dir: "asc" })), ["HOME", "PPLUS", "JX"])
  assert.deepEqual(symbols(sortLineup(FUNDS_LINEUP, { key: "apy", dir: "desc" })), ["JX", "PPLUS", "HOME"])
  assert.deepEqual(symbols(FUNDS_LINEUP), ["HOME", "JX", "PPLUS"]) // sorting leaves the lineup as it was
  assert.deepEqual([nextTabIndex(0, "ArrowRight"), nextTabIndex(2, "ArrowRight"), nextTabIndex(0, "ArrowLeft")], [1, 0, 2])
  assert.deepEqual([nextTabIndex(1, "Home"), nextTabIndex(0, "End"), nextTabIndex(1, "Enter")], [0, 2, null])
})

test("the page opens on Featured Funds with HOME first, then the list rows in lineup order", () => {
  const html = renderPage()
  assert.match(html, /<h1 id="featured-funds-title"[^>]*>Featured Funds<\/h1>/)
  assert.doesNotMatch(html, />Products</)

  // Featured card: HOME's name, type, rate, AUM and GIWA; dots for the three funds.
  const card = html.slice(html.indexOf('data-testid="featured-fund"'), html.indexOf('data-testid="funds-list"'))
  assert.match(html, /data-funds-hero="true"[^>]*data-testid="featured-fund"/)
  assert.ok(card.includes(">NUVA HOME Vault<") && card.includes(">HELOC Private Credit<"))
  assert.ok(card.includes(">Target APY<") && card.includes(">7%<") && card.includes(">$10.01M<") && card.includes('alt="GIWA"'))
  assert.ok(card.includes('href="/product/nuva-home"'))
  for (const symbol of ["HOME", "JX", "PPLUS"]) assert.ok(card.includes(`aria-label="Show ${symbol}"`), symbol)
  assert.ok(card.includes('aria-label="Previous featured fund"') && card.includes('aria-label="Next featured fund"'))

  // Tabs, then Fund · Risk profile · AUM · APY · Network.
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>.*?All Funds<\/button>/)
  const list = html.slice(html.indexOf('data-testid="funds-list"'))
  const heads = ["Fund", "Risk profile", "AUM", "APY", "Network"].map((head) => list.indexOf(`>${head}<`))
  assert.ok(heads.every((at, i) => at > 0 && (i === 0 || at > heads[i - 1]!)), JSON.stringify(heads))
  const rows = list.split('data-testid="fund-row"').slice(1)
  assert.equal(rows.length, 3)
  const expected = [
    ["HOME", "NUVA HOME Vault", "HELOC Private Credit", "$10.01M", "7%", "Target APY", "/product/nuva-home"],
    ["JX", "SBI Japan High Dividend Equity Strategy", "Japan Equity", "$2.05B", "39.66%", "12-month return", "/product/digift-jx"],
    ["PPLUS", "Bitwise Premium+ RWA Vault", "Levered Credit", "$14.5M", "12.53%", "30-day avg. APY", "/product/bitwise-pplus"],
  ]
  rows.forEach((row, i) => {
    for (const text of expected[i]!.slice(0, 6)) assert.ok(row.includes(`>${text}<`), `${expected[i]![0]} ${text}`)
    assert.ok(row.includes(`href="${expected[i]![6]}"`), `${expected[i]![0]} link`)
    assert.ok(row.includes('alt="GIWA"'), `${expected[i]![0]} network`)
  })
})

test("the list drops cash management funds, the Strategies cards and the Base Asset, Asset Manager and Issuer columns", () => {
  const html = renderPage()
  for (const gone of ["Strategies", "Base Asset", "Asset Manager", "Issuer", "Cash Management", "uMINT", "auMINT", "iBENJI", "aiBENJI", "RRDY", "aCAPIX", "bEQTY", "CMBBOND", "kTW50"]) {
    assert.ok(!html.includes(`>${gone}<`) && !html.includes(`${gone} `), gone)
  }
})

test("Risk profile lights one, two or three bars and names the risks", () => {
  const bars = (level: "low" | "medium" | "high") => {
    const html = renderToStaticMarkup(<RiskProfile level={level} risks={["One risk.", "Another risk."]} />)
    return { lit: html.split('data-lit="true"').length - 1, off: html.split('data-lit="false"').length - 1, html }
  }
  assert.deepEqual([bars("low").lit, bars("medium").lit, bars("high").lit], [1, 2, 3])
  assert.deepEqual([bars("low").off, bars("medium").off, bars("high").off], [2, 1, 0])
  const { html } = bars("medium")
  assert.match(html, /aria-label="Medium Risk"/)
  const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1]
  assert.ok(describedBy && html.includes(`id="${describedBy}" role="tooltip"`), "the button names its tooltip")
  assert.match(html, /role="tooltip"[^>]*>.*Medium Risk.*One risk\..*Another risk\./)
  assert.ok(html.includes("bg-[var(--color-risk-meter-medium)]"))
})

test("values read precisely use Geist with tabular figures, never a system monospace", () => {
  const css = readFileSync("src/demo/theme.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  assert.doesNotMatch(css, /Menlo|SFMono|SF Mono|ui-monospace/)
  const mono = css.slice(css.indexOf(".arco-demo .font-mono"), css.indexOf("}", css.indexOf(".arco-demo .font-mono")))
  assert.match(mono, /font-family: 'Geist Variable'/)
  assert.match(mono, /font-variant-numeric: tabular-nums/)
})
