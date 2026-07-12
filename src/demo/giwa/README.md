# GIWA Preprod Frontend Boundary

GIWA-only wallet, registry, catalog, and admin UI code belongs under this
folder. Do not import or mutate the legacy mock product seed in
`src/demo/data/products.ts`; the GIWA catalog must be loaded from the backend
registry added in later phases.

## Numbers: sans + tabular figures (pilot)

GIWA is piloting numbers in the app **sans** stack with `tabular-nums` instead of
`font-mono` (identifiers — addresses, tx hashes, request/round IDs, raw on-chain
integers, tickers — stay mono). The rest of the app (LP) still follows the global
`DESIGN.md` §2.3 mono rule until the change lands app-wide.

