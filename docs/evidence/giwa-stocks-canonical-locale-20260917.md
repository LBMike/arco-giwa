# Canonical locale compatibility repair evidence

Base: c97c5c9775572ace1d5510356c2f710b562c364f. Branch: codex/giwa-canonical-locale-20260917. Isolated local clone: /private/tmp/arco-giwa-canonical-locale-20260917. Production change: canonicalJson passes explicit en-US to localeCompare, with a compatibility comment. No data/schema/API/UI/activation changes.

Dependency reuse: node_modules symlink from exact base checkout /private/tmp/arco-giwa-submission-diagnostics-20260917. package-lock.json SHA-256 equals source: fa5dee4ef139eaf1e7fc77c0838595a773ec46236c05b7e4db82c9803fb2e062. Ignored ABI artifacts linked from the same checkout's packages/contracts/artifacts; contract sources are unchanged from base. No install/fetch, DB, public RPC, signer, wallet, secret file or deployment action.

Logs: /private/tmp/arco-giwa-canonical-locale-evidence-20260917. Independent investigation/raw old-en fixture capture: /private/tmp/arco-giwa-canonical-digest-review-evidence-20260917 (README, probe.mjs, per-locale JSON, old-en-vectors.json, freeze-old-en.mjs). Golden bytes were frozen from unchanged c97c5c9 BEFORE the production edit. 13 vectors cover actual schema shapes and arbitrary-key counterexamples (transaction vectors are BUY APPROVAL and BUY TRANSFER; SELL coverage here is the broker payload, not a SELL transaction golden); tests never recompute expected hashes from the new algorithm.

Commands/results:

- npm run build:server before change: exit 0; before-build.log.
- node --test server/dist/stocks/canonical-locale.test.js before change: exit 1, en-US PASS, cs-CZ and sk-SK FAIL; before-test.log. Both failures reproduce manifest/transaction/call/proof identity mismatch and reordered-row mismatch using real child-process locales.
- npm run build:server after change: exit 0; after-build.log.
- node --test server/dist/stocks/canonical-locale.test.js after change: exit 0, 3/3 PASS; after-test.log. Every child compares 13 fixed canonical byte/digest vectors plus actual manifest/call/enrollment/deriveOrder entrypoints and recursively reordered JSONB-like values.
- node --test 'server/dist/**/*.test.js': exit 0, 330 PASS / 68 SKIP / 0 FAIL; server-tests.log. Skips are existing explicit isolated-DB gates, not DB validation. No DB was started or connected for this task.
- npm run test:security: both env exposure and EVM-version checks PASS; security.log.
- git diff --check: exit 0.

Locale tests record Node v24.14.0 / ICU 78.2, and verified effective locales en-US, cs-CZ, sk-SK. Child environment passes only PATH, LANG, LC_ALL, TZ. Child stdout records only version/locale and fixture check names, never arbitrary environment values.

Known limits: explicit en-US preserves historical en-US hashes under the tested runtime; it is not a version-independent ICU guarantee or a universal JSON canonicalization change. Existing en-US Unicode collation ties are retained; an external legacy-collation-tie.mjs/log records that limitation without broadening the fix. Runtime upgrades need golden-vector verification. Existing external persisted records and signer identities were not inspected; cs/sk-written records require an authorized compatibility audit before activation, with no automatic rehash, fallback claim, deployment alias or data rewrite. Claude must separately update the browser planner locale and URL delimiter guard. Frontend source was neither changed nor tested in this backend-only patch.
