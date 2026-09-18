# /stocks wallet execution host (`stocks-execution-host`)

Connects the existing `/stocks` page to wallet execution for an accepted GIWA Stocks order. It covers the check, exact approval, server-verified approval and separate deposit (BUY) or escrow (SELL). It composes existing modules and adds no wallet, transport, journal or verification rule of its own.

**Not verified with a real wallet, extension, public RPC or real funds.** Every test uses a fake EIP-1193 wallet, an in-process server and a fake chain. A transaction hash, a mined receipt or a server-confirmed approval never means the order is complete; only the server order state says that.

## What it composes

| Piece | Module |
| --- | --- |
| Wallet controller (plan, durable claim, dispatch rules) | `../stocks-wallet` |
| Evidence, policy, order and catalog reads | `../stocks-wallet-http` (`createStocksExecutionReads`, `createExecutionClock`) |
| Durable submission journal with server reconciliation | `../stocks-wallet-submissions` (`createSubmissionGate`) |
| Active wallet source capture and wallet ports | `../stocks-wallet-source` |
| Panel | `../stocks-wallet-ui` (`StocksWalletExecutionPanel`) |
| Session | `../stocks-host` (`useGiwaStocksHost`) |
| Kept late hashes and their explicit recovery (003D) | `../stocks-known-hash-recovery` |

## Lifetime (`registry.ts`, `StocksExecutionProvider.tsx`)

- **One registry per host identity.** The identity is the session ID, wallet address, chain, wallet epoch, captured source object and API base (`executionIdentityKey`).
  - The page provider creates the registry in a layout effect and disposes it in the cleanup. StrictMode's setup → cleanup → setup therefore never reuses a disposed registry.
  - During render, a registry whose key no longer matches is never handed out, even before effects run.
  - The wallet source is captured once per registry.
- **One owner per accepted order (`side:orderId`).** The owner holds for its whole life:
  - one `createExecutionClock()` and one monotonic source, shared by the reads, the gate and the controller
  - the read adapter
  - the submission gate, bound to session, side, order, deployment digest, API base and wallet. It is wrapped by `captureKnownHashes`: every call and failure passes through unchanged, and a hash the wallet returned is kept in this tab only when this original gate could not record it
  - the wallet ports, the `WalletPorts` object and its controller
  - Nothing is recreated on render, on the panel's display tick, on an order status refresh or on an evidence renewal.
- **Pinned selection.** The first row this identity sees for an order becomes the controller's selection. Later rows (the investor feature replaces the order object on every refresh) reach the panel as `serverOrder` only. Selecting another order uses another owner.
- **`context()` is live and synchronous:**
  - the owner's session, only while the host still shows that exact session
  - the current wallet address, chain and epoch
  - the page API base
  - `reads.currentDeployment(lease)`
- **Dispose** aborts evidence reads, removes wallet event listeners and disposes controllers. It cannot close an open wallet prompt. A late answer still goes to the owner's original gate and is never painted on a new screen.

## Evidence (`refreshEvidence`)

- **Read only as part of an explicit check.** The panel's read-only check first calls `refreshEvidence()`, then the controller's `prepare()` if availability is then READY.
- **Shape of the read:** one in-flight read, with the session captured at start. It never retries, polls or runs on a timer, so it cannot cancel a running check in a loop.
- **Acceptance:** an answer is ignored when the owner was disposed, or the host session or API base changed.
- **Same evidence:** when the server returns the same cached evidence, the current lease object is kept, so its window is neither extended nor restarted.
- **Failure:** a failed read drops the earlier lease, so nothing keeps using evidence the server no longer confirms. It leaves a stable code (`evidenceFailure()`) shown on "Not checked yet" and on every screen that offers the read-only check. Evidence for another manifest digest is refused. A 401 invalidates only the session ID captured when the read started, even if the host has moved on.
- **Wallet steps:** approval, deposit and escrow need current evidence at their click. When the evidence ends, unrecorded ready screens return to "Not checked yet" (003A-1 controller rule), and recorded screens stay.

## Capability

`registry.capability` is `READY` or one of these codes. The page header (Korean) and the panel explain each one.

