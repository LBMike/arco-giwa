import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { AmountBlock, AmountField, InfoRow, type AmountFieldProps } from "./invest-panel-ui"

// The presentational pieces moved out of components.tsx. With no optional prop they must render exactly what the GIWA
// invest panel rendered before the move (the expected strings are that panel's own output); the optional props only
// add what the Stocks trade panel needs.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const MUTED = /[^\s"]*color-arco-muted[^\s"]*/g

const PAY_FIELD =
  '<div class="p-3"><div class="flex items-center justify-between gap-2"><p class="text-xs text-[var(--color-arco-muted)]">You pay</p><div class="flex items-center gap-1.5"><span class="text-[11px] text-[var(--color-arco-muted)]">Balance: 100</span><button type="button" class="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-arco-text-soft)]">MAX</button></div></div><div class="mt-1 flex items-center justify-between gap-2"><span class="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-[var(--color-arco-ink)]">tUSDC<button type="button" aria-label="Copy tUSDC address" class="inline-flex text-[var(--color-arco-muted)]"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy size-3.5"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg></button></span><input inputMode="decimal" class="w-full bg-transparent text-right tabular-nums text-lg text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]" placeholder="0.0" value="5"/></div><p class="mt-0.5 text-right tabular-nums text-[11px] text-[var(--color-arco-muted)]">~$5.00</p></div>'
const INFO_ROW =
  '<div class="flex items-center justify-between border-t border-[var(--color-arco-border)] py-2.5 text-sm"><span class="text-[var(--color-arco-text-soft)]">Redemption Timeline</span><span class="tabular-nums text-[var(--color-arco-ink)]">30-90 Business Days</span></div>'
const INFO_ROW_EXPANDABLE =
  '<div class="border-t border-[var(--color-arco-border)]"><button type="button" aria-expanded="false" class="flex w-full items-center justify-between py-2.5 text-sm"><span class="text-[var(--color-arco-text-soft)]">Transaction Fees</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down size-3.5 text-[var(--color-arco-muted)] transition-transform"><path d="m6 9 6 6 6-6"></path></svg></button></div>'
const BLOCK_OPEN =
  '<div class="relative divide-y divide-[var(--color-arco-border)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">'

const payField = (over: Partial<AmountFieldProps> = {}) =>
  renderToStaticMarkup(<AmountField caption="You pay" symbol="tUSDC" value="5" onChange={() => undefined} balance="100" onMax={() => undefined} subValue="~$5.00" {...over} />)

/** The <input> element of an AmountField, found in the element tree the component returns (it uses no hooks). */
function inputOf(props: AmountFieldProps): ReactElement<{ onChange: (event: { target: { value: string } }) => void }> {
  const seen: ReactElement[] = []
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (isValidElement(node)) {
      seen.push(node)
      walk((node.props as { children?: ReactNode }).children)
    }
  }
  walk(AmountField(props))
  const input = seen.find((element) => element.type === "input")
  assert.ok(input, "an <input> element")
  return input as ReactElement<{ onChange: (event: { target: { value: string } }) => void }>
}

test("defaults render the GIWA invest panel's markup byte for byte", () => {
  assert.equal(payField(), PAY_FIELD)
  assert.equal(renderToStaticMarkup(<InfoRow label="Redemption Timeline" value="30-90 Business Days" />), INFO_ROW)
  assert.equal(renderToStaticMarkup(<InfoRow label="Transaction Fees" expandable>body</InfoRow>), INFO_ROW_EXPANDABLE)
  assert.ok(renderToStaticMarkup(<AmountBlock>x</AmountBlock>).startsWith(`${BLOCK_OPEN}x<span class="pointer-events-none absolute`))
})

