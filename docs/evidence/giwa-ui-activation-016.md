# GIWA local UI activation016 evidence

2026-09-25; base516b620. User reports LOCAL_CUSTOMER_API_READY. Direct local GET4493/ready/stocks independently returned200, ok=true, service=arco-giwa-stocks. This remains coarse readiness, not authorization for an order. Local public catalog is DEMO_TESTNET / MOCK_BROKER / GIWA91342, NVDA fixed test price120.000000, cashARCO_TEST_USDC and the approved deployment ID.

Read-only public RPC verified customer0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2 holds10000000000 cash base units at scale6 (10,000 test cash) and2999500731932093 wei native gas balance. No transaction or signature performed. Do not imply that the general Portfolio page displays this separate Stocks wallet cash balance.

Identified old4392 process96850 runs from the user-owned8609 worktree with customer-reads/customer-auth only. Its gateway does not support local-customer. Durable reviewed gateway supports explicit local Stocks+SIWE4493 routing and fixed legacy/public RPC routing, while refusing fixture/admin paths.

A read-only whole-src/public comparison found9 source files and8 public assets needed to preserve the existing Funds reference additions. They were copied byte for byte into this worktree; original source remains untouched. No other runtime UI differences were found. The newer investor-shell fixture tests, gateway and serve entry remain. Reference Funds keep their existing read-only detail behavior. Independent agent verified dependency closure and absence of Stocks/Portfolio/Savings conflicts.

Existing market provider settings were copied directly between local files with directory0700/file0600, without output or Git inclusion. The screen reads the same existing providers. No new account, key, contract, database migration or production deployment is introduced.

Typecheck/build/security/migration inspection passed. Server584 pass,93 skipped,0 failed;7 focused native-HTTP gateway tests pass. Frontend926 pass,26 skipped,0 failed (952 total); the5 preserved DigiFT tests passed. Existing SSR/chunk-size warnings remain. Final installed/browser verification is recorded in the bundle public source-version.json after activation. User sign-in and an actual customer buy/sell roundtrip remain user actions.
