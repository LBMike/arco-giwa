import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaInvestDock } from "./GiwaInvestDock"
import { GiwaInvestPanel } from "./components"
import type { GiwaCatalogItem } from "./types"

const product: GiwaCatalogItem = {
  productId: "acapix",
  symbol: "aCAPIX",
  name: "Arco CAPIX",
  paymentAssetSymbol: "tUSDC",
  paymentAsset: {
    symbol: "tUSDC",
    name: "Test USDC",
    decimals: 6,
    contract: { proxy: "0x00000000000000000000000000000000000000a1" },
    faucet: "0x00000000000000000000000000000000000000f1",
  },
  paymentAssetAddress: "0x00000000000000000000000000000000000000A1",
  productTokenAddress: "0x00000000000000000000000000000000000000b1",
  depositVaultAddress: "0x00000000000000000000000000000000000000c1",
  redemptionVaultAddress: "0x00000000000000000000000000000000000000d1",
  priceFeedAddress: "0x00000000000000000000000000000000000000e1",
}

function panelProps() {
  return {
    product,
    operation: "deposit" as const,
    amount: "5",
    requestId: "1",
    paymentBalance: "100",
    productBalance: "0",
    allowance: "1000",
    allowanceRequired: false,
    greenlistEnforced: false,
    activeVault: product.depositVaultAddress,
    phase: "ready" as const,
    pausedNotice: null,
    error: null,
    txHashes: [] as string[],
    pendingRedemptions: [],
    instantLiquidityUsd: null,
    baseUsd: null,
    onOperationChange: () => undefined,
    onAmountChange: () => undefined,
    onRequestIdChange: () => undefined,
    onApprove: () => undefined,
    onSubmit: () => undefined,
    onRequestRedeem: () => undefined,
    onClaim: () => undefined,
    onConnect: () => undefined,
    onSwitchNetwork: () => undefined,
  }
}

test("mobile dock renders a sticky Invest/Redeem bottom bar (lg:hidden) with no sheet by default", () => {
  const html = renderToStaticMarkup(<GiwaInvestDock {...panelProps()} />)
  // Mobile-only wrapper + fixed sticky bar using the header's page-80 token.
  assert.match(html, /lg:hidden/)
  assert.match(html, /fixed inset-x-0 bottom-0/)
  assert.match(html, /bg-\[var\(--color-arco-page-80\)\]/)
  // The two bar actions.
  assert.match(html, />\s*Invest\s*</)
  assert.match(html, />\s*Redeem\s*</)
  // Sheet is closed by default => not mounted (so SSR renders no second GiwaInvestPanel).
  assert.doesNotMatch(html, /role="dialog"/)
  assert.doesNotMatch(html, /Amount to redeem/)
})

test("GiwaInvestPanel variant='sheet' drops the sticky offset; default 'sidebar' keeps it byte-identical", () => {
  const sidebar = renderToStaticMarkup(<GiwaInvestPanel {...panelProps()} />)
  assert.match(sidebar, /sticky top-\[104px\]/)

  const sheet = renderToStaticMarkup(<GiwaInvestPanel {...panelProps()} variant="sheet" />)
  assert.doesNotMatch(sheet, /sticky top-\[104px\]/)
  // Same surface card otherwise (no logic/tab change).
  assert.match(sheet, /rounded-\[var\(--radius-strategy\)\]/)
})
