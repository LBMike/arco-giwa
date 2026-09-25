import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createServer, isFileServingAllowed } from "vite"
import { CUSTOMER_UI_ENTRY, customerDynamicEnvironment, customerUiFileSystem, customerUiRedirect } from "./ui-config"

const ID = "11111111-2222-3333-4444-555555555555"

test("local investor entry paths share the customer screen and preserve their route and query", () => {
  for (const [path, destination] of [
    ["/", "/"], ["/index.html", "/"], ["/funds", "/funds"], ["/savings/", "/savings"],
    ["/portfolio", "/portfolio"], ["/stocks?symbol=NVDA", "/stocks?symbol=NVDA"],
    ["/product/digift-bny?tab=info", "/product/digift-bny?tab=info"],
    ["/app", "/"], ["/app/giwa-preprod", "/"], ["/app/stocks?symbol=SOXL", "/stocks?symbol=SOXL"],
    ["/app/giwa-preprod/portfolio", "/portfolio"],
  ]) for (const method of ["GET", "HEAD"]) {
    assert.equal(customerUiRedirect(method, path, true), `${CUSTOMER_UI_ENTRY}#${destination}`)
  }
})

test("customer entry redirects do not intercept API, admin, assets, other modes or unsafe targets", () => {
  for (const path of [CUSTOMER_UI_ENTRY, `${CUSTOMER_UI_ENTRY}?debug=1`, "/api/v1/stocks/catalog", "/ready/stocks",
    "/admin/stocks", "/app/admin/stocks", "/app/giwa-preprod/admin/stocks", "/src/main.tsx", "/@vite/client",
    "/logos/usdc.svg", "/.secrets/alpaca.env", "/private/server.json", "/stocks-unknown", "/product/../admin",
    "//example.com/stocks", "https://example.com/stocks", "/stocks#fragment", "/stocks?x=\r\nLocation: https://example.com",
  ]) assert.equal(customerUiRedirect("GET", path, true), null, path)
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) assert.equal(customerUiRedirect(method, "/stocks", true), null)
  assert.equal(customerUiRedirect("GET", "/stocks", false), null)
})

test("local customer startup requires one explicit public Dynamic project without an injected fallback", () => {
  assert.equal(customerDynamicEnvironment([], false, false), "")
  assert.equal(customerDynamicEnvironment([], true, false), "")
  assert.throws(() => customerDynamicEnvironment([], true, true), /LOCAL_DYNAMIC_ENVIRONMENT_REQUIRED/)
  assert.equal(customerDynamicEnvironment(["--dynamic-environment", ID], true, true), ID)
  for (const argv of [["--dynamic-environment"], ["--dynamic-environment", "https://example.com"], ["--dynamic-environment", ID, "--dynamic-environment", ID]]) {
    assert.throws(() => customerDynamicEnvironment(argv, true, true), /INVALID_DYNAMIC_ENVIRONMENT/)
  }
  assert.throws(() => customerDynamicEnvironment(["--dynamic-environment", ID], false, false), /INVALID_DYNAMIC_ENVIRONMENT/)
})

test("external dependency fonts are served while private bundle files and secret paths stay denied", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "arco-ui-fs-test-")))
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    const root = join(temp, "source"), dependencies = join(temp, "dependencies/node_modules")
    await mkdir(root, { recursive: true }); await mkdir(dependencies, { recursive: true })
    await symlink(dependencies, join(root, "node_modules"), "dir")
    const fonts = []
    for (const font of ["geist", "inter", "roboto-slab"]) {
      const dir = join(dependencies, "@fontsource-variable", font, "files")
      await mkdir(dir, { recursive: true })
      const file = join(dir, "public.woff2"); await writeFile(file, "font-fixture"); fonts.push(file)
    }
    const index = join(root, "index.html"); await writeFile(index, "<html></html>")
    const forbidden = [join(temp, "private/server.json"), join(root, ".env.local"), join(root, ".secrets/alpaca.env"), join(dependencies, "private.json")]
    for (const file of forbidden) { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, "private-fixture") }
    server = await createServer({ root, configFile: false, envDir: join(temp, "empty-env"), cacheDir: join(temp, "cache"), logLevel: "silent",
      server: { middlewareMode: true, watch: null, fs: customerUiFileSystem(root) } })
    assert.equal(isFileServingAllowed(index, server), true)
    for (const file of fonts) assert.equal(isFileServingAllowed(file, server), true, file)
    for (const file of forbidden) assert.equal(isFileServingAllowed(file, server), false, file)
  } finally { await server?.close(); await rm(temp, { recursive: true, force: true }) }
})
