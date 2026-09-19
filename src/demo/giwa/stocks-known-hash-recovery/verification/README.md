# Known-hash recovery card — mock gallery

**Mock data — not the app.** The page renders the real `KnownHashRecoveryCard` with fixed example entries, one per store state and
last result: KEPT (before any action, running, after a failed record request, after the session ended), RECORDED (receipt not
verified, after a failed receipt check), VERIFIED CONFIRMED / REVERTED and BLOCKED CONFLICT / NO_CLAIM. Switch BUY/SELL and
APPROVAL/TRANSFER at the top. The card's button only writes a line on the page: no server, session, store, wallet or request is
involved.

In the product a kept hash appears only after a Stocks session ended while a wallet answer was outstanding, in the same tab with the
same wallet. That path needs a real server session expiry, so neither the offline `/stocks` fixture page nor this gallery reaches it
from the page; the terminating `scripts/stocks-local` known-hash-ui case covers it with a real local stack.

## Open it

Serve the repo root with the existing offline verification server (it reads no `.env*`) and open the gallery path:

```sh
TMPDIR=/private/tmp node --import tsx src/demo/giwa/stocks-execution-host/verification/serve.ts --port 4327
```

`http://127.0.0.1:4327/src/demo/giwa/stocks-known-hash-recovery/verification/index.html` — stop the server with Ctrl-C. Any free
port from 1024 to 65535 works except 5173 and 8788.

Nothing in `index.html`, `src/main.tsx`, the router or `vite.config.ts` references this directory, and product code never imports it.
