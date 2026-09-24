# First GIWA test-cash bootstrap

`runStocksBootstrap` is a one-time dependency-injected engine, not a faucet service. It sends only `StocksTestCash.faucet(reviewedRecipient, amount)` on the reviewed chain91342 deployment and caps funding at10,000 units of six-decimal test cash. Recipient must differ from the administrator and all five registered contracts. This module has no RPC endpoint discovery, password/key loader, HTTP listener, schema migration, or default actual customer.

```js
const result = await runStocksBootstrap({
  manifest,
  reviewedManifestDigest,
  recipient: reviewedCustomerAddress,
  amount: '10000000000',
  pool: dedicatedSignerPool,
  chain: createStocksRpcPort(rpc, manifest),
  rpc,
  custody: createLocalKeystoreCustody({ signerAddress, fees, limits, signTransaction }),
  limits,
  store: createBootstrapFileStore(permanentOwned0700Directory),
});
```

`limits` uses bigint `maxGas`, `maxFeePerGas`, `maxTotalFeeWei`; maximum bounds are2,000,000 gas,3gwei and0.006 test ETH. Every signed transaction must separately pass the existing EIP1559 verifier. A custom `rpc` must support deployment/receipt reads, transaction nonce reads, and the initial raw transaction send; the deliberately narrower normal signer RPC adapter is insufficient for deployment/receipt reads.

The result is `{status:'PENDING', originalTransactionHash}` or `{status:'COMPLETE', originalTransactionHash, initialNonce}`. The caller polls the same function using the same store and plan. It must display pending as pending. Missing, malformed, changed, reverted or ambiguous data never means complete. Generic provider/custody/filesystem errors are replaced by fixed error codes.

The create-only `plan.json` binds the manifest digest, administrator, customer, amount, exact calldata, nonce and fee bounds. `intent.json` stores the hash verified from signed bytes before the only send. Signed bytes are never stored. An existing plan can never sign again, including a crash before signed-hash persistence; missing intent requires investigation. Existing intent permits only original-hash lookup, including when that hash was never broadcast. `handoff.json` binds a finalized successful mint and the following nonce before the create-only database seed. A lost database commit acknowledgement is recovered only from the same immutable handoff and exact account binding. An unrelated pre-existing account is rejected; it is never deleted or reseeded.

## Mandatory launcher ownership

The reviewed launcher is the sole initial-seed authority. It must bind this one permanent state directory to the persistent signer cluster, hold a session advisory lock across bootstrap polling and normal host lifetime, and reject a missing/replaced cluster, database, proof or already-attempted state directory. It must create an independent durable attempt marker before first use; a marker without the corresponding plan requires investigation. It may start the normal signer only after `COMPLETE`. No alternative seed command or periodic faucet is part of this flow.

Each engine invocation also holds `SHARE ROW EXCLUSIVE` on `stocks_signer.account_nonce` across absence check, send/lookup and handoff, blocking concurrent ordinary seed INSERTs and journal writes during that invocation. `PENDING` releases this transaction lock. PostgreSQL cannot prohibit an independent privileged operator from manually inserting a seed between polls or while the launcher is stopped; the caller ownership rule covers that boundary. A subsequently observed unrelated account fails closed. The unchanged normal host never auto-seeds and is unready while the account is absent.

Only the first bootstrap is supported. After handoff, further test-cash funding needs a separately reviewed extension sharing the normal nonce journal. Do not use an administrator wallet outside the launcher while it owns this account.

## Durable store

The caller supplies an existing owned0700 absolute directory with no symlink path components. Files are owned0600 regular files, limited to16KiB, and published exclusively from fsynced temporary files before syncing the directory. Symlinks, multiple links, FIFOs, oversized/torn data, unexpected fields and replacement attempts are rejected. A crash leaving an ambiguous hardlink publication fails closed. These records contain public transaction metadata only; actual keys, passwords and database credentials do not belong here.
