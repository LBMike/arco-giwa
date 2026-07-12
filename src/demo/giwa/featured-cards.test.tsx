import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { GiwaFeaturedCarousel } from "./components"
import { hasDeploymentAddresses } from "./api"
import { vaultConfigOf } from "./catalog"
import type { GiwaCatalogItem, GiwaFeaturedCard, GiwaVaultConfig } from "./types"

const base: GiwaCatalogItem = {
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

function cfg(overrides: Partial<GiwaVaultConfig>): GiwaVaultConfig {
  return { ...vaultConfigOf({ vaultConfig: null }), ...overrides }
}

function vault(productId: string, symbol: string, overrides?: Partial<GiwaVaultConfig>): GiwaCatalogItem {
  return { ...base, productId, symbol, name: symbol, vaultConfig: overrides ? cfg(overrides) : null }
}

function fcard(productId: string, over: Partial<GiwaFeaturedCard> = {}): GiwaFeaturedCard {
  return { id: `fc-${productId}`, productId, about: null, shown: true, position: 0, ...over }
}

function render(cards: GiwaFeaturedCard[], catalog: GiwaCatalogItem[]): string {
  // MemoryRouter satisfies the carousel's useNavigate; renderToStaticMarkup emits a benign
  // "useLayoutEffect does nothing on the server" notice from react-router (no effect on output).
  return renderToStaticMarkup(
    <MemoryRouter>
      <GiwaFeaturedCarousel cards={cards} catalog={catalog} />
    </MemoryRouter>,
  )
}

test("carousel renders config-first: admin displayName + vaultImageUrl + card about", () => {
  const catalog = [vault("beqty", "bEQTY", { displayName: "Beta Equity", vaultImageUrl: "/logos/beqty.png" })]
  const html = render([fcard("beqty", { about: "Institutional equity vault" })], catalog)
  assert.match(html, /Beta Equity/) // config displayName, not the raw symbol
  assert.doesNotMatch(html, />bEQTY</) // raw symbol is not the heading
  assert.match(html, /Institutional equity vault/) // the admin card about
  assert.match(html, /\/logos\/beqty\.png/) // config-first logo
})

test("carousel about falls back to the product blurb when the card intro is blank", () => {
  const catalog = [vault("acapix", "aCAPIX", { displayName: "Arco CAPIX" })]
  const html = render([fcard("acapix", { about: null })], catalog)
  assert.match(html, /on GIWA Sepolia/) // productBlurb fallback (never blank)
})

test("carousel DROPS a card whose vault is absent from the (non-hidden) catalog", () => {
  // The first card's vault isn't in the catalog (hidden or de-registered) → it must not render;
  // the second card (present) renders instead.
  const catalog = [vault("acapix", "aCAPIX", { displayName: "Arco CAPIX" })]
  const cards = [
    fcard("gone-vault", { about: "must not appear", position: 0 }),
    fcard("acapix", { about: "visible one", position: 1 }),
  ]
  const html = render(cards, catalog)
  assert.doesNotMatch(html, /must not appear/)
  assert.match(html, /Arco CAPIX/)
  assert.match(html, /visible one/)
})

test("carousel renders nothing when no shown card resolves to a catalog vault", () => {
  const html = render([fcard("gone-vault")], [vault("acapix", "aCAPIX")])
  assert.doesNotMatch(html, /carousel-bg\.png/) // no hero rendered
})

test("picker eligibility gate: deployed AND not hidden (hidden or undeployed vaults excluded)", () => {
  const eligible = (product: GiwaCatalogItem) => hasDeploymentAddresses(product) && !vaultConfigOf(product).hidden
  const deployedVisible = vault("acapix", "aCAPIX", { displayName: "Arco CAPIX" })
  const deployedHidden = vault("hidden", "aHID", { hidden: true })
  const undeployed: GiwaCatalogItem = {
    ...vault("stub", "aSTUB"),
    productTokenAddress: null,
    depositVaultAddress: null,
    redemptionVaultAddress: null,
    priceFeedAddress: null,
  }
  assert.equal(eligible(deployedVisible), true)
  assert.equal(eligible(deployedHidden), false) // hidden vault must not be featurable
  assert.equal(eligible(undeployed), false) // undeployed vault must not be featurable
})
