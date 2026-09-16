# GIWA Stocks common host session — implementation evidence

Status: implemented and locally verified as an **unmounted host module**. No existing page now logs in through this module. Feature/router composition and real application/wallet integration remain subsequent tasks.

Base: `bc67cf2a8ae98d3e5f820627afe8f25046a0891a`. Worktree: `/private/tmp/arco-giwa-stocks-host-20260917`, independent local clone; branch `codex/giwa-stocks-host-20260917`. This document is included in the implementation commit; obtain its exact SHA with `git log -1 -- docs/evidence/giwa-stocks-host-20260917.md`.

Builder: current Codex commander `/root`, under the user's instruction to continue development. Reviewer: `/root/contracts_review`, a different agent, read-only in the builder working directory. The reviewer did not use a separate immutable checkout; this limitation is intentional and disclosed.

## Scope

- New `src/demo/giwa/stocks-host/`: in-memory controller, active-wallet message signing bridge, feature session adapters, external-store hook, documentation and two test files.
- Existing `contracts.ts`: only the internal wallet client type now optionally exposes `getAddresses`, `getChainId`, `signMessage`. Existing runtime transaction logic is byte unchanged.
- This task/evidence documentation.
- No investor/admin builder files, routes, provider mounts, server, DB, deployments, dependencies, locks, wallet SDK configuration or common design token edits.

The controller uses the existing nonce/verify contract, frontend SIWE domain, current wallet account/chain checks and server-issued 15-minute-or-shorter JWT. Host snapshots fail closed on wallet/chain/context replacement, logout, disposal, expiration and late responses. Credentials exist only in memory. Operator authority remains exclusively server-side. Login requests only a message signature on explicit action; no transaction methods are used.

## Executed checks

| Check | Result |
|---|---|
| `node --import tsx --test 'src/demo/giwa/stocks-host/*.test.tsx'` | Final **31/31**, exit 0 |
| `npm run test:frontend` | Final **206/206**, exit 0 (existing 175 + new 31); prior intermediate run 204/204 is not added to this total |
| `npm run typecheck` | exit 0, including final two added test cases |
| `npm run build` | exit 0; existing large-bundle warning remains; host is not mounted by this build |
| `npm run test:security` | exit 0; both existing checks passed |
| design token hook `--all` | exit **1**, the same 7 pre-existing findings in unchanged Investor/components files, zero new findings |
| story structure hook `--all` | exit 0; existing soft missing-story notices |
| `git diff --check` | exit 0 |

New tests include a real SIWE message signed by an ephemeral generated test account and verified by the same `SiweMessage` library used in the backend. All HTTP and wallet-provider interactions are injected test doubles; no live keys, public RPC, actual wallet prompts or backend database are used. Dynamic source selection and the injected viem source are both exercised; the latter permits only accounts/chain reads and `personal_sign`. Backend auth routes themselves were not re-tested here, because no server file changed.

## Review findings resolved before completion

The independent reader identified two boundary cases. Builder first added normal-expectation regressions and observed **2 failures**, then corrected both:

1. An external `getSnapshot()` could detect expiration, clear the timer, but never notify subscribed UI. Expiration now schedules one asynchronous notification for that still-current snapshot. It neither mutates another generation nor synchronously notifies React during a read.
2. A subscriber could log out/change context/dispose during authentication publication; `signIn()` would return the discarded token. A post-publication generation check now returns null instead.

Red evidence: `/private/tmp/giwa-stocks-host-review-red.log`. After the fixes all tests passed. Reviewer then independently ran the final **31/31** tests in this same working directory (no source edits) and reported no further confirmed P0/P1/P2. The reviewer's result is not described as a second checkout or route integration verification. Root ran the wider frontend/typecheck/build/security checks above.

Logs on this machine:

- `/private/tmp/giwa-stocks-host-tests.log`
- `/private/tmp/giwa-stocks-host-frontend-final.log`
- `/private/tmp/giwa-stocks-host-build.log`
- `/private/tmp/giwa-stocks-host-token.log`

## Remaining work

The integrator must mount one correctly owned controller, synchronously propagate wallet/context changes, use the feature adapters and define investor/admin navigation lifetime. The current investor/admin modules are still being built separately. `/admin/stocks` must not inherit the legacy operator-token/allowlist guard. Only the backend can grant named Stocks read permissions.

This module's logout is local memory discard, not server JWT revocation. No automatic renewal exists. An expired/cancelled host attempt cannot dismiss an external wallet extension's prompt; its late signature is discarded. The real Dynamic SDK/installed wallet, public RPC and actual HTTP auth integration require subsequent validation.

No public deployment, signing, broadcast, main merge or push occurred. Existing review evidence was preserved.
