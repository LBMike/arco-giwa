import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ARCOUSD_OPTION,
  CONVERT_OPTIONS,
  convertChoices,
  converterFor,
  convertProduct,
  defaultConvertOption,
  type ArcoUsdConvert,
} from "./arcousd-convert"
import { GetArcoUsdButton } from "./GetArcoUsd"
import { operationFlowView, type OperationFlow, type OperationReview } from "./operation-flow"
import { ArcoUsdConvertContext } from "./savings-routes"

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const
const convert: ArcoUsdConvert = {
  token: address(0xa1),
  priceFeed: address(0xa2),
  converters: [
    { option: "usdc-giwa", token: address(0x10), converter: address(0x20) },
    { option: "usdt-ethereum", token: address(0x11), converter: address(0x21) },
  ],
}

test("Get ArcoUSD's coins: every Savings stablecoin but ArcoUSD, which is GIWA's, at 18 decimals", () => {
  assert.deepEqual(
    CONVERT_OPTIONS.map((option) => option.key),
    ["usdc-ethereum", "usdc-giwa", "usdt-ethereum", "rlusd-ethereum", "rlusd-xrpl"],
  )
  assert.deepEqual(
    [ARCOUSD_OPTION.key, ARCOUSD_OPTION.symbol, ARCOUSD_OPTION.chain, ARCOUSD_OPTION.decimals, ARCOUSD_OPTION.logo],
    ["arcousd-giwa", "ArcoUSD", "giwa", 18, "/logos/arcousd.png"],
  )
})

test("a conversion runs as a vault of its own: the coin pays, ArcoUSD is minted, the converter is both its vaults", () => {
  const usdt = CONVERT_OPTIONS.find((option) => option.key === "usdt-ethereum")!
  const product = convertProduct(convert, usdt, converterFor(convert, "usdt-ethereum")!)
  assert.deepEqual(product, {
    productId: "arcousd-convert-usdt-ethereum",
    symbol: "ArcoUSD",
    name: "Arco USD",
    paymentAssetSymbol: "USDT",
    paymentAsset: { symbol: "USDT", name: "Tether USD", decimals: 6, tokenAddress: address(0x11) },
    paymentAssetAddress: address(0x11),
    productTokenAddress: address(0xa1),
    depositVaultAddress: address(0x21),
    redemptionVaultAddress: address(0x21),
    priceFeedAddress: address(0xa2),
    vaultConfig: null,
    pauseState: null,
  })
  assert.equal(converterFor(convert, "rlusd-xrpl"), null)
})

test("a conversion starts on USDC on GIWA when it has a converter, else on the first coin that has one", () => {
  assert.equal(defaultConvertOption(convert).key, "usdc-giwa")
  assert.equal(defaultConvertOption({ ...convert, converters: convert.converters.slice(1) }).key, "usdt-ethereum")
})

test("picker rows: a coin is available with a converter; the paying side lists ArcoUSD too, last; a coin is a dollar", () => {
  const balances = { "usdc-giwa": 9000, "usdt-ethereum": 10000, "arcousd-giwa": 500, "usdc-ethereum": 7 }
  const pay = convertChoices(convert, balances, true)
  assert.deepEqual(pay.map((choice) => choice.key), [...CONVERT_OPTIONS.map((option) => option.key), "arcousd-giwa"])
  assert.deepEqual(pay.filter((choice) => choice.available).map((choice) => choice.key), ["usdc-giwa", "usdt-ethereum", "arcousd-giwa"])
  assert.deepEqual(
    pay.map((choice) => [choice.key, choice.balance, choice.usd]).filter(([, balance]) => balance !== null),
    [["usdc-giwa", 9000, 9000], ["usdt-ethereum", 10000, 10000], ["arcousd-giwa", 500, 500]],
    "a coin without a converter shows no balance (it is coming soon)",
  )
  // The coin received on the way back is a stablecoin: no ArcoUSD row.
  assert.ok(!convertChoices(convert, balances, false).some((choice) => choice.key === "arcousd-giwa"))
  assert.equal(convertChoices({ ...convert, converters: [] }, {}, true).some((choice) => choice.available), false)
})

test("Get ArcoUSD reads as a conversion either way: its steps, its approval and its result", () => {
  const review: OperationReview = {
    kind: "convert",
    operation: "deposit",
    productName: "Arco USD",
    pay: { amount: "1,000", symbol: "USDT", icon: null, sub: "~$1,000.00" },
    receive: { amount: "1,000", symbol: "ArcoUSD", icon: null, sub: "~$1,000.00" },
    apyText: "—",
  }
  const flow: OperationFlow = {
    id: 1,
    review,
    steps: [
      { id: "approve", state: "done" },
      { id: "submit", state: "done" },
    ],
    outcome: { kind: "success", hash: "0xabc", received: "1,000" },
    open: true,
  }
  const view = operationFlowView(flow)
  assert.equal(view.title, "Review conversion")
  assert.deepEqual(view.steps.map((step) => step.label), ["Approve USDT", "Confirm conversion"])
  assert.match(view.steps[0]!.help!.answer, /^Approving lets this converter take USDT from your wallet\./)
  assert.deepEqual([view.result?.title, view.result?.message, view.result?.to], ["Conversion complete!", "1,000 ArcoUSD is in your wallet.", { amount: "1,000", symbol: "ArcoUSD" }])
  const back = operationFlowView({
    ...flow,
    review: { ...review, operation: "redeemInstant", pay: { ...review.pay, symbol: "ArcoUSD" }, receive: { ...review.receive, amount: "500", symbol: "RLUSD" } },
    steps: [{ id: "submit", state: "processing" }],
    outcome: null,
  })
  assert.deepEqual([back.steps[0]!.processingLabel, back.steps[0]!.walletLabel], ["Conversion pending…", "Confirm conversion in your wallet"])
  const done = operationFlowView({ ...flow, review: { ...review, operation: "redeemInstant", receive: { ...review.receive, symbol: "RLUSD" } }, outcome: { kind: "success", hash: "0x1", received: null } })
  assert.deepEqual([done.result?.title, done.result?.message], ["Conversion complete!", "Your RLUSD is in your wallet."])
})

test("Get ArcoUSD shows only where there are converters: ArcoUSD's mark, its name from sm (screen readers always)", () => {
  assert.equal(renderToStaticMarkup(<GetArcoUsdButton />), "")
  assert.equal(
    renderToStaticMarkup(
      <ArcoUsdConvertContext.Provider value={{ ...convert, converters: [] }}>
        <GetArcoUsdButton />
      </ArcoUsdConvertContext.Provider>,
    ),
    "",
  )
  const html = renderToStaticMarkup(
    <ArcoUsdConvertContext.Provider value={convert}>
      <GetArcoUsdButton />
    </ArcoUsdConvertContext.Provider>,
  )
  assert.match(html, /^<button type="button" aria-haspopup="dialog" class="[^"]*">/)
  assert.match(html, /<img src="\/logos\/arcousd\.png" alt="" width="20" height="20" class="size-5 shrink-0 rounded-\[var\(--radius-pill\)\]"\/>/)
  assert.match(html, /<span class="sr-only sm:not-sr-only">Get ArcoUSD<\/span><\/button>$/)
  // The screen is not loaded until the first press.
  assert.doesNotMatch(html, /Convert/)
})
