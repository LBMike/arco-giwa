# GIWA Stocks active wallet source

Browser wallet ports for `stocks-wallet`'s controller, over the wallet the app already uses. It is pure and injectable: nothing is mounted here, and nothing reads `window.ethereum` except the `contracts.ts` accessor. **It has not been verified with a real wallet or a public network**; every test uses a fake EIP-1193 provider.

## Capture

`captureWalletSource(view, { activeSource })` takes the render-time view of `wallet.tsx` (`activeWalletSourceView(useGiwaWallet())`: source object, address, chain, `sessionEpoch`).

| View | Result |
| --- | --- |
| injected provider with `request`, `on` and `removeListener`, valid non-zero address, non-empty epoch | `READY` |
| Dynamic mode, with or without a client | `WALLET_SOURCE_UNSUPPORTED` |
| injected provider without `on`/`removeListener` | `WALLET_SOURCE_UNSUPPORTED` (a swap inside the same object could not be seen) |
| no source, no provider object or no `request` | `WALLET_SOURCE_MISSING` |
| missing, invalid or zero address | `WALLET_NOT_CONNECTED` |
| empty epoch | `WALLET_EPOCH_REQUIRED` |

A `READY` capture holds the provider object. `request(args)` calls `provider.request({ method, params })` directly: no viem transport, so no retry layer. Capture subscribes to `accountsChanged`, `chainChanged` and `disconnect` and issues no request. Any event retires the capture for good (an A→B→A round trip is still stale). `isCurrent()` is synchronous: not disposed, no event seen, and `activeSource()` (normally `currentActiveWalletSource`) still reports injected mode with the identical provider object. `dispose()` removes the three listeners.

### Why Dynamic is unavailable

`useWalletClient().data` is Dynamic's connector client, built from nested viem `custom()` transports. Every client layer's `request` retries -1, -32603, -32005, 429 and code-less errors three times, and `sendTransaction` adds `eth_chainId` and may fall back to `wallet_sendTransaction`. One -32603 can therefore become several `eth_sendTransaction` prompts (a research probe measured 16; `dynamic-control.test.tsx` shows 4 through one layer and 16 through two with installed viem 2.53.1). With the current `providers.tsx` there is no single-attempt raw request, so Dynamic mode is refused with zero calls on the client and no fallback to `window.ethereum`. Enabling it needs a provider configuration decision outside this module.

## Ports

`createWalletSourcePorts({ source, deployment })` returns `readWallet`, `readAllowance`, `requestTransaction` and `waitApprovalReceipt`. `deployment()` is the current context's reviewed deployment; its `manifestDigest` is recomputed from the manifest. Every failure is a `StocksWalletError` code; provider messages are never surfaced, and provider rejections are `REQUEST_FAILED` without retry.

### Checkpoint check (`readWallet`)

The same attestation as the server RPC port (`server/src/stocks/rpc.ts`): `networkInstance` is a reviewed label that only the checkpoint block binds to chain history.

1. `eth_chainId []`: a canonical lowercase quantity equal to 91342 (other chain → `WALLET_NETWORK_INSTANCE_MISMATCH`, malformed → `INVALID_RESPONSE`).
2. `eth_accounts []`: `[0]` equals the captured address (empty or other → `WALLET_CHANGED`, malformed → `INVALID_RESPONSE`).
3. `eth_getBlockByNumber ["0x<checkpointNumber>", false]`: `null` → `WALLET_NETWORK_INSTANCE_MISMATCH`; `number` must be the requested quantity and `hash` a lowercase non-zero 32-byte hash (else `INVALID_RESPONSE`); a different hash (same chain ID, other network) → `WALLET_NETWORK_INSTANCE_MISMATCH`.
4. `eth_chainId` and `eth_accounts` again, then `isCurrent()` (`WALLET_CHANGED`) and the same deployment digest (`CONTEXT_CHANGED`).

`isCurrent()` is also checked before every request. Success returns `{ address, chainId: 91342, connectionEpoch: epoch, deploymentDigest, networkInstance, checkpointHash }` and records an attestation for this capture, digest and address; a failed read clears it.

### `readAllowance`

Only the reviewed pairs (cashToken → fundingVault, stockToken → redemptionEscrow) for the captured owner on chain 91342. Steps 1–3, then `eth_call [{ to: token, data: allowance(owner, spender) }, "latest"]`; the result must be exactly 32 bytes of hex and is returned as a decimal string. The abort signal, `isCurrent()`, `eth_chainId`, `eth_accounts` and the deployment digest are checked again afterwards.

### Dispatch rule (`requestTransaction`)

Not `async`. Synchronously: exact keys `chainId,data,from,to,value`, chain 91342, `value "0"`, hex data, `to` among cashToken/stockToken/fundingVault/redemptionEscrow (`TRANSACTION_MISMATCH`), `isCurrent()` (`WALLET_CHANGED`), a `readWallet` attestation for this capture and the current digest (`WALLET_NOT_ATTESTED`), `from` equal to the captured and attested address (`WALLET_CHANGED`). Refusals are thrown synchronously and send nothing.

Then, with **no await in between**, exactly one `eth_sendTransaction [{ from, to, data, value: "0x0" }]` and the provider's promise is returned unchanged: no retry, no `eth_chainId`, gas, nonce, `wallet_sendTransaction` or `eth_sendRawTransaction`, and no post-check that could discard a late hash. The controller records the answer through its original submission gate. The controller's last await before dispatch is its final `readWallet`.

`waitApprovalReceipt` rejects with `RECEIPT_PORT_INACTIVE` and touches nothing; approval confirmation stays with the server gate's `reconcile`.

## Product glue

- `contracts.ts` `activeWalletSource()`: the module-level source (`window.ethereum` identity in injected mode, the Dynamic client in Dynamic mode). It creates no client and issues no request.
- `wallet.tsx` exposes `source` on the wallet context: the memoised injected provider, or the Dynamic client only while signing is ready.
- `bridge.ts`: `activeWalletSourceView(wallet)` and `currentActiveWalletSource()`.

## Limitations

- Not verified with a real wallet, extension or public RPC.
- The provider must emit EIP-1193 events; a provider that swaps accounts silently is only caught by the next `eth_accounts` read, not at dispatch.
- Deployment evidence lifetime is the controller's check; this module only recomputes the digest.
- New codes (`WALLET_NOT_ATTESTED`, `ALLOWANCE_SCOPE_MISMATCH`, `TRANSACTION_MISMATCH`, `RECEIPT_PORT_INACTIVE`, capture codes) have no dedicated copy in `stocks-wallet-ui/messages.ts` yet and fall to its default message.
