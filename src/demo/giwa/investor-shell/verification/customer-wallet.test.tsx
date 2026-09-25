import assert from "node:assert/strict"
import test from "node:test"
import { customerWalletRequestAllowed } from "./customer-wallet"

const ID = "11111111-2222-3333-4444-555555555555"
const sdk = `https://app.dynamicauth.com/api/v0/sdk/${ID}/`

test("connected customer wallet permits only the configured SDK project and public wallet book", () => {
  for (const [method, path] of [["GET", "settings?sdkVersion=4.91.2"], ["GET", "nonce"], ["POST", "verify"], ["POST", "emailVerifications"], ["DELETE", "session"]]) {
    assert.equal(customerWalletRequestAllowed(new URL(sdk + path), method!, ID), true)
  }
  const book = new URL("https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json")
  assert.equal(customerWalletRequestAllowed(book, "GET", ID), true)
  assert.equal(customerWalletRequestAllowed(book, "POST", ID), false)
  assert.equal(customerWalletRequestAllowed(book, "GET", ""), false)
})

test("wallet egress rejects another project, encoded escapes, wrong origins and missing configuration", () => {
  for (const url of [
    sdk.replace(ID, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee") + "settings",
    sdk + "../settings", sdk + "%2e%2e/settings",
    sdk.replace("https:", "http:") + "verify",
    sdk.replace("app.dynamicauth.com", "app.dynamicauth.com.evil.invalid") + "verify",
    sdk.replace("app.dynamicauth.com", "evil.invalid@app.dynamicauth.com") + "verify",
    sdk + "verify#fragment", "https://app.dynamicauth.com/api/v0/environments",
    "https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json?unexpected=1",
    "https://dynamic-static-assets.com/other.json",
  ]) assert.equal(customerWalletRequestAllowed(new URL(url), "GET", ID), false, url)
  assert.equal(customerWalletRequestAllowed(new URL(sdk + "settings"), "GET", ""), false)
  assert.equal(customerWalletRequestAllowed(new URL(sdk + "settings"), "GET", "../invalid"), false)
  assert.equal(customerWalletRequestAllowed(new URL(sdk + "settings"), "CONNECT", ID), false)
})
