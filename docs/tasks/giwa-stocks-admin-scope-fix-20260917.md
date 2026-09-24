# GIWA Stocks admin scope isolation fix

- Pinned base: `1f654c350036352e359a39f3b190976c4a7bca21`.
- Authorized commander delegation: fix confirmed P2 R1, implement and locally commit without another approval pause.
- Scope: stocks-admin feature/tests and these task/evidence documents; correct historical integration advice only in original admin task/evidence.
- Plan recorded before implementation: reproduce reviewer first-commit DOM failures; introduce an internal scope-key owner so each committed scope starts with a fresh store; retire old store requests/callbacks in layout cleanup. Preserve same-id token rotation. Add DOM regression coverage for four transitions, A–B–A, late response/denial, StrictMode, retired callbacks and token refresh. No props, tokens, server or shared route edits.
- Verification: original probe red/green, committed DOM tests with existing external jsdom runtime, module/full frontend suites, typecheck, build, security and design/story hooks; separate seven baseline token findings.
- Offline only; no real wallet/RPC/DB, dependency edit, push, merge or deployment.