| Code | When |
| --- | --- |
| `API_BASE_NOT_CONFIGURED` | The page API base failed the common check (`../api-base.ts`) |
| `SESSION_REQUIRED` | No Stocks session |
| `WALLET_SOURCE_UNSUPPORTED` | Dynamic mode (reported before sign-in too). Its wagmi connector client has no single-attempt raw request (nested viem transports retry), so no execution is offered and `window.ethereum` is never used in its place. Also an injected provider without events |
| `WALLET_SOURCE_MISSING`, `WALLET_NOT_CONNECTED` | No provider or address |
| `WALLET_MISMATCH` | The connected wallet is not the session wallet |

When the capability is not READY, the investor order card keeps its "not available in this app yet" wording (`useStocksOrderExecutionSlot` returns null). Moved-on orders get no panel unless this identity has already seen the order (an owner exists or was restarted), which keeps showing its recorded attempt next to the server status.

## Session end

When a signed-in identity ends with an open, answered or uncertain wallet request (logout or session expiry while the page stays mounted), the registry is disposed. `StocksExecutionSessionNotice` then shows a notice while signed out with the same wallet. It names no order, amount or hash, and has no link or button. It has two variants.

**No hash kept (the 003B-1 copy):**
- The request itself is on the server (its claim was reserved before the wallet opened). A wallet answer that arrived after the session ended may not have been recorded, even if the transaction was sent.
- Sign in again with the same wallet and check the order. The check only shows what the server has already recorded, and cannot add a wallet answer the server never received.
- Never send the approval, deposit or escrow again from any app or wallet. If the check shows the result as unknown, or the order can no longer be checked (for example after the quote deadline), contact operations.

**A hash was kept in this tab (003D):** the original gate could not record the hash the wallet returned (see `../stocks-known-hash-recovery`). It is also shown while this tab keeps an unrecorded hash for the wallet without an ended attempt, on whatever network the wallet is on. Its title ("This tab kept a transaction hash the server may not have recorded") asserts no timing. It says:
- this tab kept the returned hash, and the server may not have it;
- sign in again with the same wallet in this tab and open the order to record it there. Nothing is recorded or sent automatically;
- the hash is kept only in this tab's memory, and reloading or closing the page loses it;
- never send again; operations if the order shows unknown or the hash cannot be recorded.

A later session for the same wallet that ends without such a request clears the ended-attempt part. A still-kept hash keeps its variant.

The notice lives in page state, and kept hashes live in this tab's memory: after a reload both are gone. While the order can still be checked, the next check shows the reserved claim as recovery-only (UNKNOWN, do not repeat) or the recorded hash. After the quote deadline the panel offers no check.

**Kept-hash recovery (003D).**
- **Where the card appears:** in the order slot, for the signed-in owner (session wallet = shown wallet, chain 91342, same API base and origin) on the exact order and deployment. This is filtered during render, so another wallet, chain, API base, origin, order or deployment never sees it, from the first commit on.
- **Moved-on orders:** it also renders for a moved-on order that this session has not pinned, and that case gets no execution panel.
- **The click:** runs `recoverKnownHash` with a new gate pinned to the current session: inspect the original binding, record only the original hash, reconcile. It stops without painting or storing when the identity key changes or the card unmounts.
- **401:** invalidates only the pinned session.
- **Never:** a claim, a wallet request, a policy read, a deadline check or a retry.

**Still missing (browser):**
- recovery after a reload, in another tab or on another device (memory only);
- a hash the application never received (no manual entry, wallet search or guess);
- the answer of a request whose wallet returned no hash (UNKNOWN stays recovery-only).

## Wallet request rules (from `../stocks-wallet-source`)

- **The only requests through the captured provider:** `eth_chainId`, `eth_accounts`, `eth_getBlockByNumber(checkpoint)`, `eth_call(allowance)`, and one `eth_sendTransaction`.
- **Never used:** `wallet_sendTransaction`, `eth_sendRawTransaction`, account requests, chain switches, gas or nonce reads.
- **Dispatch:** `requestTransaction` checks everything synchronously and issues the single send before returning. The controller's last policy and authority checks are therefore the last code before the wallet.
- **Synchronous refusal before the provider call (for example an account change inside a SIGNING subscriber):**
  - No `eth_sendTransaction` is issued (0 sends).
  - It happens inside the controller's dispatch `try`, so the reserved claim is still recorded as `UNKNOWN` (recovery-only, no hash).
  - This is fail-closed but pessimistic. Changing it needs a controller change, which was not part of this task.
