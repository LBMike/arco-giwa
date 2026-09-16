# GIWA-STOCKS-WALLET-001

Builder approval: user explicitly requested continued parallel development. Base `bac9020a1078b39df52be4a4e6f711ec489e1685`, isolated clone `/private/tmp/arco-giwa-stocks-wallet-20260917`, branch `codex/giwa-stocks-wallet-20260917`. The host mount candidate remains unchanged.

Plan recorded before code:
- Add only `src/demo/giwa/stocks-wallet/**`, this task and matching evidence. No feature/router/provider/server/contract/dependency edits.
- Pure browser-compatible planner: pin manifest v2 and current ABI digest, reviewed deployment evidence, authenticated accepted order identity, exact NVDA test amounts, chain 91342 and contract calldata.
- Explicit controller stages: prepare, bounded ERC20 approval if required, successful matching approval receipt, fresh order/policy/allowance/wallet checks, then a separate explicit deposit/escrow request. No automatic transfer after approval.
- A required trusted durable submission gate must atomically claim each physical order/stage BEFORE a wallet request. Missing deployment verification, current execution policy or durable gate fails closed. BUY vault permits duplicate deposits; browser memory/storage cannot prove an order has never been submitted across reloads/devices. Existing public APIs do not provide these missing adapters.
- Preserve late wallet outcomes under their original intent; UNKNOWN/hash-known attempts cannot be retried automatically or erased by account/input/session changes. Hash/receipt is never order completion or a holding increase.
- Fake-wallet/read/journal tests, including real checked-in Solidity ABI/artifact compatibility, precision, deadlines, stale order, session A→B→A, 401, duplicate clicks, uncertain outcome and re-creation recovery. No public RPC, actual signature, existing DB or real wallet.
- Run typecheck/build/frontend/security/design checks and record existing seven token findings separately.
