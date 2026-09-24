# GIWA-DEMO-PORTFOLIO-001 evidence — 2026-09-24

Base `097421589a38c54181f94813c390a4c22253469f`, isolated branch `codex/giwa-demo-portfolio-001`, worktree `/private/tmp/arco-giwa-demo-portfolio-001`.

## Implemented

- The actual top-level Portfolio mounts a Stocks holdings section, including a visible sign-in/connection state when no wallet is connected.
- Reuses the existing Stocks host session, validated HTTP client, investor controller and PortfolioView. No new balance model, auth provider, schema, dependency or Solidity change.
- Displays wallet, reserved, available, escrow and total units plus pending orders. Existing string/BigInt precision and mismatch checks remain authoritative.
- Refetches on mount/re-authentication, visible-page polling, page return and manual refresh. Context changes hide the previous session before paint; delayed results cannot replace the current wallet.
- Local catalog retry; unavailable/error states do not claim a zero balance. Existing valuation and empty-state labels explicitly identify Savings/Funds.

## Verification

| Check | Result |
|---|---|
| Focused SSR + actual jsdom integration | 9 passed, 0 failed, 0 skipped |
| Typecheck and product build | Passed; existing bundle-size warnings |
| Full frontend with existing DOM gate enabled | 1,033 passed, 0 failed, 8 skipped; existing SSR warnings |
| Fresh server build and full server suite | 517 passed, 0 failed, 92 DB-only skipped |
| Security checks | Passed |
| Migration inspection | Existing failure: 4 SQL alias findings in untouched migrations |
| Design tokens | Existing 7 findings, no increase |
| Story structure | No hard findings; existing soft notices |
| Independent code review | No new blocking functional issue found; canonical preview auth limitation explicitly identified |

Commands are in the task contract. DOM gate used `GIWA_HOST_DOM_RUNTIME=/private/tmp/giwa-portfolio-dom/package.json`, an isolated jsdom26.1.0 installation; repository dependency manifests were unchanged.

Focused cases: verified balance and page-return update; remount; wallet/reserved/escrow semantics; pending sell; old-wallet delayed response; logout/wrong network; session401/re-authentication and stale401; network failure/retry; invalid/unregistered catalog; signed-out private-read suppression; large 9-decimal and negative quantities. These use the existing explicit HTTP fixture and are UI/controller evidence, not real PostgreSQL/EVM/public-wallet execution.

A clean worktree initially lacked generated Prisma client and contract ABI artifacts. Generated the client and locally compiled 46 Solidity files (Cancun, no keystore access or deployment), then the server suite passed. The 517 result is the actual clean-worktree result, rather than repeating the prior workspace's reported 549 count. No assertion is made about the origin of that count difference.

Migration findings are untouched base files:

- `20260919000000_stocks_wallet_receipts/migration.sql`: aliases `p`, `s`.
- `20260920000000_stocks_trading_control/migration.sql`: aliases `change`, `current_state`.

No migration/schema/inspection-script changes were made by this task. Their existing failure is not presented as a green baseline.

Logs: `/private/tmp/giwa-portfolio-focused.log`, `giwa-portfolio-typecheck-build.log`, `giwa-portfolio-frontend.log`, `giwa-portfolio-server.log`, `giwa-portfolio-checks.log`, `giwa-portfolio-design.log`, `giwa-portfolio-stories.log`.

## Canonical UI4392 integration

The user explicitly fixed the customer test environment to:

`http://127.0.0.1:4392/src/demo/giwa/investor-shell/verification/index.html#/portfolio`

The customer page was opened and inspected in the browser. Its root `/` and the developer execution-fixture URL are not the customer demo entry and are not substitutes.

The reviewed two-file patch is `/private/tmp/giwa-demo-portfolio-001-ui4392.patch`. Direct root modification of the UI task's worktree was initially rejected by automatic approval review under AGENTS.md. After the explicit two-file exception request, the user again instructed continuation. Automatic review accepted the guarded integration on that new authorization. The PortfolioPage target still matched the base, and the new component was absent. Only those two files were written. They now match reviewed implementation commit `d92b968c568b790bb5b05e7096cf2b16efe3cc60` exactly. No existing UI/market/server changes were replaced and the running4392 process was preserved.

Post-integration evidence:

- `npm run typecheck` in the running4392 worktree passed (`/private/tmp/giwa-portfolio-4392-typecheck.log`).
- Browser shows the new `Stocks portfolio` region, Stocks sign-in state, connection button and `Trade Stocks` link on the canonical customer Portfolio route, including when no wallet is connected.
- Clicking `Trade Stocks` opens the existing customer Stocks table with40 symbols; browser Back returns to the new Portfolio section.
- The Portfolio tab is retained as a user-facing deliverable.
- No personally signed-in balance or public transaction was verified in this browser check. The authentication/runtime limitation below remains separate from the completed two-file UI integration.

Existing customer-preview limitation: normal GiwaStocksHost authentication uses the configured ARCO_API_BASE (default localhost8080), while preview Stocks reads use4392 and the preview fetch guard blocks off-origin authentication. Its same-origin backend is a simulated DB/chain harness with test-only authentication. Do not silently bypass that guard or represent it as personal MetaMask public-GIWA success. A separate user question distinguishes immediately usable demo-account simulation from the eventual personal-wallet/public-network route.

Public deployment, real-wallet transactions, push and merge were not performed.