test("id makes the caption the input's label; ariaLabel names the input", () => {
  const html = payField({ id: "qty", ariaLabel: "Quantity (NVDA)" })
  assert.match(html, /<label for="qty" class="text-xs text-\[var\(--color-arco-muted\)\]">You pay<\/label>/)
  assert.match(html, /<input id="qty" aria-label="Quantity \(NVDA\)" inputMode="decimal"/)
  assert.doesNotMatch(html, /<p class="text-xs/)
})

test("copyButton={false} drops the copy control; symbolNote follows the symbol", () => {
  const html = payField({ copyButton: false, symbolNote: <span>Test units</span> })
  assert.doesNotMatch(html, /Copy tUSDC address|lucide-copy/)
  assert.match(html, />tUSDC<span>Test units<\/span><\/span>/)
})

test("display mode renders the value as text and no <input> at all", () => {
  const html = payField({ display: true, value: "—", subValue: "Shown after the server quote", id: "cash", onMax: undefined, balance: undefined })
  assert.doesNotMatch(html, /<input/)
  assert.match(html, /<p id="cash" class="min-w-0 text-right tabular-nums text-lg text-\[var\(--color-arco-ink\)\] \[overflow-wrap:anywhere\]">—<\/p>/)
  // No input, so the caption is not a <label>.
  assert.match(html, /<p class="text-xs[^"]*">You pay<\/p>/)
  assert.match(html, /Shown after the server quote/)
})

test("balanceLabel, soft tone and the extra classes; muted stays on the placeholder only", () => {
  const html = payField({ balanceLabel: "Available to sell", balance: "2 NVDA", tone: "soft", copyButton: false, className: "ring-x", maxClassName: "focus-x" })
  assert.match(html, /Available to sell: 2 NVDA/)
  assert.match(html, /^<div class="p-3 ring-x">/)
  assert.match(html, /text-\[var\(--color-arco-text-soft\)\] focus-x">MAX<\/button>/)
  assert.deepEqual(html.match(MUTED), ["placeholder:text-[var(--color-arco-muted)]"])
  const block = renderToStaticMarkup(<AmountBlock tone="soft" invalid>x</AmountBlock>)
  assert.match(block, /border border-\[var\(--color-arco-down\)\] bg-/)
  assert.equal(block.match(MUTED), null)
  const row = renderToStaticMarkup(<InfoRow label="Order details" expandable tone="soft" bodyId="details" buttonClassName="focus-x" />)
  assert.match(row, /aria-expanded="false" aria-controls="details" class="flex w-full items-center justify-between py-2\.5 text-sm focus-x"/)
  assert.equal(row.match(MUTED), null)
})

test("inputProps and the keystroke filter", () => {
  const html = payField({ inputProps: { placeholder: "0.5", autoComplete: "off", "aria-describedby": "hint", "aria-invalid": true } })
  assert.match(html, /placeholder="0\.5"/)
  assert.doesNotMatch(html, /placeholder="0\.0"/)
  assert.match(html, /aria-describedby="hint"/)
  assert.match(html, /aria-invalid="true"/)

  const seen: string[] = []
  const plain = inputOf({ caption: "c", symbol: "s", value: "", onChange: (next) => seen.push(next) })
  for (const value of ["1.5", "-1", "1e3", "1.2.3", ""]) plain.props.onChange({ target: { value } })
  assert.deepEqual(seen, ["1.5", ""], "default: plain non-negative decimals only")

  const scaled: string[] = []
  const custom = inputOf({ caption: "c", symbol: "s", value: "", onChange: (next) => scaled.push(next), filter: (next) => /^\d*\.?\d{0,2}$/.test(next) })
  for (const value of ["1.25", "1.255", "abc"]) custom.props.onChange({ target: { value } })
  assert.deepEqual(scaled, ["1.25"], "a custom filter replaces the default")
})

test("the leaf imports react and lucide-react only; components.tsx takes the pieces from it", () => {
  const leaf = read("./invest-panel-ui.tsx")
  const imports = [...leaf.matchAll(/^import[^"]*"([^"]+)"/gm)].map((match) => match[1])
  assert.deepEqual([...new Set(imports)].sort(), ["lucide-react", "react"])
  const components = read("./components.tsx")
  assert.match(components, /from "\.\/invest-panel-ui"/)
  assert.doesNotMatch(components, /^function (AmountField|AmountBlock|InfoRow)\b/m, "no second copy in components.tsx")
  const sheet = read("./BottomSheet.tsx")
  const sheetImports = [...sheet.matchAll(/^import[^"]*"([^"]+)"/gm)].map((match) => match[1])
  assert.deepEqual([...new Set(sheetImports)].sort(), ["lucide-react", "react", "react-dom"])
})

test("a closed BottomSheet renders nothing (no dialog, no content)", async () => {
  const { BottomSheet } = await import("./BottomSheet")
  assert.equal(renderToStaticMarkup(<BottomSheet open={false} onClose={() => undefined} label="Trade NVDA"><input inputMode="decimal" /></BottomSheet>), "")
})

test("an info row's help sits behind a closed \"?\" badge; a row without help keeps its markup", () => {
  assert.equal(
    renderToStaticMarkup(<InfoRow label="Price" value="120" />),
    '<div class="flex items-center justify-between border-t border-[var(--color-arco-border)] py-2.5 text-sm"><span class="text-[var(--color-arco-text-soft)]">Price</span><span class="tabular-nums text-[var(--color-arco-ink)]">120</span></div>',
  )
  const html = renderToStaticMarkup(<InfoRow label="Quote" value="1 NVDA = 120 USDC" help="Why this price" />)
  assert.match(html, /<button type="button" title="Why this price" aria-label="About Quote" aria-expanded="false"[^>]*>\?<\/button>/)
  assert.match(html, /1 NVDA = 120 USDC/)
  assert.doesNotMatch(html, /<p/, "the explanation opens on press")
})
