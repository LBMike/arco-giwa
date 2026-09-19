# Stocks integration CI

`.github/workflows/stocks-integration.yml` defines four independent jobs on
Ubuntu 24.04 with the latest Node 22 patch and PostgreSQL 16 binaries. It uses
ordinary `pull_request`, main pushes and manual dispatch, a read-only repository
token, no repository secrets, no deployment environment and no live RPC.
The existing general CI job remains in place.

| Scenario | Checks |
| --- | --- |
| `postgres` | Harness boundary/acceptance tests, all frontend tests with jsdom and compiled ABI enabled, eight server PG suites plus the browser-adapter suite, then actual PostgreSQL and Node restart persistence |
| `operator-diagnostics` | Ordinary investor Chrome/Chromium trade flow, followed by the 24 operator diagnostic fixtures and read-only assertions |
| `known-hash-ui` | Product recovery buttons across BUY/SELL and both stages, actual JWT/quote expiration, no wallet resend |
| `browser-lifecycle` | Ready SIGINT, held-response SIGTERM and intentional failure, with independent process/port shutdown checks |

The jobs use fresh Unix-socket databases and loopback-only unforked EVM nodes.
Contract compilation uses the existing locked contract dependencies. The browser
job installs the Chromium build belonging to the locked Playwright version; it
does not use an extension or a physical wallet. The broker remains the fixed
local mock. Real securities, public-network trading and live signer rollout are
outside these checks.

## Local execution

Use Node >=22.15 (DOM tests use module hooks), installed PostgreSQL binaries and
the repository's normal root/contract dependencies. This directory has its own
lock file, so jsdom/Playwright do not change product dependencies.

```sh
npm ci
npm ci --prefix scripts/stocks-ci --ignore-scripts
npm run prisma:generate
npm run build:server
corepack yarn --cwd packages/contracts install --immutable
DOTENV_CONFIG_PATH=/dev/null corepack yarn --cwd packages/contracts compile
node scripts/stocks-ci/node_modules/playwright/cli.js install chromium

STOCKS_PG_BIN=/absolute/postgresql/bin \
node scripts/stocks-ci/run.mjs postgres /tmp/stocks-ci-postgres-new

STOCKS_PG_BIN=/absolute/postgresql/bin \
node scripts/stocks-ci/run.mjs operator-diagnostics /tmp/stocks-ci-diagnostics-new
```

Replace the scenario with `known-hash-ui` or `browser-lifecycle`, each with a new
empty absolute evidence directory. On Linux install browser system libraries
using Playwright's `install --with-deps chromium`, as the workflow does. An
explicit absolute `STOCKS_LOCAL_CHROME` may select an already installed local
Chrome executable; the result records the browser version and executable used.
Do not run expensive DOM and browser scenarios concurrently on the same machine:
the original execution-evidence and quote deadlines are deliberately unchanged.

The entry point clears inherited Stocks scenario/database flags, enables the
selected fixed local harness, and uses `/tmp` so lifecycle cleanup has a short,
supported Unix socket path. No `.env` file is loaded by this entry point.

## Acceptance and evidence

Require the entry point's exit 0 **and** `summary.json` with `result: PASS`.
The runner rejects:

- missing, failed, skipped or TODO TAP tests;
- a browser PASS report without both matching ordered cleanup records;
- residual owned PIDs, database socket/PID files or browser/API/RPC ports;
- missing lifecycle probes or known diagnostic findings;
- interruption, nonzero child exits or a test exceeding its 12-minute budget.

The `postgres` job enables DOM and ABI gates before launching the tests. Its
database tests run sequentially because the preflight suite intentionally changes
its own migration-history fixture. The PG harness exports only ownership and
shutdown metadata, including whether tests and restart verification completed.
It keeps raw database state in its own temporary directory, outside CI evidence.

Logs, result/summary JSON and screenshots are stored in the selected evidence
directory. GitHub artifact upload is **not configured**: separate authorization
for external retention is pending. Consequently screenshots and result files on
a hosted runner do not survive runner disposal; ordinary Actions console output
remains the available remote failure record. Local runs retain their explicit
evidence directory. Never upload raw PG clusters, browser profiles or `/tmp`.

SIGINT/SIGTERM is forwarded through CI and lifecycle wrappers to their owned
harnesses. The PG harness stops its active child and database before returning a
cancellation status. No wrapper discovers or terminates unrelated services.
SIGKILL, host loss or a hung teardown cannot guarantee cleanup; the workflow's
25-minute job limit and disposable hosted VM are the last boundary. A partial
report never counts as success.

Implementation references: [Playwright CI](https://playwright.dev/docs/ci-intro),
[PostgreSQL 16 initdb options](https://www.postgresql.org/docs/16/app-initdb.html).
Actual validation results and platform limits are recorded separately under
`docs/evidence/`; a workflow definition is not proof of a hosted Actions run.
