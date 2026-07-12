import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaInvestPanel } from "./components"
import type { GiwaCatalogItem } from "./types"

// GiwaInvestPanel must refuse to submit an amount the wallet can't cover: the primary button
// flips to a DISABLED "Insufficient Balance" instead of reverting with
// "ERC20: transfer amount exceeds balance". The paying token is tUSDC on Invest and the product
// token (shares) on Redeem — the same balance the panel shows above the field / behind MAX.

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
} as unknown as GiwaCatalogItem

function panelProps(over: Record<string, unknown> = {}) {
  return {
    product,
    price: 1,
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
    onOperationChange: () => undefined,
    onAmountChange: () => undefined,
    onRequestIdChange: () => undefined,
    onApprove: () => undefined,
    onSubmit: () => undefined,
    onRequestRedeem: () => undefined,
    onClaim: () => undefined,
    onConnect: () => undefined,
    onSwitchNetwork: () => undefined,
    ...over,
  }
}

type PanelProps = Parameters<typeof GiwaInvestPanel>[0]

const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<GiwaInvestPanel {...(panelProps(over) as unknown as PanelProps)} />)

// The opening tag of the button whose label this is (last occurrence = the primary button, not
// the Invest/Redeem tab of the same name).
function primaryButtonTag(html: string, label: string): string {
  const at = html.lastIndexOf(label)
  assert.ok(at > -1, `"${label}" is not rendered`)
  const start = html.lastIndexOf("<button", at)
  return html.slice(start, html.indexOf(">", start) + 1)
}

test("Invest: pay amount over the tUSDC balance → disabled 'Insufficient Balance'", () => {
  const html = render({ operation: "deposit", amount: "1000", paymentBalance: "100" })
  assert.match(html, /Insufficient Balance/)
  assert.match(primaryButtonTag(html, "Insufficient Balance"), /disabled=""/)
})

test("Redeem: redeem amount over the product-token balance → disabled 'Insufficient Balance'", () => {
  const html = render({ operation: "redeemInstant", amount: "10", productBalance: "5" })
  assert.match(html, /Insufficient Balance/)
  assert.match(primaryButtonTag(html, "Insufficient Balance"), /disabled=""/)
  assert.doesNotMatch(html, /Redeem instant/) // the normal action label is superseded
})

test("amount within balance keeps the normal action label, enabled", () => {
  const invest = render({ operation: "deposit", amount: "5", paymentBalance: "100" })
  assert.doesNotMatch(invest, /Insufficient Balance/)
  assert.doesNotMatch(primaryButtonTag(invest, "Invest"), /disabled=""/)

  const redeem = render({ operation: "redeemInstant", amount: "2", productBalance: "5" })
  assert.doesNotMatch(redeem, /Insufficient Balance/)
  assert.match(redeem, /Redeem instant/)
})

test("a MAX-filled amount equals the balance exactly — never 'over'", () => {
  const html = render({ operation: "deposit", amount: "100", paymentBalance: "100" })
  assert.doesNotMatch(html, /Insufficient Balance/)
  // Same for shares on the redeem side (18-dec), where float math would otherwise bite.
  const redeem = render({ operation: "redeemInstant", amount: "0.1", productBalance: "0.1" })
  assert.doesNotMatch(redeem, /Insufficient Balance/)
})

test("empty / zero amount keeps the existing state (no Insufficient Balance)", () => {
  for (const amount of ["", "0", "0.0", "1."]) {
    const html = render({ operation: "deposit", amount, paymentBalance: "0" })
    assert.doesNotMatch(html, /Insufficient Balance/, `amount ${JSON.stringify(amount)}`)
  }
})

test("PRECEDENCE: insufficient balance outranks the redeem request-redemption fallback", () => {
  // payout (10 × price 1 × baseUsd 1 = $10) exceeds instant liquidity ($1) → normally the panel
  // would offer "Request redemption". But the wallet holds only 5 shares, so it can't act at all.
  const html = render({
    operation: "redeemInstant",
    amount: "10",
    productBalance: "5",
    price: 1,
    baseUsd: 1,
    instantLiquidityUsd: 1,
  })
  assert.match(html, /Insufficient Balance/)
  assert.doesNotMatch(html, /Request redemption/) // fallback label superseded
  assert.doesNotMatch(html, /Instant liquidity is/) // and its now-moot notice is hidden
  assert.match(primaryButtonTag(html, "Insufficient Balance"), /disabled=""/)
})

test("PRECEDENCE: insufficient balance outranks Approve (a disabled button must say why)", () => {
  const html = render({ operation: "deposit", amount: "1000", paymentBalance: "100", allowanceRequired: true })
  assert.match(html, /Insufficient Balance/)
  assert.doesNotMatch(html, /Approve/)
})

test("wallet-prerequisite phases still win — a disconnected wallet shows Connect Wallet", () => {
  // Balance reads 0 while disconnected; "Insufficient Balance" would be misleading there.
  const html = render({ operation: "deposit", amount: "1000", paymentBalance: "0", phase: "disconnected" })
  assert.match(html, /Connect Wallet/)
  assert.doesNotMatch(html, /Insufficient Balance/)
})

test("the '--' balance placeholder never reads as insufficient", () => {
  const html = render({ operation: "deposit", amount: "5", paymentBalance: "--" })
  assert.doesNotMatch(html, /Insufficient Balance/)
})
