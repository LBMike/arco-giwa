# Stocks order creation recovery v1

Claude Code owns UI integration; this change supplies backend endpoints only.

## Endpoints

- BUY: `POST /api/v1/stocks/orders/recover`
- SELL: `POST /api/v1/stocks/sell-orders/recover`

Use the existing signed Stocks session and JSON content type. Authentication runs before body parsing. Query parameters and extra body fields are rejected. Do not provide actor, wallet, side, deployment, or transaction data: these are selected by the authenticated session, endpoint and active backend configuration.

```json
{"quoteId":"the-original-quote-id","idempotencyKey":"the-original-create-key"}
```

`quoteId` is a nonempty string of at most 128 characters. The key matches `[a-zA-Z0-9:_-]{8,128}`, identical to the create-order key format.

200 returns the existing Stocks PROFILE envelope, ISO `observedAt`, and `data` containing the original persisted order fields plus `side: "BUY" | "SELL"`. The ID, order key, amounts, deployment digest, quote expiry and current stored state come from the database. Numeric quantities remain decimal strings. `observedAt` is the response observation time, not a fresh order deadline. Success and errors use `Cache-Control: no-store`.

| Status | Error | Meaning |
| --- | --- | --- |
| 401 | UNAUTHORIZED | Missing/invalid signed session or Stocks scope |
| 400 | INVALID_BODY / UNEXPECTED_FIELDS / INVALID_ORDER_REQUEST | Malformed or unsupported request |
| 404 | ORDER_NOT_FOUND | No committed row visible for the exact actor, wallet, deployment, side and key |
| 409 | IDEMPOTENCY_CONFLICT | An owned row exists for this key but its original quote differs |
| 413 / 415 | BODY_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE | Request transport rejected |
| 500 | INTERNAL_ERROR | Storage or unexpected failure; never treat as missing |

Other actors, wallets and deployments get the same 404 as an unknown key. Responses do not reveal foreign order identifiers or database error details.

## UI recovery sequence

1. Before sending a create-order request, retain the original `quoteId` and `idempotencyKey`, scoped to the actor, wallet, deployment and BUY/SELL side. Persist that association across reloads if supporting reload recovery. Do not persist session credentials with it.
2. After a timeout, disconnected response or reload with an unresolved create request, call the matching recovery endpoint with that exact pair.
3. On 200, restore the original order. Recovery must not trigger approval, transfer, mint, burn or a new order. Read the existing execution policy and submission journal before enabling a separate user action.
4. A 404 is a snapshot, not proof the original request never committed: creation might still be in flight. Retain the pair, allow bounded rechecking, and retry creation only with the SAME key and quote when permitted. Never automatically generate a new key or quote in response to a missing row or timeout. Existing create routes still enforce activation, pause and quote validity.
5. On 409, retain the unresolved request and surface a conflict. Do not silently attach a different quote. On 401, restore a valid session for the same owner before recovery. For 500 or transport errors, preserve the unresolved request for retry.

## Backend guarantees and limits

Recovery is one parameterized SELECT. It does not invoke activation, deployment binding, pause checks, RPC, a signer or broker. It does not write audit entries, enroll orders, reserve stock, acquire transaction locks, extend deadlines or modify submission claims. Existing committed orders remain recoverable during pause and after quote expiry, including terminal states. A recovered row is not execution authorization; expired or paused orders must still be rejected by execution policy/claim validation.

Creation's existing actor/key serialization and unique constraints remain authoritative. Rolled-back or uncommitted orders are invisible. A new process can recover committed BUY/SELL orders after a database restart. The API is registered with the existing optional Stocks runtime, and has no new schema migration, credential or deployment requirement. UI persistence/integration and public deployment are separate work.
