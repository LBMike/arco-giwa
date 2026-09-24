# GIWA-STOCKS-CANONICAL-LOCALE-001

Base c97c5c9775572ace1d5510356c2f710b562c364f. Backend-only compatibility repair, explicitly assigned by root after independent locale reproduction. Claude owns frontend. No database, RPC, wallet, deployment, configuration, secrets, dependency or schema changes.

Problem: shared canonicalJson uses the process default locale. Czech/Slovak collation moves chainId/checkpoint keys, changing manifest, transaction, call and receipt digests. It can disagree with an en-US server/client or existing persisted identities.

Plan before implementation:
1. Freeze exact old en-US canonical bytes/digests from actual supported fixtures: manifest, BUY approval and BUY transfer transactions, physical intent, enrollment binding, authorized call, trusted receipt proof, BUY/SELL broker payload including custodyId. Include mixed-case, punctuation, non-ASCII counterexamples and nested reorder fixtures.
2. Run child Node processes with actual LANG/LC_ALL en_US, cs_CZ, sk_SK; assert actual production hashing against frozen vectors and reverse-key JSONB-like input. Record effective locale, Node and ICU versions. Confirm cs/sk tests fail before changing production code.
3. Change only canonicalJson comparator to explicit localeCompare(b, 'en-US'). Do not switch to code-unit sorting or accept multiple legacy hashes.
4. Repeat locale tests, server build/full offline tests, security check. Database suites stay skipped; no DB service is started. Record exact commands/results and source/dependency provenance.
5. Document locale versus ICU-version guarantees, persisted cs/sk activation-audit requirement, and frontend coordination. Commit owned files only; no push/merge.

Ownership: server/src/stocks/contracts.ts comparator; new dedicated canonical locale tests/fixtures; this task, dedicated contract/evidence documents. Original source candidates remain unchanged.
