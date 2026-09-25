import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { validDynamicEnvironmentId } from "../../src/demo/giwa/investor-shell/verification/customer-wallet"

export const CUSTOMER_UI_ENTRY = "/src/demo/giwa/investor-shell/verification/index.html"

/** One local customer entry, including old bookmarks; API/admin/assets never redirect. */
export function customerUiRedirect(method: string, target: string, localCustomer: boolean): string | null {
  if (!localCustomer || !["GET", "HEAD"].includes(method) || !target.startsWith("/")
    || target.startsWith("//") || /[\u0000-\u001f\u007f#]/.test(target)) return null
  const queryAt = target.indexOf("?")
  let path = queryAt < 0 ? target : target.slice(0, queryAt)
  const query = queryAt < 0 ? "" : target.slice(queryAt)
  if (path === "/index.html") path = "/"
  else {
    path = path.replace(/^\/app\/giwa-preprod(?=\/|$)/, "").replace(/^\/app(?=\/|$)/, "")
    path = path.replace(/\/$/, "") || "/"
  }
  if (!["/", "/funds", "/savings", "/portfolio", "/stocks"].includes(path)
    && !/^\/product\/[A-Za-z0-9_-]+$/.test(path)) return null
  return `${CUSTOMER_UI_ENTRY}#${path}${query}`
}

export function customerDynamicEnvironment(argv: readonly string[], customerReads: boolean, localCustomer: boolean): string {
  const positions = argv.flatMap((arg, index) => arg === "--dynamic-environment" ? [index] : [])
  if (!positions.length) {
    if (localCustomer) throw new Error("LOCAL_DYNAMIC_ENVIRONMENT_REQUIRED")
    return ""
  }
  const value = argv[positions[0]! + 1] ?? ""
  if (positions.length !== 1 || !customerReads || !validDynamicEnvironmentId(value)) throw new Error("INVALID_DYNAMIC_ENVIRONMENT")
  return value
}

/** The dependency symlink is outside source; only public font files need serving. */
export function customerUiFileSystem(root: string) {
  return {
    strict: true,
    allow: [realpathSync(root), ...["geist", "inter", "roboto-slab"].map(font => realpathSync(resolve(root, "node_modules/@fontsource-variable", font, "files")))],
    deny: ["**/.env*", "**/*.{crt,pem}", "**/.git/**", "**/.secrets/**"],
  }
}