- **A change after the provider request is open** is a different case. The request was issued (1 send) and cannot be cancelled. A late hash may still arrive, and it goes to the original gate.

## Tests

```sh
TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/stocks-execution-host/*.test.tsx src/demo/giwa/stocks-execution-host/testing/harness.test.tsx
# the page DOM test needs an existing jsdom (skipped without it)
GIWA_HOST_DOM_RUNTIME=/path/to/node_modules/jsdom/package.json TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/stocks-execution-host/page.dom.test.tsx
```

- `registry.test.tsx`:
  - no I/O on creation
  - capability codes (Dynamic before and after sign-in: no client access, no `window.ethereum` read)
  - identity keys, including chain
  - pinned rows, and eligibility after a restart
  - live context
  - evidence read sharing, keep/replace, stale scope, failure dropping the lease, another manifest, 401
  - a late 401 after the host moved to a newer session
  - dispose abort
  - clock failure and explicit restart
  - no newer-session token
  - source guards
- `full-stack.test.tsx`: real registry, controller, reads, gate and ports against the real server plugins (`testing/`), with a fake wallet on the same fake chain.
  - BUY/SELL exact wallet and server requests
  - other checkpoint, other chain, missing checkpoint
  - A→B→A, same-address source swap, swap during the allowance read
  - account change inside a SIGNING subscriber
  - a 4 s policy with a 6 s check inside the final wallet read and 15 s evidence → 0 sends, plus a negative control with a port that awaits
  - open prompt across evidence expiry, logout/reload, expired-session limit, late 401, cancel
  - 4001/-32603/invalid hash, revert, pending finality
- `known-hash.dom.test.tsx` (gated like the page DOM test): first-commit visibility of kept hashes across deployment, origin, API base, chain and wallet changes and A→B→A. A moved-on, unpinned order shows only the recovery card. A card that unmounts while its recovery is in flight stores nothing. Notice variants, including another network.
- `scope.test.tsx` (no DOM): the kept-hash owner scope requires the session wallet to be the shown wallet on chain 91342.
- `page.dom.test.tsx` (real `/stocks` routes in StrictMode, real host, investor feature, provider, panel, controller, reads, gate and ports over the in-process server):
  - mount and sign-in with zero wallet or execution requests
  - BUY accept → check → approve → server reconcile → deposit, with exact params
  - SELL through the Orders tab
  - server status refresh keeps the pinned hash
  - double click and repeated keyboard activation
  - clock jump during an open prompt
  - account switch and sign-out during a held send
  - Dynamic source
  - remount during a held send
  - 11–12, BUY and SELL: session expiry by time during a held approval, and the wallet then answers with an error.
    - No hash is kept: 0 outcomes, claim without hash, no recovery card.
    - The notice promises no recovery by checking.
    - A new session's check shows UNKNOWN without a hash, with 0 outcomes and 1 send in total.
  - 13–16, BUY/SELL × APPROVAL/TRANSFER: late hash after expiry → kept-hash notice (exact copy, no order or hash) → same-owner sign-in → "Record this hash" (activated twice).
    - Each run makes 1 inspect, 1 outcome with the original binding and hash, and 1 reconcile. The result is CONFIRMED on the server, with 0 claims and 0 wallet requests.
    - 13: A→B→A (B never paints A's hash, order, notice or card), then after the quote deadline, with no new deposit offered.
    - 14: after the deadline with trading paused.
    - 15: a moved-on order.
    - 16: before the deadline; the panel's own check then shows the recorded escrow.
  - 17: a slow recovery answer across a sign-out paints and stores nothing; after the next sign-in the hash is recorded once.
  - 18: S1's recovery request is outstanding when the owner signs out and in again (S2). S1's 401 then leaves S2 signed in, and the hash stays kept and is recorded once.
  - 19: a reload loses the kept hash; the new page's check stays recovery-only.
  - 20: the original answer arrives after the same owner signed in again. The old callback writes nothing with either token; the card appears live and records the hash only on the click.
  - Recovery requests in 13–18 and 20 carry one token, never the original claim's. No wallet call of any kind happens during recovery.
- `testing/`: a TEST-ONLY in-process server (real Stocks, execution and submission plugins over memory SQL, the real evidence and receipt verifier over a fake chain, fake EIP-1193 wallet). Never imported by product code.
- `verification/`: an offline loopback page for a browser check of the same real page code (see its README). Not part of the app build.
