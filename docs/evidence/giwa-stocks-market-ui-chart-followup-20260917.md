# Market chart follow-up — builder evidence

Base `a79b196a37152aefe0c51c196fcdca20a7088af0`; same isolated UI clone/branch. Two independently reproduced P3 display issues only. No amendment of the original candidate, new functionality, server/host/trading/dependency changes.

1. A valid chart with bars[0] and bars[2] has two singleton segments. The old total-point check disabled both dots, leaving zero visible observations despite two rows of raw data. Dots are now enabled for each singleton segment; gaps stay disconnected.
2. A mobile native range input may change without taking focus. Its blur handler therefore did not end touch selection when the user left it. While an observation is selected, scoped document pointer/focus listeners clear it when interaction moves outside the chart. Listeners are removed on cleanup; existing mouse-leave and slider-blur behavior remains.

The committed `chart.browser.test.mjs` runs against the actual `/stocks` route in an owned loopback Vite server, with a fresh Chrome context, explicit synthetic fixture transport, all unrelated external requests blocked, at375/1440. It requires an existing Playwright runtime and browser URL; no package install or silent skip. Independent probes within each case count rendered Recharts dots, touch/keyboard-select a real observation, click the external trading heading, and separately move focus from BODY to the external period button. Each exit must restore the current snapshot label.

Original fixed source:375 has dots0/pointerExit0/focusExit0;1440 dots0/pointerExit1/focusExit1. Modified source: both dots2/pointerExit1/focusExit1,2/2 cases pass. Same final regression script is used on both sources. An early harness tried to focus an already focused button; the final probe resets focus between its independent exit checks. Initial total-bar midpoint tap also did not change a two-step slider; explicit first-step coordinates correct the harness.

Market unit10/10, actual-route DOM12/12, typecheck and production build pass. This small follow-up does not repeat root's full340 frontend/server checks. No new screenshots claimed; actual browser DOM/SVG and interaction checks are recorded. Final log copies and source revision metadata are under `/private/tmp/arco-giwa-market-ui-evidence-20260917/chart-followup/`. Independent final-SHA acceptance is separate from these builder checks.

```sh
GIWA_MARKET_BROWSER_URL=http://127.0.0.1:5724 GIWA_MARKET_PLAYWRIGHT=/Users/whdqkf88/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright node --import tsx --test src/demo/giwa/stocks-market/chart.browser.test.mjs
node --import tsx --test src/demo/giwa/stocks-market/market.test.tsx
GIWA_MARKET_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json node --import tsx --test src/demo/giwa/stocks-market/routes.dom.test.mjs
npm run typecheck
npm run build
```
