# Execution service/API evidence

Base e7372c200aec52da46f5e2bdbb6fb5c5a805a3ed, branch codex/giwa-execution-service-20260917, source `/private/tmp/arco-giwa-execution-service-20260917`. Candidate is the commit containing this report. New service/plugin/tests only under stocks-execution plus dedicated docs. Root-owned contracts/deployment/runtime/app/index and all frontend/journal/ledger/schema/harness files unchanged.

| Direct command | Exit | Result |
| --- | --- | --- |
| `npm run build:server` | 0 | Compiler |
| `node --test server/dist/stocks-execution/service.test.js server/dist/stocks-execution/plugin.test.js` | 0 | 14/14 final fake-clock/auth/API cases |
| `npm run test:server` | 0 | 183 pass, 49 DB skip (44 existing + 5 new) |
| `npm run test:security` | 0 | Existing security checks |
| `npm run typecheck` | 0 | Types |
| `node scripts/stocks-submissions/test-postgres.mjs server/dist/stocks-execution/service.postgres.test.js` | 0 | Real fresh PG 17/17: 5 execution + 12 journal/receipt, plus actual DB/Node restart proof |
| `git diff --check` | 0 | Whitespace |

Unit cases exercise request-start anchoring, proof lease and DB lifetime caps, wrong owner before evidence calls, enrollment denial, expired/future/extended/wrong-digest proof, pause after awaits, independent monotonic and wall expiry, slight clock disagreement shortening the lease, query/body/auth enforcement, public no-store envelope and exception redaction. Final public-manifest whitelist/digest assertion and clock cap were checked by final compiler and all 14 unit cases after the real PG run; these do not change SQL or DB logic. Root's combined-candidate PG run will independently re-execute this exact final source. Full server/security/type results preceded only the last public-output digest assertion, which final compiler/unit covered.

Actual PG cases verify BUY/SELL read-only setting and SQL stream with unchanged audit/claim counts, pending approval recovery eligibility, actor/wallet denial before proof, historical missing enrollment, missing/other physical binding, initial and post-proof table-lock waits crossing quote expiry, post-proof pause and a bounded long table lock failure. No row-locking SELECT is used. The PG execution initially followed a compiler diagnostic for two missing test-only parameter annotations; TypeScript emitted the current JavaScript. Explicit annotations fixed the diagnostics and before/after compiled test SHA256 files were byte-identical. Final compiler succeeded. This was not a runtime fixture failure.

Owned PG `/private/tmp/stocks-submissions-pg-ZfuVHK`, PIDs 31416 then 31515 after restart: started=true/stopped=true/restarts=1, no surviving postmaster.pid, TCP=false. Initial launch used approved escalation; no sandbox initdb attempt, IPC cleanup, existing socket/DB access or other service used. Slot returned to root before integration/reviewer execution.

Dependencies reused via equal-lock symlink to `/private/tmp/arco-giwa-stocks-command-20260916/node_modules`; ignored ABI artifacts copied from the previous receipt server checkout with unchanged tracked contract source. No installs/package changes. Frontend is Claude-owned and unchanged; no repeated frontend test/build sweep here. No live RPC, real wallet, secret, signing, broadcast, listener, deploy, push or merge. This is eligibility and isolated DB evidence; durable claims still own wallet execution permission, and root owns trusted deployment proof/app/runtime validation.
