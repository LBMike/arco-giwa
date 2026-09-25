# GIWA customer wallet fix017 task contract

Root builder/integrator; branch codex/giwa-customer-wallet-fix-017; base6380d90; isolated worktree /private/tmp/arco-giwa-customer-wallet-fix-017. Prior autonomous GIWA local-demo development authorization plus the reported wrong-wallet connection cover this repair. Independent agents audit read-only.

Evidence: actual DOM data-dynamic-env=injected-wallet-fallback. serve.ts isolates env files but only defines API base. No Dynamic UUID arrives; GiwaWalletProvider directly uses window.ethereum and first account. Therefore another injected extension/account can be chosen. This does not prove which extension supplied the user's account. Restoring Dynamic also requires its SDK's existing HTTPS fetch endpoints to pass the preview guard. Original app's published admin-access-BcKlHm9g.js contains VITE_DYNAMIC_ENVIRONMENT_ID4855c810-3521-425f-a6f3-963854d2b013, exported as gr to Arco GIWA Preprod's environmentId. This is a public client identifier, not a secret. Existing selected-Dynamic-provider signing lifecycle stays unchanged.

Allowed files: src/demo/giwa/stocks-execution-host/verification/serve.ts; src/demo/giwa/investor-shell/verification/main.tsx and its existing fixtures.test.tsx import/route guard; new customer-wallet.ts and customer-wallet.test.tsx alongside main; new scripts/customer-demo/ui-config.ts and ui-config.test.ts; src/demo/components/Footer.tsx; task/evidence docs. Root owns these shared integration files. No API, schema, dependency, contract or wallet signing implementation changes. Bundle installation permits only affected files, checksum/wrapper repins, public source-version/README, and validated public Dynamic UUID CLI option in start-ui.command. Preserve existing Funds additions and other user worktrees.

Invariants: local-customer mode requires explicit valid Dynamic UUID; never silently chooses injected fallback. SDK HTTPS requests only to exact official app.dynamicauth.com /api/v0/sdk/{configured UUID}/ prefix, and exact GET static wallet-book resource; nativeFetch without logging auth details. Offline/no-ID modes remain blocked off-origin. Keep same local API/RPC routing and selected-provider controls. Fonts allowed only via actual three font files directories plus source root; strict file serving and existing secret deny retained. No blanket bundle/parent allow. Footer uses existing public brand icon and Arco text.

Failure cases: missing/malformed/duplicate Dynamic UUID, another project/path/lookalike host, HTTP/credentials, offline SDK attempt; source or private files outside roots; secret paths inside roots; missing fonts. Tests cover guard transport identity and blocking, CLI requirement, fs boundary with Vite, original wallet-source lifecycle; frontend/server baseline, typecheck/build/security/migration inspection. Actual4392 browser must show configured Dynamic and wallet chooser; exact font/icon HTTP200 and private denial. No auto-signin/signature, logout, storage deletion, order, transfer, API/signer restart or production change. User selects MetaMask and intended0x3185...76D2 account.

Documentation scope also includes the investor-shell verification README to replace the now-fixed wordmark404 note and document the required public Dynamic CLI setting.

Integration addendum: the durable bundle changed concurrently before installation. The original checksum guard stopped before copying any fix files. Root preserves the5changed DigiFT files plus2new pure display/research modules and1new public logo listed below, verbatim at captured hashes; no reversion of user content. They do not overlap the wallet repair. Required additional validation: typecheck/build/security and7current DigiFT render/data tests. No money path changes. The prior full wallet-fix frontend baseline remains928passed; report the preserved-UI follow-up separately.
- src/demo/giwa/DigiFTFirmMark.tsx
- src/demo/giwa/DigiFTReferenceDetail.tsx
- src/demo/giwa/DigiFTReferenceRow.tsx
- src/demo/giwa/digift-reference-assets.ts
- src/demo/giwa/digift-reference.test.tsx
- src/demo/giwa/digift-reference-portfolio.ts
- src/demo/giwa/digift-reference-research.ts
- public/logos/digift-manager-lionglobal.png
