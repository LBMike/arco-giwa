# GIWA Stocks trusted receipt reconciliation — integration evidence

Status: ACCEPTED — root integration and independent combined review PASS. Frozen code `dc7277d154f46c4e57fcf663acb6227f3f282b46`. Base `f7a85402c866c672fff32c4a3ad013e8edc90d6b`; shared contract a94a2a8; root composition 1f146bc. Client source4447dbeb6d8dfdc2af9d5b29d0da8557cfb1dc6e imported1f17551; backend source2b6d8420b70942bf2c06c413afab75c826c71983 importeddc7277d. Isolated checkout `/private/tmp/arco-giwa-receipt-integration-20260917`.

## Intended behavior

The authenticated server verifies previously recorded transaction hashes against its configured ChainPort. Terminal evidence and status are committed together. Browser outcomes cannot assert confirmation or revert, erase a hash, or downgrade evidence. Successful approval permits a separate transfer claim subject to existing owner, deployment, enrollment, pause, order and deadline checks. Confirmed wallet payment is distinct from order settlement.

The browser adapter preserves captured session and binding rules. Controller recovery explicitly reconciles approval before checking fresh wallet/order/policy/allowance and showing transfer readiness. No automatic transfer; existing transfer attempts always block another signature.

## Validation boundaries

- App/browser/PostgreSQL integration: real buildApp, JWT owner authentication, browser adapter and controller, fresh migrated PostgreSQL. ChainPort and wallet are explicitly deterministic test fixtures.
- Local EVM stack: real ephemeral local contracts, loopback-only RPC, SIWE, Fastify, PostgreSQL, journal, receipt validation and existing settlement observer/worker. Uses node-owned unlocked test accounts and mock broker. This is not public GIWA execution or a browser wallet.
- General server unit suite has explicitly skipped database tests; the fresh-PostgreSQL run is recorded separately.
- No live deployment, deployed registry edits, existing database use, production key access, or UI execution activation.

## Remaining product integration

Reviewed deployment and current execution policy adapters, actual wallet binding, UI button activation and end-user transaction acceptance remain separate. Investor create-order response recovery is also separate from wallet transaction journal recovery. Market provider keys and public deployment are not part of this milestone.

## Root verification at frozen code dc7277d

| Check | Result |
| --- | --- |
| Full server suite | 169 pass, 44 database-dependent skips, 0 fail |
| Fresh PostgreSQL | 51/51: legacy32 + journal8 + receipt4 + actual API/browser7 |
| PostgreSQL and Node restart | CONFIRMED status and immutable proof survive stop/start and a new Node process |
| Full frontend invocation | 392 pass, 1 host-DOM environment skip, 0 fail; compiled Solidity ABI test ran |
| Previously skipped host DOM suite | Enabled existing jsdom runtime and ran file11/11 separately (10 previously skipped checks plus 1 already-covered structural test); total distinct frontend coverage402 |
| Actual local EVM stack | 15 scenarios PASS, including real BUY/SELL approval and payment receipt journal plus existing mint/burn/payout and reconciliation |
| Production build and TypeScript | PASS; existing large-chunk warning |
| Security and story structure | PASS; existing soft story warnings |
| Design tokens | 7 inherited findings, unchanged; this check remains nonzero |
| Whitespace diff | PASS |

Local EVM final independent cutoff: wallet3,000,000,000 stock units; escrow0; supply3,000,000,000; vault360,000,000 cash units; MATCHED_AT_CUTOFF. These are 9-decimal stock and 6-decimal mock cash quantities. Mock broker remains explicit.

The root PostgreSQL harness `/private/tmp/stocks-submissions-pg-TpcIBv/harness-evidence.json` records started=true, stopped=true, one restart, PIDs26069→26237. Local stack runner exited0 after its owned EVM process-group and PostgreSQL cleanup; its successful temporary directory is removed by the runner. No existing DB or unrelated IPC was changed in this milestone. Reviewer owns any subsequent separate harness lifecycle.

The first implementation lacked protection against direct insertion of a terminal journal row; root review requested an initial-state trigger and proof-insert binding validation before freeze. The final backend candidate includes those constraints and fresh-PG regression checks. No unverified initial candidate was accepted.

Root logs: `/private/tmp/giwa-receipts-combined-{server,postgres,frontend,host-dom,local-evm,build,security,tokens,stories}.log`. Copies accompany the external evidence index at `/private/tmp/giwa-receipts-combined-evidence-20260917/`.

Reproduction after linking the existing matching dependencies and local contract artifacts:

```sh
npm run test:server
node scripts/stocks-submissions/test-postgres.mjs server/dist/stocks/stocks.postgres.test.js scripts/stocks-submissions-integration/client-roundtrip.test.mjs
GIWA_STOCKS_ARTIFACTS=/private/tmp/arco-giwa-receipt-integration-20260917/packages/contracts/artifacts/stocks npm run test:frontend
GIWA_HOST_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json node --import tsx --test src/demo/giwa/stocks-host/provider.dom.test.tsx
STOCKS_LOCAL_STACK_ONLY=1 STOCKS_PG_BIN=/opt/homebrew/Cellar/postgresql@18/18.6/bin TMPDIR=/private/tmp node scripts/stocks-local/run.mjs
npm run build
npm run test:security
```

Fresh-PG and local-stack commands were explicitly approved outside the sandbox because sandboxed initdb on this host can leak its tiny SysV control segment. Only one owned PostgreSQL harness is run at a time. Existing database processes are never stopped.

## Independent review

Frozen combined code dc7277d was inspected and executed from a separate review clone. No unresolved actionable findings. Independent checks: client62 + reviewer probes9; server focused34 + planner parity1 + reviewer offline3; fresh PostgreSQL21 (journal8 + receipt4 + actual API/browser7 + reviewer concurrency2) =130 passed,0 failed,0 skipped. PostgreSQL and Node restart terminal-proof recovery passed separately.

Reviewer probes included both BUY and SELL policy denial, changed order, spent allowance after confirmation, original-gate late outcomes, database lock release during pending RPC, monotonic late outcomes, and a new pause after approval confirmation. The reviewer did not rerun the local EVM; the15-scenario local-chain evidence above belongs to root.

Reviewer fresh-PG `/private/tmp/stocks-submissions-pg-IHxeYI/harness-evidence.json`: started=true, stopped=true, restarts1, PIDs27193→27289. Independent report: `/private/tmp/arco-giwa-receipts-review-evidence-20260917/README.md`. All temporary services owned by this milestone are stopped.

Remaining product integration above is intentionally still outstanding. This acceptance covers receipt reconciliation and its adapters, not real-wallet UI activation or public testnet readiness.
