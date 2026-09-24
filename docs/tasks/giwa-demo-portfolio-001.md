# GIWA-DEMO-PORTFOLIO-001

Approved by the user's 2026-09-24 instruction to continue development after reviewing the commander plan. Local implementation and verification only; no push, merge or deployment.

- Builder/integrator: root commander. Independent reviewer: portfolio_review (read-only).
- Base: `097421589a38c54181f94813c390a4c22253469f`.
- Branch: `codex/giwa-demo-portfolio-001`.
- Worktree: `/private/tmp/arco-giwa-demo-portfolio-001`.
- Allowed files: `src/demo/giwa/PortfolioPage.tsx`; new `src/demo/giwa/stocks-portfolio/StocksPortfolioSection.tsx`, `StocksPortfolioSection.test.tsx`, `StocksPortfolioSection.dom.test.tsx`; this task record and `docs/evidence/giwa-demo-portfolio-001.md`.
- Scope: connect existing Stocks holdings/pending orders to the top-level Portfolio. Reuse existing host authentication, client, controller and quantity display. Clarify existing Savings/Funds valuation scope.
- Invariants: no automatic signature/transaction; current wallet/chain/session only; discard late responses; errors are not zero balances; reserve is a subset of wallet holdings, total is wallet plus escrow; pending orders are not holdings; preserve string/BigInt quantities; no market-price/mock-price mixing.
- Failure cases: disconnected/wrong-chain wallet, expired/rejected session, unavailable API/catalog, network failure, delayed old-wallet response, negative available balance, remount and page visibility refresh.
- Verification: focused SSR/state and actual DOM integration tests, typecheck, build, frontend, server, security, migration inspection, existing design checks; browser review of the new section where local tooling permits. Record the exact environment and distinguish fixture checks from real PostgreSQL/EVM/public-wallet evidence.
- Commands: `TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/stocks-portfolio/StocksPortfolioSection.test.tsx src/demo/giwa/stocks-portfolio/StocksPortfolioSection.dom.test.tsx`; provide an existing jsdom runtime via `GIWA_HOST_DOM_RUNTIME` for the DOM gate. Baselines: `npm run typecheck`, `npm run build`, `npm run test:frontend`, `npm run test:server`, `npm run test:security`, `npm run prisma:migration:inspect`, `node .claude/hooks/check-design-tokens.mjs --all`, `node .claude/hooks/check-story-exists.mjs --all`.

No shared API/schema/dependency/wallet-provider/Solidity/live-registry changes are authorized by this task. Existing worktree changes are not copied or modified.

## User steering: canonical customer demo

The user subsequently fixed the user-test environment to the existing UI4392. The customer URL is `http://127.0.0.1:4392/src/demo/giwa/investor-shell/verification/index.html#/`. Do not substitute port5173, a new demo, or the developer execution-fixture screen. The customer entry mounts the actual PortfolioPage. After verification, prepare only the PortfolioPage/new component patch for its assigned integrator, preserving every existing UI/market change. Validate what is actually reachable there and do not label simulated/auth-blocked flows as public GIWA success.

### GIWA-DEMO-4392-INTEGRATION-001

The explicit user request to fix the test environment to the existing UI4392 authorizes the commander integration of this verified Portfolio change into that running UI. The commander owns only `src/demo/giwa/PortfolioPage.tsx` and new `src/demo/giwa/stocks-portfolio/StocksPortfolioSection.tsx` for this integration. Before writing, require the target PortfolioPage bytes to equal the approved base and require the new component to be absent (or already identical). Abort on any mismatch. Preserve all existing market/theme/server/preview-entry changes and the running process. No API/provider/schema/dependency change, restart or public deployment. Verify HMR and navigation in the canonical customer4392 browser, document the separate existing authentication limitation. The isolated branch remains the source of the reviewed patch.

Automatic approval review rejected direct commander writes to the other task's worktree under AGENTS.md. No target files were changed. Follow the review's safe alternative: deliver `/private/tmp/giwa-demo-portfolio-001-ui4392.patch` to the existing **UI 수정** task as assigned integrator. That task owns its workspace and must check the two-file patch before applying. Do not bypass the rejection by another root command or a new agent editing the foreign workspace.
