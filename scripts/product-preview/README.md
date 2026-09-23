# Integrated local product UI

Run the actual product route tree with the customer layout from the 4392 UI:

```sh
npm run product:dev -- --dynamic-environment YOUR_PUBLIC_DYNAMIC_ENVIRONMENT_UUID
```

The default URL is `http://127.0.0.1:5173`. `--port` selects another port.
`--legacy-api` defaults to the existing public `https://arco-giwa-api.onrender.com` backend.
Savings and Funds use its original registry, catalog, prices, history and featured product responses.
No snapshot or synthetic product data is substituted.
`--market-api` defaults to the separately running `http://127.0.0.1:4392` display API.
Start it with `node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4392 --live-market`.
Keep it running for Stocks prices, company
information and charts. Without that flag, the 4392 verification host serves fixture data.
When the market API is unavailable, the preview reports unavailable market data instead of
substituting synthetic prices. Each new read reaches 4392, so restarting the preview is not
needed after the market service recovers. An already open catalog view may need a page reload
to make its next read. Once the catalog loads, quote rows refresh while the tab is visible.

The launcher reads no dotenv or credential files. Dynamic receives only the explicit public UUID.
`VITE_CUSTOMER_PRESENTATION=true` selects the compact customer layout in the actual app entry;
normal app builds retain their existing layout unless that public setting is explicitly enabled.
This flag changes presentation only, not authorization or transaction checks.

The loopback gateway permits only enumerated public GET routes and never forwards cookies,
Authorization, admin operations, SIWE, order submissions or the 4392 simulated execution API.
Only the current preview origin is accepted. Redirects are refused, responses are bounded to
4 MB and 15 seconds, and upstream errors return a generic unavailable response.
Personal wallet connection uses the real Dynamic provider. Stocks personal-wallet trading is
not connected by this launcher. Savings/Funds contract transactions have not been verified by
this preview's read checks; their existing on-chain availability gates remain in place.

Validation: `npm run test:preview`, plus normal app checks.
