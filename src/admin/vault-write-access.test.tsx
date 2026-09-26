import assert from "node:assert/strict"
import test from "node:test"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { GiwaAdminContext, type GiwaAdminContextValue } from "../demo/giwa/admin-context"
import { roleCheckOf } from "../demo/giwa/admin-roles"
import { bearerSessionAuth } from "../demo/giwa/api"
import GiwaAdminConfigPage from "../demo/giwa/AdminConfig"
import GiwaAdminFeaturedPage from "../demo/giwa/AdminFeatured"
import { PriceFeedAdminPanel } from "../demo/giwa/PriceFeedAdminPanel"
import { READ_ONLY_VAULT_REASON } from "./console-model"
import { ReadOnlyNotice } from "./ConsoleViews"

const wallet = { address: null, connected: false, chainId: null, signingReady: false } as unknown as GiwaAdminContextValue["wallet"]
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ")

function render(node: ReactNode, canWrite: boolean) {
  const value: GiwaAdminContextValue = {
    auth: bearerSessionAuth("header.payload.signature"),
    canWrite,
    readOnlyReason: canWrite ? null : READ_ONLY_VAULT_REASON,
    wallet,
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <GiwaAdminContext.Provider value={value}>{node}</GiwaAdminContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

test("without vault:write the reused Vault pages disable every write group; with it none is disabled", () => {
  for (const page of [<GiwaAdminFeaturedPage key="featured" />, <GiwaAdminConfigPage key="config" />]) {
    const readOnly = render(page, false)
    assert.match(readOnly, /<fieldset disabled=""[^>]*data-admin-write="disabled"/)
    assert.doesNotMatch(readOnly, /data-admin-write="enabled"/)
    assert.match(readOnly, /title="Read only: this operator has vault:read without vault:write\."/)
    const writable = render(page, true)
    assert.match(writable, /data-admin-write="enabled"/)
    assert.doesNotMatch(writable, /<fieldset disabled/)
  }
  assert.match(text(renderToStaticMarkup(<ReadOnlyNotice />)), /Write controls are disabled/)
})

test("price posting states why it is unavailable to a read-only operator", () => {
  const product = {
    productId: "acapix",
    symbol: "aCAPIX",
    paymentAssetSymbol: "tUSDC",
    priceFeedAddress: "0x00000000000000000000000000000000000000f1",
    productTokenAddress: "0x00000000000000000000000000000000000000f2",
    depositVaultAddress: "0x00000000000000000000000000000000000000f3",
    redemptionVaultAddress: "0x00000000000000000000000000000000000000f4",
    paymentAssetAddress: "0x00000000000000000000000000000000000000f5",
  } as never
  const readOnly = text(render(<PriceFeedAdminPanel product={product} auth={bearerSessionAuth("t")} walletAddress={null} />, false))
  assert.match(readOnly, /Read only: this operator has vault:read without vault:write\./)
  const writable = text(render(<PriceFeedAdminPanel product={product} auth={bearerSessionAuth("t")} walletAddress={null} />, true))
  assert.doesNotMatch(writable, /Read only: this operator/)
})

test("a wallet without the on-chain role is told why before it signs; an unreadable role never blocks", () => {
  const wallet = "0x00000000000000000000000000000000000000a1"
  assert.deepEqual(roleCheckOf("FEED_ADMIN_ROLE", "price feed", wallet, true), { status: "granted" })
  assert.deepEqual(roleCheckOf("FEED_ADMIN_ROLE", "price feed", wallet, undefined), { status: "unknown" })
  assert.deepEqual(roleCheckOf("PAUSER_ROLE", "deposit vault", null, false), { status: "unknown" })
  const missing = roleCheckOf("PAUSER_ROLE", "deposit vault", wallet, false)
  assert.equal(missing.status, "missing")
  assert.match(missing.status === "missing" ? missing.message : "", /does not hold PAUSER_ROLE on the deposit vault, so this transaction would revert/)
})
