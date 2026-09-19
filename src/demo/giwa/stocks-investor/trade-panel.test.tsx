import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { GiwaStocksAccess } from "./access"
import { actionsFor } from "./actions"
import { createHarness, WALLET_A } from "./fixtures/controller-harness"
import { GiwaStocksFeatureView } from "./GiwaStocksFeature"
import type { StocksInvestorController } from "./controller"
import { INVEST_TAB_ACTIVE } from "../invest-panel-ui"
import { statusAnnouncement, tradeStep } from "./TradePanel"

// The GIWA-style trade panel, rendered statically (server snapshot = desktop, so the one inline panel). The dock and the
// bottom sheet are covered by trade-sheet.dom.test.tsx.

const READY_ACCESS: GiwaStocksAccess = { wallet: "ready", host: "authenticated", hostError: null, canSignIn: false }
const noop = () => undefined

function render(controller: StocksInvestorController, access: GiwaStocksAccess | null = READY_ACCESS, detailOpen = true): string {
  return renderToStaticMarkup(
    <GiwaStocksFeatureView state={controller.getState()} actions={actionsFor(controller)} tab="stocks" onTabChange={noop} detailOpen={detailOpen} onDetailChange={noop} access={access} />,
  )
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ")
}

/** The trade panel's section only. */
function panel(html: string): string {
  const start = html.indexOf('data-testid="stocks-trade-panel"')
  assert.ok(start >= 0, "trade panel")
  return html.slice(html.lastIndexOf("<section", start))
}

/** Every <button> of the panel as [label, opening tag]. */
function buttons(html: string): { label: string; tag: string }[] {
  return [...panel(html).matchAll(/(<button\b[^>]*>)((?:(?!<\/button>).)*)<\/button>/gs)].map((match) => ({ tag: match[1], label: text(match[2]).trim() }))
}

/** The one full-width primary action (the GIWA CTA classes). */
function cta(html: string): { label: string; tag: string } {
  const found = buttons(html).filter((button) => button.tag.includes("mt-4 inline-flex w-full items-center justify-center"))
  assert.equal(found.length, 1, `exactly one primary action: ${found.map((button) => button.label).join(", ")}`)
  return found[0]
}

const enabled = (tag: string) => !/\sdisabled=""/.test(tag) && !/aria-disabled="true"/.test(tag)

async function signedOut() {
  const h = createHarness()
  await h.enter(null)
  return h
}

test("CTA precedence: wallet → network → wallet support → signing in → sign in (never 'Sign in to Stocks')", async () => {
  const h = await signedOut()
  const cases: [Partial<GiwaStocksAccess>, string, boolean, RegExp | null][] = [
    [{ wallet: "disconnected", host: "signed-out", connectWallet: noop }, "Connect wallet", true, null],
    [{ wallet: "disconnected", host: "signed-out" }, "Connect wallet", false, /Connect a wallet using the button at the top of the page\./],
    [{ wallet: "wrong-network", host: "signed-out", switchNetwork: noop }, "Switch to GIWA Sepolia", true, null],
    [{ wallet: "wrong-network", host: "signed-out" }, "Switch to GIWA Sepolia", false, /Switch your wallet to GIWA Sepolia/],
    [{ wallet: "unavailable", host: "signed-out" }, "Wallet cannot sign here", false, /Your wallet is not ready to sign a message/],
    [{ wallet: "ready", host: "signing-in" }, "Signing in…", false, /Complete the sign-in message in your wallet\./],
    [{ wallet: "ready", host: "signed-out", canSignIn: true, signIn: noop }, "Sign in to trade", true, null],
    [{ wallet: "ready", host: "signed-out", canSignIn: false, signIn: noop }, "Sign in to trade", false, null],
    // The real host publishes an ended session as { status: "signed-out", error: code } (stocks-host/session.ts).
    [{ wallet: "ready", host: "signed-out", hostError: "SESSION_EXPIRED", canSignIn: true, signIn: noop }, "Sign in to trade", true, /Your Stocks session ended\. Sign in again\./],
    [{ wallet: "ready", host: "signed-out", hostError: "SESSION_REJECTED", canSignIn: true, signIn: noop }, "Sign in to trade", true, /Your Stocks session is no longer valid\. Sign in again\./],
    [{ wallet: "ready", host: "signed-out", hostError: "WALLET_CHANGED", canSignIn: true, signIn: noop }, "Sign in to trade", true, /The connected wallet changed\. Sign in again with this wallet\./],
    [{ wallet: "ready", host: "error", hostError: "AUTH_UNAVAILABLE", canSignIn: false }, "Sign in to trade", false, /Stocks sign-in is not available on this page\./],
  ]
  for (const [over, label, active, hint] of cases) {
    const access = { ...READY_ACCESS, host: "signed-out", ...over } as GiwaStocksAccess
    const html = render(h.controller, access)
    const button = cta(html)
    assert.equal(button.label, label, JSON.stringify(over))
    assert.equal(enabled(button.tag), active, `${label} enabled=${active}`)
    if (hint) assert.match(text(panel(html)), hint, label)
    assert.doesNotMatch(panel(html), /Sign in to Stocks|Sign out of Stocks|Retry Stocks sign-in/, "the page's sign-in region owns those names")
    if (label === "Signing in…") assert.match(button.tag, /aria-busy="true"/)
  }
  assert.deepEqual(tradeStep(h.controller.getState(), null), { kind: "blocked", label: "Get quote", hint: null })
})

