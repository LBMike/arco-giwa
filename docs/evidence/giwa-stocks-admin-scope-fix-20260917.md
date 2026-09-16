# GIWA Stocks administrator scope isolation — builder evidence

Date: 2026-09-17. This is the fix builder's evidence, **not independent acceptance**.

- Pinned base: `1f654c350036352e359a39f3b190976c4a7bca21`.
- Separate clone: `/private/tmp/arco-giwa-stocks-admin-scope-fix-20260917`.
- Branch: `codex/giwa-stocks-admin-scope-fix-20260917`.
- Original builder/reviewer repositories and their evidence were not changed.
- Original issue: `/private/tmp/arco-giwa-admin-review-evidence-20260917/README.md`, R1 [P2].
- Logs and adapted original probe: `/private/tmp/arco-giwa-admin-scope-fix-evidence-20260917/`.

## Fix

`GiwaStocksAdminFeature` now owns an internal keyed child based on `(apiBase, session.id, deploymentKey)`. A changed scope renders a fresh store immediately, so the first committed DOM cannot expose the old owner's orders or environment. The caller does not need to provide a React key. A–B–A produces three owner lifetimes rather than restoring the first A's store.

In the browser, layout setup applies same-id token updates and layout cleanup deactivates the outgoing store before the containing layout effect runs. Existing store generation/request checks then reject late answers, and retired store callbacks cannot restart reads. The SSR path uses a passive effect to avoid layout-effect server warnings; no network activity starts while rendering. StrictMode cleanup/setup remains supported by the store's existing activate/deactivate contract.

Same-id token refresh intentionally retains data and uses the fresh token on subsequent reads. No authorization is inferred from the browser. UI props, visual tokens, API contracts, server and shared routes are unchanged.

Original task/evidence integration advice is corrected: use a sibling route outside legacy `RequireGiwaAdmin` / operator-token shell. The old base's lack of a SIWE host is distinguished from later separate host candidate `bac9020a`. No actual route integration was performed.

## Reproduction and checks

The reviewer probe was copied to scratch, changing only its repository and output paths. Original evidence remains intact. It mounts the real feature via ReactDOM and inspects first-commit DOM from a parent layout effect.

| Check | Result |
| --- | --- |
| Original probe against unchanged pinned base | **0/4 passed, 4 failed**, process exit 1; logout/session B/API/deployment all retained old order data |
| Same probe after fix | **4/4 passed**, exit 0 |
| Committed `scope-render.test.mjs` | **10/10 passed**, exit 0, no skips |
| `npm run test:frontend` | **219/219 passed**, exit 0, no skips; this existing glob does **not** include the separate `.mjs` DOM suite |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0; existing large chunk warning remains |
| `npm run test:security` | exit 0 |
| Design token hook `--all` | exit 1, exactly the seven unchanged known-debt findings; no new finding |
| Story hook `--all` | exit 0, existing soft warnings only |
| `git diff --check` | exit 0 |

New DOM coverage: four first-commit scope changes; A–B–A with abort-ignoring old 200/401/403; retired store actions in the next parent's layout; same-id token rotation and immediate new-token refresh; StrictMode replay plus final unmount/late response. This complements the original 44 admin unit/SSR tests included in the frontend 219 count.

## Re-run the committed DOM regressions

The repository has no jsdom dependency and this task does not change dependencies. Supply an existing jsdom installation's absolute package.json path. A missing runtime fails the command; tests are not silently skipped.

```sh
GIWA_ADMIN_DOM_RUNTIME=/private/tmp/arco-rwa-ui-independent-review-20260917/node_modules/jsdom/package.json \
  node --import tsx --test src/demo/giwa/stocks-admin/scope-render.test.mjs
npm run test:frontend
npm run typecheck
npm run build
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all
node .claude/hooks/check-story-exists.mjs --all
```

Node v24.14.0, React 18.3.1, external jsdom 26.1.0. Dependencies were copied with `cp -cR` from `/private/tmp/arco-giwa-admin-review-20260917/node_modules` after byte-identical package.json/lockfile comparison; no install or lockfile mutation. SHA256:

- package.json: `67de05623952dfc07897ac7deaa269a253ac3e19930a82cb819c594a3eaf6654`
- package-lock.json: `fa5dee4ef139eaf1e7fc77c0838595a773ec46236c05b7e4db82c9803fb2e062`

## Limits

This is an unmounted feature candidate, not a live product release. No real auth provider, browser layout/screenshots, public RPC, wallet, transaction or database was exercised. Existing historical screenshot evidence was not regenerated. Server tests were not repeated because no backend/contract files changed. No push, merge, deployment or shared route edit. Independent follow-up review is still required.
