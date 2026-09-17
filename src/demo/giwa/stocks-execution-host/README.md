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

## Lifetime (`registry.ts`, `StocksExecutionProvider.tsx`)

- **One registry per host identity.** The identity is the session ID, wallet address, chain, wallet epoch, captured source object and API base (`executionIdentityKey`).
  - The page provider creates the registry in a layout effect and disposes it in the cleanup. StrictMode's setup → cleanup → setup therefore never reuses a disposed registry.
  - During render, a registry whose key no longer matches is never handed out, even before effects run.
  - The wallet source is captured once per registry.
- **One owner per accepted order (`side:orderId`).** The owner holds for its whole life:
  - one `createExecutionClock()` and one monotonic source, shared by the reads, the gate and the controller
  - the read adapter
  - the submission gate, bound to session, side, order, deployment digest, API base and wallet
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
- **Failure:** a failed read leaves a stable code (`evidenceFailure()`) shown next to the check. A 401 invalidates only the captured session ID.
- **Wallet steps:** approval, deposit and escrow need current evidence at their click. When the evidence ends, unrecorded ready screens return to "Not checked yet" (003A-1 controller rule), and recorded screens stay.

## Capability

`registry.capability` is `READY` or one of these codes. The page header (Korean) and the panel explain each one.

| Code | When |
| --- | --- |
| `API_BASE_NOT_CONFIGURED` | The page API base failed the common check (`../api-base.ts`) |
| `SESSION_REQUIRED` | No Stocks session |
| `WALLET_SOURCE_UNSUPPORTED` | Dynamic mode. Its wagmi connector client has no single-attempt raw request (nested viem transports retry), so no execution is offered and `window.ethereum` is never used in its place. Also an injected provider without events |
| `WALLET_SOURCE_MISSING`, `WALLET_NOT_CONNECTED` | No provider or address |
| `WALLET_MISMATCH` | The connected wallet is not the session wallet |

When the capability is not READY, the investor order card keeps its "not available in this app yet" wording (`useStocksOrderExecutionSlot` returns null). Moved-on orders get no panel unless this identity already owns one, which keeps showing its recorded attempt next to the server status.

## Session end

When the identity ends with an open, answered or uncertain wallet request (logout, session expiry, reload of the host), the registry is disposed. `StocksExecutionSessionNotice` then shows, while signed out with the same wallet, a notice without order, amount or hash. It says to sign in again, check the order, and not repeat anything from another app.

Known limit: the original gate refuses to record a late hash once its session has expired by time. The server journal then keeps only the reserved claim. The next session's check shows it as recovery-only (UNKNOWN, do not repeat), not as the hash; see `full-stack.test.tsx`. Nothing re-issues the old request with a new session, and no automatic retry exists.

## Wallet request rules (from `../stocks-wallet-source`)

- **The only requests through the captured provider:** `eth_chainId`, `eth_accounts`, `eth_getBlockByNumber(checkpoint)`, `eth_call(allowance)`, and one `eth_sendTransaction`.
- **Never used:** `wallet_sendTransaction`, `eth_sendRawTransaction`, account requests, chain switches, gas or nonce reads.
- **Dispatch:** `requestTransaction` checks everything synchronously and issues the single send before returning. The controller's last policy and authority checks are therefore the last code before the wallet.
- **Synchronous refusal (for example an account change inside a SIGNING subscriber):**
  - It happens inside the controller's dispatch `try`, so the reserved claim is recorded as `UNKNOWN` (recovery-only), although nothing was sent.
  - This is fail-closed but pessimistic. Changing it needs a controller change, which was not part of this task.

## Tests

```sh
TMPDIR=/private/tmp node --import tsx --test src/demo/giwa/stocks-execution-host/*.test.tsx src/demo/giwa/stocks-execution-host/testing/harness.test.tsx
```

- `registry.test.tsx`:
  - no I/O on creation
  - capability codes (Dynamic: no client access, no `window.ethereum` read)
  - identity keys
  - pinned rows
  - live context
  - evidence read sharing, keep/replace, stale scope, failure and 401
  - dispose abort
  - clock failure and explicit restart
  - source guards
- `full-stack.test.tsx`: real registry, controller, reads, gate and ports against the real server plugins (`testing/`), with a fake wallet on the same fake chain.
  - BUY/SELL exact wallet and server requests
  - other checkpoint, other chain, missing checkpoint
  - A→B→A, same-address source swap, swap during the allowance read
  - account change inside a SIGNING subscriber
  - a 4 s policy with a 6 s check inside the final wallet read and 15 s evidence → 0 sends, plus a negative control with a port that awaits
  - open prompt across evidence expiry, logout/reload, expired-session limit, late 401, cancel
  - 4001/-32603, revert, pending finality
- `testing/`: a TEST-ONLY in-process server (real Stocks, execution and submission plugins over memory SQL, the real evidence and receipt verifier over a fake chain, fake EIP-1193 wallet). Never imported by product code.
