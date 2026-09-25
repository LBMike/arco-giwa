# GIWA-LOCAL-OBSERVER-FIX-014 evidence

2026-09-25. Base db98882. User's bootstrap transaction0xb179edf7d0b17f58d23dfd27c357d65d7602c6e0223b5fd2b6a02a41917b7a04 completed; the launcher then failed at OBSERVER_RECONCILIATION.

Read-only Supabase inspection at2026-09-24T15:34:42Z found cursor36890491, version1, updated15:31:18Z and no operator-control row. This is exactly the initial100-block checkpoint batch. A dry invocation of the actual compiled observer on the next100 blocks passed CATCHING_UP with zero logs. It used a read-only database transaction and intercepted every cursor mutation and advisory-lock query; no economic hook, signing or control change occurred. Original underlying RPC/DB exception was not retained, so its precise cause is unknown.

Deterministic reproduction confirmed the local warm-up aborted on the first unavailable observation after progress. The repair retries unavailable/busy observation at2/5/10-second intervals, requiring fresh CURRENT coverage and full matched reconciliation before existing audited version-zero resume. Later pauses, projection-review states, stale observations and mismatches still block. Recheck cancellation and observation freshness after the last awaited pause read. Only fixed diagnostic messages are printed.

Independent review confirmed the warm runtime exposes no API while waiting and the unchanged runtime health gate blocks new dispatch. No cursor reset, journal reseed, test-cash replay or shared runtime interface change.

Validation:
-17 focused tests pass, including10 readiness recovery/gate/diagnostic cases and actual isolated PostgreSQL persistent storage/restart/guard tests.
- Server584 pass,92 skipped,0 failed (676 total).
- Frontend921 pass,26 skipped,0 failed (947 total); this run omitted the optional DOM runtime used in earlier012 evidence.
- Typecheck, production build, security and migration SQL inspection pass. Existing dependency/large-bundle warnings remain.
- The first sandboxed server run could not bind local test ports. An authorized local-port rerun exposed missing compiled contract artifacts. Offline compilation of unchanged reviewed contracts succeeded:46 Solidity files, cancun. Final server run passes with those artifacts.

Packaging defect: the durable git archive also lacks packages/contracts/artifacts. Its API reads six legacy ABI files through server/src/evm/abi.ts. Include exactly those compiled artifact files in the durable integrity manifest; no Solidity source or deployed contract changes. The reviewed local starter and checksums must be installed before user restart. Live API startup/4392 connection/customer trade remain pending user-local keystore unlock.
