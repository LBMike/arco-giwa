import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GiwaSkeleton, ProductsSkeleton, SavingsSkeleton } from "./GiwaSkeleton"

test("GiwaSkeleton primitive: animate-pulse + token fill + aria-hidden + className passthrough", () => {
  const html = renderToStaticMarkup(<GiwaSkeleton className="h-4 w-10 rounded-full" />)
  assert.match(html, /animate-pulse/)
  assert.match(html, /bg-\[var\(--color-arco-border\)\]/) // fill is a token, not a raw color
  assert.match(html, /aria-hidden/)
  assert.match(html, /h-4 w-10 rounded-full/)
})

test("ProductsSkeleton echoes the Investor layout: static Products h1 + pulse blocks in a status region", () => {
  const html = renderToStaticMarkup(<ProductsSkeleton />)
  assert.match(html, /<h1[^>]*>Products<\/h1>/) // static header kept
  assert.match(html, /role="status"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /Loading products/) // sr-only announcement
  assert.match(html, /animate-pulse/)
  assert.match(html, /h-\[189px\]/) // featured carousel echo
})

test("SavingsSkeleton: status region + tabs, savings card and section pulse blocks", () => {
  const html = renderToStaticMarkup(<SavingsSkeleton />)
  assert.match(html, /role="status"/)
  assert.match(html, /Loading savings/)
  assert.match(html, /h-\[291px\] w-full rounded-\[22px\]/) // savings card echo
  assert.match(html, /animate-pulse/)
  assert.doesNotMatch(html, /No savings accounts yet/) // loading is not the empty state
})
