# Stocks logos

Company and ETF-issuer marks for the Stocks table. There are 40 instruments and 34 PNG files.

The table joins these files to rows by ticker through `src/demo/giwa/stocks-market/curated.ts`. They are for display only
and have no effect on market data, ranking or order capability.

## Files

- 34 PNG files and `manifest.json`, copied byte for byte from the earlier RWA demo
  (`src/dd-demo-ui/public/logos/stocks/` on branch `codex/rwa-ui-claude-20260916`, last changed in commit `a5cd7a4`).
- Every file's sha256 and byte size match `manifest.json`. `stocks-market/curated.test.tsx` checks the hashes, and also
  checks that the PNG files here are exactly the ones `curated.ts` maps.
- An ETF row uses its fund manager's logo, never the logo of a company it holds. Several rows share one manager file:

  | File | Tickers |
  |---|---|
  | `direxion.png` | SOXL, SOXS, KORU |
  | `ishares.png` | SGOV, SOXX |
  | `proshares.png` | TQQQ, QLD |
  | `invesco.png` | QQQM, QQQ |
  | `roundhill.png` | DRAM, RAM |

  SCHD (`schwab.png`), VOO (`vanguard.png`) and JEPQ (`jpmorgan.png`) each use a manager file that no other row shares.

## Provenance

`manifest.json` is kept unchanged. For each file it records `sourceUrl`, `sourcePage`, `sourceKind`, `retrievedDate`
(2026-09-16 for every file), width, height, bytes and `sha256`.

The manifest's `path` values and its `policy` text describe where the files lived in the earlier demo. They do not describe
this repository. Here the files live in `public/logos/stocks/`, and the display map is `curated.ts`.

## Caveats

- **Licence and trademark are not recorded.** The manifest has no licence or trademark field for any file. Review these
  marks before any public release.
- `alphabet.png` is Google's "G" icon, not an Alphabet wordmark.
- `jpmorgan.png`, `schwab.png` and `ishares.png` are typographic marks (the "JPM" letters, "SCH/WAB" and the
  "iShares by BlackRock" lockup).
- The letters in `iren.png` are very small at 32px.
- Most files are 256px square. `strategy.png` is 200px, `jpmorgan.png` is 192px, and `invesco.png`, `amazon.png` and
  `moderna.png` are 180px. They downscale unevenly at small sizes.

## Serving

The app serves these files from its own origin at `/logos/stocks/<file>`. No page loads a stock logo from a remote URL.

If a file fails to load, `StockLogo` shows the ticker's first letter instead. It never substitutes another company's
mark.
