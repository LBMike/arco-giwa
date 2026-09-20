# Home discovery cards — 2026-09-21

Request: add Top Gainers, Trending and Newly Added between Invest and Stocks, at most three securities per card.
Reference: Figma `2v7vb7Waf62RLoGLEhO4or`, node `12:8928`; implementation context and screenshot retrieved for child `12:8946`.
Baseline: `bd761b8`, editable preview clone.

## Result and data rules

- Three equal cards with 24px corner radius/gap, 40px existing stock logos, symbol/company, price and secondary metric. Desktop uses three columns, smaller screens stack cards.
- Top Gainers: positive percentage change versus previous close, descending. Trending: estimated session dollar turnover (latest price × session shares), descending. The Figma 24H badges are retained; accessible descriptions and volume tooltips state the actual metric basis.
- Only AVAILABLE quotes can rank; unavailable/stale quotes cannot become gainers or trending entries. Missing prices stay empty. A successful API response with unavailable/stale status gives an unavailable-data empty state.
- Newly Added: a manually maintained product-catalog expansion batch from `c6c097f` (September 19), excluding the earlier NVDA pilot. Members of the same batch retain curated order, so the preview shows SOXL, MU, TSLA. This is not IPO chronology. Future listing batches must be recorded explicitly until the API exposes listing history.
- All cards intersect their selections with the active server catalog. No reference-only Figma assets were added to the product universe.
- Cards and the existing Home stock table share the same catalog/quote requests. Each row links to its own Stocks detail.
- Preview values remain the existing synthetic offline fixture values, not live prices.

## Verification

- Typecheck and production build passed.
- Targeted Home/highlight tests: 11 passed.
- Full frontend: 825 total, 806 passed, 19 existing gated skips, zero failures.
- Full server: 405 total, 333 passed, 72 existing gated skips, zero failures.
- Security checks passed.
- Design tokens: only the seven documented baseline violations in unrelated files. No new violations. Story structure: no hard failures.
- Browser: Home placement and 3/3/3 rows verified; INTC card opened INTC detail. Desktop 1587px, tablet 1024px, mobile 390px checked. Mobile and tablet have no horizontal page overflow; ticker text fits at 1024px. Viewport override reset after checking.
- Read-only independent review identified the non-AVAILABLE-response empty state; corrected before final verification.

No push, deployment, contract, transaction, registry or backend changes.
