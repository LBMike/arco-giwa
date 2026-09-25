import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { adminConsoleTarget, isLegacyAdminPath } from "./admin-console-url"
import { AdminConsoleRedirect } from "./AdminConsoleRedirect"
import { GIWA_ADMIN_CONSOLE_URL } from "./config"

const CONSOLE = "https://admin.example.test"

test("legacy admin paths: /admin and everything under it, nothing else", () => {
  for (const path of ["/admin", "/admin/", "/admin/prices", "/admin/stocks", "/ADMIN/Config"]) assert.equal(isLegacyAdminPath(path), true, path)
  for (const path of ["/", "/administrator", "/stocks", "/funds", "/app/admin"]) assert.equal(isLegacyAdminPath(path), false, path)
})

test("legacy admin paths map to the console's matching section", () => {
  const cases: Array<[string, string]> = [
    ["/admin", "/"],
    ["/admin/", "/"],
    ["/admin/operations", "/vaults/operations"],
    ["/admin/prices", "/vaults/prices"],
    ["/admin/config", "/vaults/config"],
    ["/admin/featured", "/vaults/featured"],
    ["/admin/monitoring/", "/vaults/monitoring"],
    ["/admin/vaults", "/vaults"],
    ["/admin/stocks", "/stocks"],
    ["/admin/stocks/orders", "/stocks"],
    ["/ADMIN/Prices", "/vaults/prices"],
    ["/admin/unknown/deeper", "/"],
    ["/admin/operationsx", "/"],
  ]
  for (const [from, to] of cases) assert.equal(adminConsoleTarget(CONSOLE, from), `${CONSOLE}${to}`, from)
})

test("the configured address: trailing slash, a base path and local http are kept; query and hash are dropped", () => {
  assert.equal(adminConsoleTarget(`${CONSOLE}/`, "/admin/prices"), `${CONSOLE}/vaults/prices`)
  assert.equal(adminConsoleTarget(`${CONSOLE}/console?x=1#top`, "/admin/stocks"), `${CONSOLE}/console/stocks`)
  assert.equal(adminConsoleTarget("http://localhost:5174", "/admin"), "http://localhost:5174/")
})

test("an address that is not an absolute http(s) URL is refused", () => {
  for (const url of ["", "admin.arco.financial", "/admin-console", "javascript:alert(1)", "ftp://admin.example.test", "https://user:pw@admin.example.test"]) {
    assert.equal(adminConsoleTarget(url, "/admin"), null, url)
  }
})

test("redirect page: names the target with a link; a bad address shows an error and no link", () => {
  const render = (consoleUrl: string, path: string) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <AdminConsoleRedirect consoleUrl={consoleUrl} navigate={() => assert.fail("effects do not run on the server")} />
      </MemoryRouter>,
    )
  const moved = render(CONSOLE, "/admin/operations")
  assert.match(moved, /role="status"/)
  assert.match(moved, /href="https:\/\/admin\.example\.test\/vaults\/operations"/)
  const broken = render("admin.example.test", "/admin")
  assert.match(broken, /role="alert"/)
  assert.doesNotMatch(broken, /href=/)
})

test("without VITE_ADMIN_CONSOLE_URL (tests, local demo) the legacy in-app admin stays", () => {
  assert.equal(GIWA_ADMIN_CONSOLE_URL, undefined)
})
