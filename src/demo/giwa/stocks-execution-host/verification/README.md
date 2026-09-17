# `/stocks` wallet execution — offline browser verification fixture

**Verification fixture — not the app.** Offline loopback server, fake wallet, no real assets.

This page mounts the real `/stocks` page (host, investor, execution host and wallet panel code) in a browser, backed by the real in-process Stocks server harness in Node. Use it to check page states, narrow widths and keyboard behaviour. It is not a fallback for any product path.

## Start and stop

From the clone root (Node 24, `node_modules` present, no install):

```sh
TMPDIR=/private/tmp node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4327
```

- It prints one line with the page URL, e.g. `http://127.0.0.1:4327/src/demo/giwa/stocks-execution-host/verification/index.html`.
- Stop it with Ctrl-C (SIGINT) or SIGTERM. Both close Vite and the harness, and the process exits.
- Restarting gives a fresh server: empty tables, new chain, start cash, and no orders or sessions.

### Port rule

- Never use **5173** (the app's Vite dev port and CORS origin) or **8788**. `serve.ts` refuses both.
- Pick a free port from 1024 to 65535. The default is 4327.
- The server binds `127.0.0.1` only, with `strictPort`, so a busy port fails instead of drifting.
- The SIWE domain and the JWT domain are the page origin `http://127.0.0.1:<port>`, passed to the harness as `frontendOrigin`. Open the page at exactly that origin (not `localhost`), or sign-in is refused.

## What is real and what is fixture

| Layer | Real or fixture |
| --- | --- |
| `StocksHostProvider`, `StocksPageEnvironment`, `stocksRoutes`, `StocksPages`, investor feature, `StocksExecutionProvider`, registry, wallet source capture and ports, wallet controller, `StocksWalletExecutionPanel` | **Real** product modules, mounted in React `StrictMode` over a memory router at `/stocks` |
| `/api/v1/stocks/*` (catalog, quotes, orders, sell, execution, wallet submissions) | **Real** server plugins and services from `testing/in-process-stocks.ts`, over the in-memory SQL fake, called through `app.inject` |
| Deployment evidence and submission receipt verification | **Real** server code, reading the **fake chain** (`testing/fake-chain.ts`) |
| `/api/v1/auth/nonce`, `/api/v1/auth/verify` | **Fixture**: the harness auth routes. They do NOT verify signatures |
| Signature | **Fixture**: `signMessage` returns a fixed 65-byte value. No key |
| Wallet | **Fixture**: an in-page EIP-1193 object whose `request` POSTs to `/__fixture/wallet`, answered by one fake wallet per account (`testing/fake-wallet.ts`). `window.ethereum` is never read or assigned |
| Accounts | A = `0x1111…1111`, B = `0x2222…2222`. Each starts with 1,000,000 ARCO_TEST_USDC on the fake chain |
| Order state progress | **Fixture**: an observer emulation through the real repository transition (`setOrderState`) |
| Theme | Real `src/index.css` and `src/demo/theme.css` |

Vite is started through its JS API with the repo `vite.config.ts`. The port, host, strictPort, app type, env directory and cache directory are overridden inline; the file is never edited.

- `envDir` is this directory, which has no env files, so no `.env*` is read and nothing reaches the page through Vite env variables.
- The dependency cache goes to `$TMPDIR/arco-giwa-stocks-verification-vite-cache`, not to the shared `node_modules`.
- The browser loads only loopback URLs. There is no public RPC, wallet extension or network.

## Fixture routes (served only by `serve.ts`)

| Route | Purpose |
| --- | --- |
| `/api/v1/*` | Forwarded to `harness.fetch`: method, path+query, `authorization`/`accept`/`content-type`, body |
| `POST /__fixture/wallet` `{account: "A"\|"B"\|null, method, params}` | `{result}` or `{error: {code}}` (never a stack). `null` is a disconnected wallet: `eth_accounts` is `[]`, `eth_chainId` answers, everything else is 4100 |
| `POST /__fixture/control` `{action, …}` | `setNetwork(variant)`, `holdNextSend(account)`, `releaseHeld(account)`, `rejectNextSend(account, code 4001\|-32603)`, `revertNextTransaction`, `setFinalize(value)`, `finalizeNow`, `setOrderState(side, id, state)`, `seedStock(account, units)`, `setPaused(value)`, `setEvidenceAvailable(value)`. Errors are `{error: {code}}` with status 400 |
| `GET /__fixture/state` | Wallet method counts per account, server route counts (ids folded to `:side`/`:id`), held flags, network, switches, orders (newest first), chain block counters |

## The fixture bar

- **Account:** A, B or Disconnect.
  - Each switch emits `accountsChanged` locally and increments `walletEpoch` (`fixture:<n>`).
- **Dynamic (unsupported) source:** passes `{mode: "dynamic", client: {}}` as the host and active source. It also increments the epoch.
- **Wallet network:** `reviewed`, `other-checkpoint`, `other-chain` or `missing-checkpoint`.
  - Every switch emits `chainChanged` and increments the epoch, as the product's injected provider does.
  - The host chain follows the wallet's chain id (`other-chain` reports chain 1).
  - **Host view pins chain 91342** keeps the host at 91342, so only the wallet port's own chain and checkpoint attestation can refuse.
- **Next `eth_sendTransaction`** (current account):
  - Hold, then Release after the request has arrived.
  - Reject with 4001 or -32603.
- **Fake chain:** Revert next tx, Finalize immediately (on/off), Finalize now.
- **Server:** Paused, Evidence unavailable, Seed 10 NVDA for A (for SELL).
- **Order state:** pick an order (the newest is preselected) and a state, then Apply.
- **Counters:**
  - wallet: `eth_sendTransaction`, `wallet_sendTransaction`, `eth_sendRawTransaction`
  - server: claims, outcomes, reconcile
  - chain transactions and the held-send flag
  - They refresh every second.

## Not part of the app build

- Nothing in `index.html`, `src/main.tsx`, the router (`src/demo/giwa/routes.ts`, `stocks-market/routes.tsx`) or `vite.config.ts` references this directory.
- `stocks-execution-host/index.ts` does not export it.
- `serve.ts` imports `testing/` modules and the server sources, and is for Node only.
- `npm run build` uses the root `index.html`, so this page is never bundled.

## Limitations

- The order list reads a table snapshot. A transaction open at that instant may be shown.
- Seeding stock while a request transaction is open can be lost if that transaction rolls back. Seed while idle.
- A held send stays pending (and so does its HTTP request) until released or the server stops.
- The fixture auth routes accept any 65-byte signature. This page proves nothing about SIWE signature verification.
