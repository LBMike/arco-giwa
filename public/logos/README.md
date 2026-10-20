# Product / brand logos

Drop logo files here. Filenames are referenced by src/demo/data/products.ts.
Transparent-background PNG recommended (square, ideally @2x e.g. 64×64+).
Missing files fall back to an initial badge automatically (BrandMark.tsx).

## Asset Manager / Issuer
- arco.png      — Arco
- aksia.png     — Aksia        (aCAPIX, aHedge asset manager)
- ubs.png       — UBS          (uMINT asset manager + issuer)
- franklin.png  — Franklin Templeton (iBENJI asset manager)
- franklin-templeton.png — Franklin Templeton mark, 128×128 (Savings Backing tiles)
- digift.png    — DigiFT       (uMINT, iBENJI issuer)

## Savings "Powered by" (powered-by/)
The partners' own logo files, shown as overlapping round badges on the Savings card.
- powered-by/fidelity.png — Fidelity, 400×400
- powered-by/franklin.png — Franklin Templeton (portrait mark), 379×318
- powered-by/morpho.png   — Morpho, 200×200
- UBS uses umint.svg (the UBS keys mark) until its own file is added here

## Savings coins (the deposit / withdraw token picker; src/demo/giwa/savings-assets.ts)
- usdc.svg    — USDC
- usdt.png    — USDT, 64×64
- rlusd.png   — RLUSD, 64×64
- arcousd.png — ArcoUSD, 200×200
- Chain badges: Ethereum and XRPL are inline marks (BrandMark.tsx NetworkIcon), GIWA is giwa.png

## Product token icons
- sarcousd.png — sArcoUSD, 200×200 (the arcoUSD Savings vault's share as customers see it; catalog.ts PRESENTED_TOKENS)
- token-abtc.png
- token-aeth.png
- token-acapix.png
- token-ahedge.png
- token-umint.png
- token-ibenji.png
