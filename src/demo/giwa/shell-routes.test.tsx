import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { GIWA_FUNDS_ROUTE, GIWA_HOME_ROUTE, GIWA_PREPROD_ROUTE, GIWA_SAVINGS_ROUTE } from "./routes"

// Source guards: main.tsx builds the browser router at module scope (it renders on import), so the
// route tree is asserted from source, like the provider guard in stocks-host/provider.dom.test.tsx.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("route constants: / starts on Savings, /home is Home, /funds is the Funds list", () => {
  assert.equal(GIWA_PREPROD_ROUTE, "/")
  assert.equal(GIWA_HOME_ROUTE, "/home")
  assert.equal(GIWA_SAVINGS_ROUTE, "/savings")
  assert.equal(GIWA_FUNDS_ROUTE, "/funds")
})

test("main.tsx: index opens Savings (query kept), 'home' renders Home, 'funds' the Funds page, existing routes and guards unchanged", () => {
  const main = read("../../main.tsx")
  assert.match(main, /const GiwaHomePage = lazy\(\(\) => import\('\.\/demo\/giwa\/HomePage'\)\)/)
  assert.match(main, /const GiwaInvestorPage = lazy\(\(\) => import\('\.\/demo\/giwa\/Investor'\)\)/)
  assert.match(main, /\{ index: true, element: <LandingRedirect \/> \}/)
  assert.match(main, /function LandingRedirect\(\) \{\s*const location = useLocation\(\)\s*return <Navigate to=\{`\$\{GIWA_SAVINGS_ROUTE\}\$\{location\.search\}`\} replace \/>/)
  assert.match(main, /\{ path: 'home', element: giwaRoute\(<GiwaHomePage \/>\) \}/)
  assert.doesNotMatch(main, /index: true, element: giwaRoute\(<GiwaHomePage \/>\)/)
  assert.match(main, /\{ path: 'funds', element: giwaRoute\(<GiwaInvestorPage \/>\) \}/)
  assert.doesNotMatch(main, /index: true, element: giwaRoute\(<GiwaInvestorPage \/>\)/)
  assert.match(main, /\{ path: 'savings', element: giwaRoute\(<GiwaSavingsPage \/>\) \}/)
  assert.match(main, /\{ path: 'portfolio', element: giwaRoute\(<GiwaPortfolioPage \/>\) \}/)
  assert.match(main, /\{ path: 'product\/:id', element: giwaRoute\(<GiwaProductDetailPage \/>\) \}/)
  assert.match(main, /\.\.\.stocksRoutes\(giwaRoute\(<GiwaPreprodApp \/>\)\)/)
  assert.match(main, /\{ path: '\/app\/\*', element: <LegacyAppRedirect \/> \}/)
  assert.match(main, /\{ path: '\*', element: <Navigate to=\{GIWA_PREPROD_ROUTE\} replace \/> \}/)
  assert.match(main, /path: GIWA_ADMIN_ROUTE,\s*element: giwaRoute\(<GiwaPreprodApp admin \/>\)/)
  assert.match(main, /<GiwaPreprodProviders><RouterProvider router=\{router\} \/><\/GiwaPreprodProviders>/)
  assert.match(main, /<RequireGiwaAdmin><GiwaAdminLayout \/><\/RequireGiwaAdmin>/)
})

test("links that mean 'the products list' point at /funds; logo links go to the root (Savings)", () => {
  for (const file of ["ProductDetailPage.tsx", "PortfolioPage.tsx", "RequireGiwaAdmin.tsx"]) {
    const source = read(`./${file}`)
    assert.match(source, /to=\{GIWA_FUNDS_ROUTE\}/, file)
    assert.doesNotMatch(source, /GIWA_PREPROD_ROUTE/, file)
  }
  assert.match(read("./ProductDetailPage.tsx"), /to=\{GIWA_FUNDS_ROUTE\}[\s\S]{0,200}Back to products/)
  assert.match(read("./PortfolioPage.tsx"), /to=\{GIWA_FUNDS_ROUTE\}[\s\S]{0,300}Browse products/)
  assert.match(read("./RequireGiwaAdmin.tsx"), /to=\{GIWA_FUNDS_ROUTE\}[\s\S]{0,200}Back to products/)
  for (const file of ["GiwaPreprodApp.tsx", "components.tsx"]) {
    assert.match(read(`./${file}`), /<Link\s+to=\{GIWA_PREPROD_ROUTE\}\s+aria-label="Arco home"/, file)
  }
})

test("shell layout keeps the provider split, the 76px sticky bar and matching gutters", () => {
  const shell = read("./GiwaPreprodApp.tsx")
  assert.doesNotMatch(shell, /GiwaPreprodProviders/)
  assert.match(shell, /xl:grid-cols-\[224px_minmax\(0,1fr\)\]/)
  assert.match(shell, /xl:grid-cols-\[56px_minmax\(0,1fr\)\]/)
  assert.match(shell, /aria-label="Collapse sidebar"/)
  assert.match(shell, /aria-label="Expand sidebar"/)
  assert.match(shell, /<main[\s\S]*?id="giwa-main"[\s\S]*?tabIndex=\{-1\}/)
  // scroll-mt matches the 76px sticky bar + 1px border, so "Skip to content" never parks main's first control under it.
  assert.match(shell, /max-w-\[1512px\] flex-1 scroll-mt-\[77px\] px-4 py-8 md:px-8/)
  const footer = readFileSync(new URL("../components/Footer.tsx", import.meta.url), "utf8")
  assert.equal([...footer.matchAll(/mx-auto (?:grid|flex) w-full max-w-\[1512px\][^"]*px-4 py-6 md:px-8/g)].length, 2, "footer follows the shell width and gutters")
  assert.match(footer, /src="\/arco-wordmark\.png"\s+alt="Arco"/, "the footer's brand is the Arco wordmark")
  const components = read("./components.tsx")
  assert.match(components, /sticky top-0 z-40[^"]*backdrop-blur/)
  assert.match(components, /min-h-\[76px\] w-full max-w-\[1512px\][^"]*px-4 md:px-8/)
  assert.doesNotMatch(components, /HeaderNavLink/)
  assert.match(read("../components/SectionNav.tsx"), /sticky top-\[76px\][^"]*-mx-4 px-4 md:-mx-8 md:px-8/)
})

test("a page's fixed bottom bar reserves its room after the footer, not inside main", () => {
  const shell = read("./GiwaPreprodApp.tsx")
  // The column that holds the sticky bar, <main> and the footer: padding here is the only in-flow room AFTER the footer
  // (html, body and #root are height:100%, so an element appended to <body> lands one viewport down, not at the end).
  const open = shell.indexOf('<div className="flex min-h-screen min-w-0 flex-col pb-[var(--giwa-dock-space,0px)]">')
  assert.ok(open > 0, "the shell column reserves a page's fixed bottom bar")
  // File order alone would also hold for a footer OUTSIDE that column: walk to the tag that closes it instead.
  let depth = 0
  let close = -1
  for (const match of shell.slice(open).matchAll(/<div\b|<\/div>/g)) {
    depth += match[0] === "</div>" ? -1 : 1
    if (depth === 0) {
      close = open + (match.index ?? 0)
      break
    }
  }
  assert.ok(close > open, "the padded column's closing tag")
  const column = shell.slice(open, close)
  assert.match(column, /<Footer links=\{GIWA_FOOTER_LINKS\} \/>/, "the footer is inside the padded column, so the room lands after it")
  assert.match(column, /<main\b/, "and so is main")
  // The only publisher today: the Stocks NVDA dock, while it is mounted.
  const views = read("./stocks-investor/StocksViews.tsx")
  assert.match(views, /const DOCK_SPACE_PROPERTY = "--giwa-dock-space"/)
  assert.match(views, /const DOCK_SPACE = "calc\(env\(safe-area-inset-bottom\) \+ 4\.5rem\)"/)
  assert.match(views, /style\.setProperty\(property, value\)/, "set on mount")
  assert.match(views, /style\.removeProperty\(property\)/, "removed on unmount")
})
