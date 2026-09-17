# Receipt backend candidate evidence

Base `a94a2a8bff09a3607e07b6c5acde6c35e9d8bbea`; branch `codex/giwa-receipts-server-20260917`, isolated source `/private/tmp/arco-giwa-receipts-server-20260917`. Candidate is the commit containing this evidence. Root owns runtime/index integration; neither is changed here.

| Direct command | Exit | Result |
| --- | --- | --- |
| `npm run build:server` | 0 | Server compiler |
| `node --test server/dist/stocks-submissions/receipts.test.js` | 0 | 28 hostile/positive deterministic RPC tests |
| `npm run test:server` | 0 | 168 pass, 44 gated DB skip; includes new 28 receipt unit cases |
| `npm run test:security` | 0 | Existing checks |
| `npm run typecheck` | 0 | Types |
| `npm run build` | 0 | Frontend production build, existing large chunk warning |
| `node node_modules/prisma/build/index.js validate --config /private/tmp/receipts-prisma.config.mjs` | 0 | Explicit dummy URL config, no dotenv/DB connection |
| `node --test scripts/stocks-submissions/planner-parity.test.mjs` | 0 | Existing planner parity 1/1 |
| `node scripts/stocks-submissions/test-postgres.mjs` (initial escalation) | 0 | Fresh PostgreSQL 12/12: existing journal 8 + new receipt 4; real DB and Node restart proof persistence |
| `git diff --check` | 0 | Whitespace |

The new actual PG cases cover BUY and SELL approval-to-transfer, four concurrent reconciliations, one proof/audit, late observations preserving terminal state, immutable proof/update/delete/truncate, initial terminal INSERT denial, mismatched proof insertion denial, proof-less terminal UPDATE denial, reverted approval blocking, owner checks, rollback of proof+status when audit fails, and no late proof after timed-out transport. The restart probe now verifies CONFIRMED and its proof after actual PostgreSQL restart and a new process.

The final owned fresh PG directory is `/private/tmp/stocks-submissions-pg-3gdOB3`: PID 23383, restarted PID 23471; started=true/stopped=true/restarts=1, no surviving postmaster.pid. Unix socket only, TCP disabled. Parent notified slot returned before integration/review runs. No unrelated IPC cleanup, existing database or socket access. An initial full PG run had 11/12 pass: the existing no-truncate test expected its own trigger error, but the new proof FK rejected earlier. The test now includes the proof table so it reaches the unchanged no-truncate protection; final 12/12 passed. An initial compile used Object.hasOwn unsupported by the existing target; corrected to hasOwnProperty, then all compilers passed.

Lockfile compared equal before symlinking `/private/tmp/arco-giwa-stocks-command-20260916/node_modules`. Ignored ABI artifacts reused from the previous submission server checkout with unchanged tracked contract source. No dependency/package/lockfile changes. No frontend test sweep was repeated; frontend files are untouched and browser/controller changes belong to the parallel agent. Root performs combined API/browser/legacy PG checks and independent reviewer accepts the frozen candidate separately.

This proves deterministic verifier behavior and actual isolated PostgreSQL durability, not live EVM/RPC execution. No real RPC, wallet, secrets, key, signature, broadcast, listener, deployment, push or merge. The existing ChainPort cannot cancel an already dispatched HTTP request; bounded verification discards late results and schedules no further reads/writes. Runtime wiring, configured transport suitability, and public activation are not claimed by this backend candidate.