test("an ended session (expired, rejected, other wallet) replaces the generic sign-in notice, and the action points at it", async () => {
  const h = await signedOut()
  const generic = /Connecting a wallet alone does not sign you in/
  const never = createHarness()
  await never.enter(null)
  const fresh = panel(render(never.controller, { ...READY_ACCESS, host: "signed-out", canSignIn: true, signIn: noop }))
  assert.match(text(fresh), generic, "never signed in: the generic notice")
  for (const [code, message] of [
    ["SESSION_EXPIRED", "Your Stocks session ended. Sign in again."],
    ["SESSION_REJECTED", "Your Stocks session is no longer valid. Sign in again."],
    ["WALLET_CHANGED", "The connected wallet changed. Sign in again with this wallet."],
  ] as const) {
    const html = panel(render(h.controller, { ...READY_ACCESS, host: "signed-out", hostError: code, canSignIn: true, signIn: noop }))
    assert.doesNotMatch(text(html), generic, `${code}: not the generic notice`)
    assert.equal(text(html).split(message).length - 1, 1, `${code}: said exactly once`)
    const described = cta(html).tag.match(/aria-describedby="([^"]+)"/)?.[1]
    assert.ok(described, `${code}: the sign-in action is described`)
    const notice = html.slice(html.indexOf(`id="${described}"`))
    assert.ok(text(notice.slice(0, notice.indexOf("</div></div>"))).includes(message), `${code}: the action's description is the ended-session notice`)
    assert.doesNotMatch(html, /0x[0-9a-fA-F]{4}/, `${code}: no address`)
  }
  // Without host access (standalone), nothing changes.
  assert.match(text(panel(render(h.controller, null))), generic)
})

