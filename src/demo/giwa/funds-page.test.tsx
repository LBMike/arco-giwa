// The Funds page: Featured Funds on the green-aurora card, then the ember-style list with its tabs. The lineup is
// HOME, JX and PPLUS; cash management funds, the Strategies cards and the Base Asset / Asset Manager / Issuer columns
// are gone.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import GiwaInvestorPage from "./Investor"
import { FUNDS_LINEUP, FUNDS_RISK_DOC, FUNDS_TABS, lineupForTab, nextTabIndex, sortLineup } from "./funds-lineup"
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
  // Credit funds are Medium, equity funds High.
  assert.deepEqual(
    FUNDS_LINEUP.map((entry) => [entry.type, entry.risk.level, entry.risk.liquidation, entry.risk.withdrawals]),
    [
      ["HELOC Private Credit", "medium", "None", "Up to 3 business days"],
      ["Japan Equity", "high", "None", "T+4"],
      ["Levered Credit", "medium", "Yes, up to 5x leverage", "T+4 to T+7"],
    ],
  )
  for (const entry of FUNDS_LINEUP) {
    const { risk, fund } = entry
    assert.ok(risk.summary.length > 60 && risk.summary.endsWith("."), `${fund.symbol} summary`)
    assert.ok(risk.exposure.length > 0, `${fund.symbol} exposure`)
    assert.ok(entry.blurb.length > 40, `${fund.symbol} blurb`)
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

test("Risk profile lights one, two or three bars and opens a card with the tier, the risk and where to read more", () => {
  const profile = (level: "low" | "medium" | "high") => ({
    level,
    summary: "A short account of what can go wrong with this fund and who takes the losses.",
    exposure: "Something",
    liquidation: "None",
    withdrawals: "Instant",
  })
  const render = (level: "low" | "medium" | "high") => {
    const html = renderToStaticMarkup(<RiskProfile profile={profile(level)} />)
    return { lit: html.split('data-lit="true"').length - 1, off: html.split('data-lit="false"').length - 1, segments: html.split('data-segment="lit"').length - 1, html }
  }
  assert.deepEqual([render("low").lit, render("medium").lit, render("high").lit], [1, 2, 3])
  assert.deepEqual([render("low").off, render("medium").off, render("high").off], [2, 1, 0])
  assert.deepEqual([render("low").segments, render("medium").segments, render("high").segments], [1, 2, 3])

  const { html } = render("medium")
  // Closed until pointed at, clicked or tapped; the meter names and controls its card.
  assert.match(html, /aria-label="Risk profile: Medium" aria-expanded="false" aria-controls="([^"]+)"/)
  const panelId = html.match(/aria-controls="([^"]+)"/)![1]!
  assert.match(html, new RegExp(`id="${panelId}" role="group" aria-labelledby="[^"]+" hidden=""`)) // takes no space while closed
  // Risk profile · tier · bar · summary · Exposure / Liquidation risk / Withdrawals · Learn more about risk.
  const order = [">Risk profile<", ">Medium<", 'data-segment="lit"', ">A short account", ">Exposure<", ">Liquidation risk<", ">Withdrawals<", "Learn more about risk"].map((text) => html.indexOf(text))
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), JSON.stringify(order))
  // Every fund links Arco's page on user risks.
  assert.equal(FUNDS_RISK_DOC, "https://docs.arco.financial/security/user-risks")
  assert.match(html, /<a href="https:\/\/docs\.arco\.financial\/security\/user-risks" target="_blank" rel="noopener noreferrer"/)
  // The phone's bottom sheet renders nothing until a tap opens it.
  assert.doesNotMatch(html, /role="dialog"|data-testid="risk-sheet"/)
  assert.ok(html.includes("bg-[var(--color-risk-meter-medium)]"))
})

test("values read precisely use Geist with tabular figures, never a system monospace", () => {
  const css = readFileSync("src/demo/theme.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  assert.doesNotMatch(css, /Menlo|SFMono|SF Mono|ui-monospace/)
  const mono = css.slice(css.indexOf(".arco-demo .font-mono"), css.indexOf("}", css.indexOf(".arco-demo .font-mono")))
  assert.match(mono, /font-family: 'Geist Variable'/)
  assert.match(mono, /font-variant-numeric: tabular-nums/)
})
