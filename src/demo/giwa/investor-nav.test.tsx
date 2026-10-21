import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { GiwaSidebarNav } from "./GiwaSidebarNav"
import { INVESTOR_NAV_SECTIONS, investorNavSections, isNavItemActive, type InvestorNavItemId } from "./investor-nav"
import { GIWA_FUNDS_ROUTE } from "./routes"
import { GIWA_FEATURES, GiwaFeaturesContext, type GiwaFeatures } from "./features"

// The whole menu (every section shown); the app's own switch (features.ts) is tested on its own below.
const ALL: GiwaFeatures = { home: true, stocks: true }

function shape(isAdmin: boolean, features: GiwaFeatures = ALL) {
  return investorNavSections(isAdmin, features).map((section) => ({
    label: section.label,
    items: section.items.map((item) => [item.label, item.to]),
  }))
}

function activeIds(pathname: string, isAdmin = true): InvestorNavItemId[] {
  return investorNavSections(isAdmin, ALL)
    .flatMap((section) => section.items)
    .filter((item) => isNavItemActive(item, pathname))
    .map((item) => item.id)
}

test("nav sections and items keep their order, labels and routes", () => {
  assert.equal(GIWA_FUNDS_ROUTE, "/funds")
  assert.deepEqual(shape(false), [
    { label: null, items: [["Home", "/home"]] },
    { label: "Invest", items: [["Savings", "/savings"], ["Funds", "/funds"], ["Stocks", "/stocks"]] },
    { label: "Manage", items: [["Portfolio", "/portfolio"]] },
  ])
})

test("hidden sections leave the menu: Home's whole section, Stocks from Invest (the app hides both now)", () => {
  assert.deepEqual(GIWA_FEATURES, { home: false, stocks: false })
  assert.deepEqual(shape(false, GIWA_FEATURES), [
    { label: "Invest", items: [["Savings", "/savings"], ["Funds", "/funds"]] },
    { label: "Manage", items: [["Portfolio", "/portfolio"]] },
  ])
  assert.deepEqual(investorNavSections(false), investorNavSections(false, GIWA_FEATURES))
  assert.deepEqual(shape(true, GIWA_FEATURES)[1], { label: "Manage", items: [["Portfolio", "/portfolio"], ["Admin", "/admin"]] })
  assert.deepEqual(shape(false, { home: true, stocks: false })[0], { label: null, items: [["Home", "/home"]] })
})

test("Admin item appears only for allowlisted wallets, at the end of Manage", () => {
  assert.ok(!shape(false).flatMap((section) => section.items).some(([label]) => label === "Admin"))
  assert.deepEqual(shape(true)[2], { label: "Manage", items: [["Portfolio", "/portfolio"], ["Admin", "/admin"]] })
  // The shared constant is never mutated by the admin variant.
  assert.equal(INVESTOR_NAV_SECTIONS[2].items.length, 1)
})

test("Send stays out of the menu until the feature exists", () => {
  for (const admin of [false, true]) {
    assert.ok(!investorNavSections(admin).flatMap((section) => section.items).some((item) => item.id === "send"), String(admin))
  }
})

test("active matching per path", () => {
  const cases: Array<[string, InvestorNavItemId[]]> = [
    ["/home", ["home"]],
    // The root redirects to Savings; nothing is current on the way.
    ["/", []],
    ["/funds", ["funds"]],
    ["/product/abc", ["funds"]],
    ["/savings", ["savings"]],
    ["/stocks", ["stocks"]],
    ["/admin/stocks", ["stocks"]],
    ["/portfolio", ["portfolio"]],
    ["/admin/operations", ["admin"]],
    ["/admin", ["admin"]],
    ["/stocks/", ["stocks"]],
    ["/unknown", []],
  ]
  for (const [pathname, expected] of cases) assert.deepEqual(activeIds(pathname), expected, pathname)
  for (const pathname of ["/", "/funds", "/savings", "/stocks", "/portfolio", "/admin", "/send"]) {
    assert.equal(isNavItemActive({ id: "send" }, pathname), false, pathname)
  }
})

test("GiwaSidebarNav renders links with aria-current and no Send row", () => {
  const html = renderToStaticMarkup(
    <GiwaFeaturesContext.Provider value={ALL}>
      <MemoryRouter initialEntries={["/product/abc"]}>
        <GiwaSidebarNav isAdmin={false} />
      </MemoryRouter>
    </GiwaFeaturesContext.Provider>,
  )
  assert.match(html, /<nav aria-label="Main"/)
  for (const name of ["Home", "Invest", "Manage"]) assert.match(html, new RegExp(`<ul aria-label="${name}"`))
  assert.match(html, /<a aria-current="page"[^>]*href="\/funds"/)
  assert.equal(html.match(/aria-current="page"/g)?.length, 1)
  assert.doesNotMatch(html, />Send<\/span>|aria-label="Send"/)
  assert.doesNotMatch(html, /href="\/send"|href="\/admin"/)
  assert.doesNotMatch(html, /<(a|button)[^>]*>(?:(?!<\/\1>).)*Send/)
})

test("compact desktop nav keeps named icon links and has no Send row", () => {
  const html = renderToStaticMarkup(
    <GiwaFeaturesContext.Provider value={ALL}>
      <MemoryRouter initialEntries={["/product/abc"]}>
        <GiwaSidebarNav isAdmin={false} compact />
      </MemoryRouter>
    </GiwaFeaturesContext.Provider>,
  )
  for (const name of ["Home", "Savings", "Funds", "Stocks", "Portfolio"]) {
    assert.ok(html.includes(`aria-label="${name}"`), `${name} needs an icon-link name`)
  }
  assert.match(html, /aria-current="page"[^>]*aria-label="Funds"/)
  assert.doesNotMatch(html, />Send<\/span>|aria-label="Send"/)
  assert.doesNotMatch(html, /aria-label="Savings categories"/)
  assert.doesNotMatch(html, /href="\/send"/)
})

test("GiwaSidebarNav as the app ships it: no Home or Stocks, and the compact rail starts without a divider", () => {
  const render = (compact: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/savings"]}>
        <GiwaSidebarNav isAdmin={false} compact={compact} />
      </MemoryRouter>,
    )
  for (const compact of [false, true]) {
    const html = render(compact)
    assert.doesNotMatch(html, /href="\/home"|href="\/stocks"|aria-label="Home"|aria-label="Stocks"|>Home<|>Stocks</, String(compact))
    assert.match(html, /href="\/savings"/)
    assert.match(html, /href="\/funds"/)
    assert.match(html, /href="\/portfolio"/)
  }
  // Compact: one divider, between Invest and Manage.
  assert.equal(render(true).match(/h-px bg-\[var\(--color-arco-border\)\]/g)?.length, 1)
})