test("signed in: catalog block → quantity → quoting → place → expired → quote; one primary action throughout", async () => {
  const blocked = createHarness()
  blocked.controls.setCatalogMode("not-activated")
  await blocked.enter(WALLET_A)
  const off = render(blocked.controller)
  assert.equal(cta(off).label, "Get quote")
  assert.equal(enabled(cta(off).tag), false)
  assert.match(cta(off).tag, /aria-describedby="[^"]+-notice"/, "the disabled action points at the reason")
  assert.match(text(off), /Stocks trading is not activated on this server/)

  const h = createHarness()
  await h.enter(WALLET_A)
  const empty = render(h.controller)
  assert.deepEqual([cta(empty).label, enabled(cta(empty).tag)], ["Get quote", false])
  assert.match(cta(empty).tag, /type="submit"/)
  h.controller.setQuantity("2")
  const typed = render(h.controller)
  assert.deepEqual([cta(typed).label, enabled(cta(typed).tag)], ["Get quote", true])
  h.controls.holdNext("quote")
  const pending = h.controller.requestQuote()
  const loading = render(h.controller)
  assert.equal(cta(loading).label, "Getting quote…")
  assert.match(cta(loading).tag, /aria-busy="true"/)
  assert.match(cta(loading).tag, /aria-disabled="true"/)
  assert.doesNotMatch(cta(loading).tag, /\sdisabled=""/, "stays focusable while the quote is read")
  h.controls.releaseHeld("quote")
  await pending
  const ready = render(h.controller)
  assert.deepEqual([cta(ready).label, enabled(cta(ready).tag)], ["Place buy order", true])
  assert.match(cta(ready).tag, /type="button"/)
  assert.ok(buttons(ready).some((button) => button.label === "Discard quote"))
  assert.match(panel(ready), /data-testid="stocks-quote"/)
  h.advanceDevice(60_000)
  h.controller.tick()
  const expired = render(h.controller)
  assert.equal(cta(expired).label, "Get a new quote")
  assert.match(text(expired), /Quote expired No order was placed/)
  assert.ok(!buttons(expired).some((button) => button.label === "Discard quote"))
})

test("without host access (standalone) the form stays disabled with today's notice, and no host step is offered", async () => {
  const h = await signedOut()
  const html = render(h.controller, null)
  assert.deepEqual([cta(html).label, enabled(cta(html).tag)], ["Get quote", false])
  assert.match(text(html), /Sign-in required Sign in with your wallet signature/)
  assert.match(html, /<fieldset[^>]*disabled=""/)
  assert.doesNotMatch(text(panel(html)), /Connect wallet|Sign in to trade|Switch to GIWA Sepolia/)
})

test("BUY is You pay (cash) then You receive (NVDA); SELL is You sell (NVDA) then You receive (cash); one decimal input", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  for (const side of ["BUY", "SELL"] as const) {
    h.controller.setSide(side)
    const html = panel(render(h.controller))
    assert.equal(html.match(/<input\b/g)?.length, 1, `${side}: exactly one input`)
    assert.equal(html.match(/inputMode="decimal"/g)?.length, 1)
    assert.equal(html.match(/data-side="/g)?.length, 2, "only the two side radios carry data-side")
    assert.match(html, /role="radiogroup" aria-label="Order side"/)
    const input = html.indexOf("<input")
    const cash = html.indexOf("ARCO_TEST_USDC<span")
    assert.ok(cash > 0 && input > 0)
    if (side === "BUY") {
      assert.ok(html.indexOf(">You pay<") < cash && cash < html.indexOf(">You receive") && html.indexOf(">You receive") < input, "BUY order")
    } else {
      assert.ok(html.indexOf(">You sell") < input && input < html.indexOf(">You receive<") && html.indexOf(">You receive<") < cash, "SELL order")
    }
    // The input keeps its label, hint and keystroke contract.
    assert.match(html, /<label for="([^"]+)"[^>]*>You (receive|sell)<span class="sr-only"> · Quantity \(NVDA\)<\/span><\/label>/)
    assert.match(html, /aria-describedby="[^"]+-hint" aria-invalid="false"/)
    assert.match(text(html), /Up to 9 decimal places\. The server calculates the exact test cash amount\./)
    assert.match(text(html), /NVDA Test units/)
  }
})

test("the cash side shows only the server quote, in the catalog's cash symbol", async () => {
  const h = createHarness()
  h.controls.corruptNext("catalog", (body) => ({ ...(body as object), cashSymbol: "ARCO_TEST_RLUSD" }))
  await h.enter(WALLET_A)
  h.controller.setQuantity("2.5")
  const before = panel(render(h.controller))
  assert.match(text(before), /You pay ARCO_TEST_RLUSD TEST — 서버 견적 후 표시/)
  assert.doesNotMatch(before, /ARCO_TEST_USDC/)
  assert.doesNotMatch(text(before), /\b300\b/, "no client-side estimate")
  await h.quote("2.5")
  const after = text(panel(render(h.controller)))
  assert.match(after, /You pay ARCO_TEST_RLUSD TEST 300 300000000 base units \(6 decimals\)/)
  assert.match(after, /Price 120 ARCO_TEST_RLUSD \/ NVDA \(fixed, test\)/)
  assert.doesNotMatch(after, /\bUSDC\b|ARCO_TEST_USDC/, "no hard-coded cash asset")
})

