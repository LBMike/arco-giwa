import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { GiwaSidebarNav } from "./GiwaSidebarNav"
import { INVESTOR_NAV_SECTIONS, investorNavSections, isNavItemActive, type InvestorNavItemId } from "./investor-nav"
import { GIWA_FUNDS_ROUTE } from "./routes"

function shape(isAdmin: boolean) {
  return investorNavSections(isAdmin).map((section) => ({
    label: section.label,
    items: section.items.map((item) => [item.label, item.to]),
  }))
}

function activeIds(pathname: string, isAdmin = true): InvestorNavItemId[] {
  return investorNavSections(isAdmin)
    .flatMap((section) => section.items)
    .filter((item) => isNavItemActive(item, pathname))
    .map((item) => item.id)
}

test("nav sections and items keep their order, labels and routes", () => {
  assert.equal(GIWA_FUNDS_ROUTE, "/funds")
  assert.deepEqual(shape(false), [
    { label: null, items: [["Home", "/"]] },
    { label: "Invest", items: [["Savings", "/savings"], ["Funds", "/funds"], ["Stocks", "/stocks"]] },
    { label: "Manage", items: [["Portfolio", "/portfolio"]] },
  ])
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
    ["/", ["home"]],
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
    <MemoryRouter initialEntries={["/product/abc"]}>
      <GiwaSidebarNav isAdmin={false} />
    </MemoryRouter>,
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
    <MemoryRouter initialEntries={["/product/abc"]}>
      <GiwaSidebarNav isAdmin={false} compact />
    </MemoryRouter>,
  )
  for (const name of ["Home", "Savings", "Funds", "Stocks", "Portfolio"]) {
    assert.ok(html.includes(`aria-label="${name}"`), `${name} needs an icon-link name`)
  }
  assert.match(html, /aria-current="page"[^>]*aria-label="Funds"/)
  assert.doesNotMatch(html, />Send<\/span>|aria-label="Send"/)
  assert.doesNotMatch(html, /aria-label="Savings categories"/)
  assert.doesNotMatch(html, /href="\/send"/)
})
