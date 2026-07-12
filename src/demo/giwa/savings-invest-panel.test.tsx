import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaInvestPanel } from "./components"
import type { GiwaCatalogItem } from "./types"

type PanelProps = Parameters<typeof GiwaInvestPanel>[0]

function product(): GiwaCatalogItem {
  return {
    productId: "aeth",
    symbol: "aETH",
    paymentAssetSymbol: "tWETH",
    paymentAsset: { symbol: "tWETH", name: "Test WETH", decimals: 18 },
    vaultConfig: null,
    productTokenAddress: null,
    paymentAssetAddress: null,
    depositVaultAddress: null,
    redemptionVaultAddress: null,
    priceFeedAddress: null,
  } as unknown as GiwaCatalogItem
}

function panelProps(over: Partial<PanelProps> = {}): PanelProps {
  return {
    product: product(),
    price: 1,
    operation: "deposit",
    amount: "137",
    requestId: "1",
    paymentBalance: "1000",
    productBalance: "1000",
    allowance: "1000",
    allowanceRequired: false,
    greenlistEnforced: false,
    activeVault: null,
    phase: "ready",
    error: null,
    txHashes: [],
    pendingRedemptions: [],
    instantLiquidityUsd: 500_000,
    baseUsd: 1,
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
  } as PanelProps
}

const render = (over: Partial<PanelProps> = {}) => renderToStaticMarkup(<GiwaInvestPanel {...panelProps(over)} />)

test("savings mode: footer = APY / Est. Annual Yield / Redemption Timeline (Invest tab)", () => {
  const html = render({ operation: "deposit", amount: "137", savings: { apyText: "4%", apyPercent: 4, acceptAssetIcon: "/accept-asset/eth-mark.png" } })
  assert.match(html, /Est\. Annual Yield/)
  assert.match(html, /Redemption Timeline/)
  assert.match(html, /4%/) // APY row value
  assert.match(html, /5\.48/) // 137 × 4% = 5.48, house format (max 2 dec, no trailing zeros)
  assert.match(html, /accept-asset\/eth-mark\.png/) // accept-asset logo node
  assert.doesNotMatch(html, /Instant liquidity/) // hidden in savings mode
  assert.doesNotMatch(html, /Transaction Fees/) // hidden in savings mode
})

test("savings mode works on the Redeem tab too (amount × APY, accept-asset logo)", () => {
  const html = render({ operation: "redeemInstant", amount: "137", savings: { apyText: "6%", apyPercent: 6, acceptAssetIcon: "/accept-asset/eth-mark.png" } })
  assert.match(html, /Est\. Annual Yield/)
  assert.match(html, /8\.22/) // 137 × 6% = 8.22
  assert.doesNotMatch(html, /Transaction Fees/) // footer-only row, hidden in savings mode
})

test("Est. Annual Yield: logo omitted when icon null; '—' (no number) when amount empty/invalid or APY null", () => {
  const ICON = "/accept-asset/eth-mark.png" // distinctive — could only come from the savings prop

  const nullIcon = render({ amount: "137", savings: { apyText: "4%", apyPercent: 4, acceptAssetIcon: null } })
  assert.match(nullIcon, /Est\. Annual Yield/)
  assert.doesNotMatch(nullIcon, /accept-asset\/eth-mark\.png/) // logo omitted when icon is null

  const emptyAmount = render({ amount: "", savings: { apyText: "4%", apyPercent: 4, acceptAssetIcon: ICON } })
  assert.doesNotMatch(emptyAmount, /5\.48/) // no yield number when amount is empty

  const noApy = render({ amount: "137", savings: { apyText: "—", apyPercent: null, acceptAssetIcon: ICON } })
  assert.doesNotMatch(noApy, /5\.48/) // no yield number when apyPercent is null
})

test("without the savings prop the footer stays byte-identical (product-detail path)", () => {
  const html = render({ operation: "deposit" }) // no savings prop
  assert.match(html, /Instant liquidity/)
  assert.match(html, /Transaction Fees/)
  assert.doesNotMatch(html, /Est\. Annual Yield/) // savings footer stays off
})