test("SELL availability: nothing before the portfolio is read; MAX only for a positive server value; over-quantity warns", async () => {
  const h = createHarness()
  h.controls.setHolding(WALLET_A, "3000000000")
  await h.enter(WALLET_A)
  h.controller.setSide("SELL")
  const unread = panel(render(h.controller))
  assert.doesNotMatch(unread, /Available to sell|>MAX</, "not loaded: no balance, no MAX, never an assumed 0")
  await h.controller.loadPortfolio()
  const loaded = panel(render(h.controller))
  assert.match(text(loaded), /Available to sell: 3 NVDA/)
  assert.match(loaded, /<button type="button" class="[^"]*">MAX<\/button>/)
  assert.match(loaded, /aria-describedby="[^" ]+-hint" aria-invalid="false"/, "within the available quantity: the hint only")
  h.controller.setQuantity("4")
  const overHtml = panel(render(h.controller))
  const over = text(overHtml)
  assert.match(over, /This is more than the 3 NVDA available to sell as of/)
  assert.match(over, /The server checks availability when the order is placed/)
  assert.equal(cta(render(h.controller)).label, "Get quote", "the server still decides")
  // The warning is the input's description too, and the panel's polite status line says it while typing.
  const describedBy = overHtml.match(/<input\b[^>]*aria-describedby="([^"]+)"/)?.[1]?.split(" ") ?? []
  assert.equal(describedBy.length, 2, "hint + availability warning")
  const warning = overHtml.slice(overHtml.indexOf(`id="${describedBy[1]}"`))
  assert.match(text(warning.slice(0, 400)), /^[^<]*This is more than the 3 NVDA available to sell/, "the second description is the warning")
  const status = overHtml.match(/<p class="sr-only" aria-live="polite" data-testid="stocks-trade-status">([^<]*)<\/p>/)?.[1]
  assert.equal(status, "More than the 3 NVDA available to sell. The server checks availability when the order is placed.")
  assert.equal(statusAnnouncement(h.controller.getState()), status)
  h.controller.setQuantity("3")
  const within = panel(render(h.controller))
  assert.doesNotMatch(text(within), /This is more than/)
  assert.match(within, /aria-describedby="[^" ]+-hint" aria-invalid="false"/)
  assert.match(within, /data-testid="stocks-trade-status"><\/p>/, "nothing to announce within the available quantity")

  const none = createHarness()
  await none.enter(WALLET_A)
  none.controller.setSide("SELL")
  await none.controller.loadPortfolio()
  const zero = panel(render(none.controller))
  assert.match(text(zero), /Available to sell: 0 NVDA/, "a read portfolio without NVDA is the server's zero")
  assert.doesNotMatch(zero, />MAX</)

  const negative = createHarness()
  await negative.enter(WALLET_A)
  negative.controls.corruptNext("portfolio", (body) => ({
    ...(body as object),
    data: {
      holdings: [{ wallet: WALLET_A, symbol: "NVDA", walletQuantity: "0", escrowedQuantity: "10000000000", reservedQuantity: "4000000000", availableQuantity: "-4000000000", quantity: "10000000000" }],
      pending: [],
      projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS",
    },
  }))
  negative.controller.setSide("SELL")
  await negative.controller.loadPortfolio()
  const deficit = panel(render(negative.controller))
  assert.match(text(deficit), /Available to sell: -4 NVDA/)
  assert.doesNotMatch(deficit, />MAX</)
  // BUY never shows a balance or MAX.
  h.controller.setSide("BUY")
  assert.doesNotMatch(panel(render(h.controller)), /Available to sell|>MAX</)
})

test("the selected Buy / Sell segment carries a non-colour ink ring (Stocks only; GIWA's active tab classes unchanged)", async () => {
  // GiwaInvestPanel's own active tab: byte-identical (invest-panel-ui.test pins its markup).
  assert.equal(INVEST_TAB_ACTIVE, "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]")
  const h = createHarness()
  await h.enter(WALLET_A)
  for (const side of ["BUY", "SELL"] as const) {
    h.controller.setSide(side)
    const html = panel(render(h.controller))
    const tags = [...html.matchAll(/<button\b[^>]*data-side="(BUY|SELL)"[^>]*>/g)]
    assert.equal(tags.length, 2)
    for (const [tag, value] of tags) {
      const ring = /\bring-1 ring-inset ring-\[var\(--color-arco-ink\)\]/.test(tag)
      assert.equal(ring, value === side, `${value} ring while ${side} is selected`)
      assert.equal(/aria-checked="true"/.test(tag), value === side)
    }
  }
})

test("an attempt replaces the form: no CTA, no input, no side toggle; exactly one panel", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  await h.quote("1")
  await h.controller.placeOrder()
  const html = render(h.controller)
  assert.equal(html.match(/data-testid="stocks-trade-panel"/g)?.length, 1)
  assert.equal(html.match(/<input\b/g), null)
  assert.equal(html.match(/data-side="/g), null)
  assert.match(html, /data-testid="stocks-attempt-accepted"/)
  assert.ok(buttons(html).some((button) => button.label === "Start a new order"))
  assert.ok(!buttons(html).some((button) => button.tag.includes("mt-4 inline-flex w-full")), "no primary trade action")
  assert.equal(tradeStep(h.controller.getState(), READY_ACCESS).kind, "attempt")
})

test("desktop detail: the trade card carries the detail title; controlled detail has no All stocks button", async () => {
  const h = createHarness()
  await h.enter(WALLET_A)
  const html = render(h.controller)
  assert.match(html, /<h2 id="giwa-stocks-detail-title" tabindex="-1"[^>]*>Trade NVDA<\/h2>/)
  assert.equal(html.match(/id="giwa-stocks-detail-title"/g)?.length, 1)
  assert.match(text(html), /All stocks/)
  const controlled = renderToStaticMarkup(
    <GiwaStocksFeatureView state={h.controller.getState()} actions={actionsFor(h.controller)} tab="stocks" onTabChange={noop} detailOpen onDetailChange={noop} showAllStocks={false} />,
  )
  assert.doesNotMatch(text(controlled), /All stocks/)
  assert.match(controlled, /Trade NVDA/)
  // No dock and no sheet on desktop.
  assert.doesNotMatch(html, /role="dialog"|View order|fixed inset-x-0 bottom-0/)
})

test("no invented market or venue data, and muted text is placeholder-only", async () => {
  const h = createHarness()
  h.controls.setHolding(WALLET_A, "3000000000")
  await h.enter(WALLET_A)
  for (const side of ["BUY", "SELL"] as const) {
    await h.quote("1", side)
    await h.controller.loadPortfolio()
    const html = panel(render(h.controller))
    assert.doesNotMatch(text(html), /\bfees?\b|slippage|exchange rate|minimum received|\bETA\b|Ethereum|BNB|Select network|NVDAon|Shares per token|dividend|Balance:/i, side)
    const muted = html.match(/[^\s"]*color-arco-muted[^\s"]*/g) ?? []
    assert.ok(muted.every((use) => use.startsWith("placeholder:")), muted.join(","))
  }
})

test("trade view code reads no wallet and parses no money with floats", () => {
  for (const file of ["TradePanel.tsx", "StocksViews.tsx", "GiwaStocksFeature.tsx", "ui.tsx"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
    assert.doesNotMatch(source, /\bNumber\(|\.toFixed\(|\bparseFloat\b|\bparseInt\b|\bMath\.round\(/, file)
    assert.doesNotMatch(source, /from "(\.\.\/)+wallet|from "viem"|eth_call|eth_getBalance|allowance\(|balanceOf/, file)
  }
})
