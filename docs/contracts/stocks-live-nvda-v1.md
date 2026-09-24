# NVDA live display contract (v1)

This contract gives the Stocks UI one read-only view of the NVDA pilot. It does
not change the order, pricing, custody, or settlement services. The underlying
security, the ARCO token, and the fixed testnet order price are separate values.

## Endpoints

- `GET /api/v1/stocks/market/NVDA/live` returns one JSON snapshot. It accepts no
  query parameters.
- `GET /api/v1/stocks/market/NVDA/live/stream` returns Server-Sent Events. Each
  event has `event: snapshot` and the same JSON object on the `data:` line.
  A `: keepalive` comment may appear between events. The connection is limited
  to 64 subscribers per server process; excess connections receive HTTP 503.
- Both endpoints are public, read-only, and return `Cache-Control: no-store`.
  Neither endpoint accepts user-provided symbols, credentials, or order data.

The JSON shape is:

```json
{
  "schemaVersion": 1,
  "symbol": "NVDA",
  "observedAt": "2026-09-24T18:00:00.000Z",
  "underlying": {
    "basis": "UNDERLYING_SECURITY",
    "currency": "USD",
    "price": "125.25",
    "change": "5.25",
    "changePercent": "4.375",
    "sessionVolume": "1000",
    "previousClose": "120",
    "observationAgeMs": 30000,
    "status": "AVAILABLE",
    "reason": null,
    "sourceTimestamp": "2026-09-24T17:59:30.000Z",
    "priceSource": "LAST_TRADE",
    "provider": "ALPACA",
    "marketFeed": "IEX",
    "feedDelay": "REALTIME"
  },
  "marketSession": {
    "state": "OPEN",
    "observedAt": "2026-09-24T18:00:00.000Z",
    "nextOpen": "2026-09-25T13:30:00.000Z",
    "nextClose": "2026-09-24T20:00:00.000Z"
  },
  "token": {
    "basis": "ARCO_TOKEN",
    "indicativePrice": null,
    "status": "UNAVAILABLE"
  },
  "testnetExecution": {
    "mode": "FIXED_MOCK_PRICE",
    "status": "CATALOG_ONLY",
    "unitPrice": "120.000000",
    "quoteRequired": true
  }
}
```

All prices are decimal strings. `null` indicates unavailable information; it
must not be rendered as zero. The example numbers are synthetic, not current
prices. `change` and `changePercent` are signed decimal strings relative to
`previousClose`; `sessionVolume` is a decimal string in shares, and
`observationAgeMs` is a nonnegative integer. These five fields come from the
same NVDA market quote as `price` and are `null` when its row is absent.
`observedAt` is when this server assembled the response.
`underlying.sourceTimestamp` is the provider's market observation time and is
the only time to label as the price time. The NVDA row's status takes precedence
over the batch envelope's status. `STALE` can be returned with a retained price;
show its time and stale state rather than calling it a live price. Do not use
`previousClose` as the current session's official closing price.

`marketSession` is read from Alpaca's US-equity clock only when Alpaca credentials
are configured. The clock transport has a 60-second cache. While CLOSED, the
live reader may reuse a validated clock observation for up to five minutes, but
never past its announced next opening. Failed, unavailable, or invalid clock
responses yield `UNKNOWN`, not an inferred market calendar. Session state does
not authorize a token order.

`token.indicativePrice` remains `null` until GIWA has an independently defined
token valuation/market-maker feed. `testnetExecution.unitPrice` comes only from
the existing Stocks order catalog when the full Stocks runtime is present. It
is a fixed mock price, **not** a market token price or an executable quote.
The authenticated buy/sell quote endpoints remain the only way to request a
time-limited order quote; activation and pause checks still occur there. In a
market-data-only preview, `testnetExecution` is `UNAVAILABLE` and its price is
`null`.

## Collection and delivery

The existing market-data service batches the curated symbols in one Alpaca
snapshot request, caches quotes for 15 seconds, and limits upstream requests.
The SSE hub reads the shared service every 60 seconds only while a subscriber
exists, then fans out the same snapshot to all subscribers in that process.
It stops its timer after the last disconnect and closes connections on server
shutdown. The 4392 verification preview uses its own bounded relay because
Fastify's in-process injection buffers an endless SSE response.

While the official market clock reports CLOSED, the live reader reuses its last
underlying observation for at most 15 minutes before another provider read.
A reused observation is marked STALE and retains the original source timestamp.
Its `observationAgeMs` advances with elapsed time even when the provider is
not queried again.
On OPEN or UNKNOWN it returns to normal reads.
This avoids overnight/weekend polling at the open-market rate. Stocks and Home
subscribe to this stream when the live market is enabled. After an OPEN or
UNKNOWN event, they refresh the full quote batch from the server's shared
15-second cache, then overlay this snapshot's NVDA row only when it is at least
as recent as the batch's NVDA observation. During a continuing CLOSED session,
they refresh that batch at most every 15 minutes; a session transition refreshes
it immediately. If the stream fails, the screens
return to their 30-second quote read and retry the stream at a bounded cadence.
Hidden tabs close the stream and reconnect when visible again. Offline fixture
screens keep the legacy quote reader and do not create a live subscription.

This is a process-local design for the current single-instance demo. Before a
multi-instance public deployment, move collection and rate accounting behind
a shared cache/pub-sub and verify the provider's data-display/redistribution
terms. Alpaca's free IEX feed covers one exchange rather than consolidated SIP
data: <https://docs.alpaca.markets/us/docs/market-data-faq>.

## UI integration

Show the underlying price with its source time and OPEN/CLOSED/UNKNOWN state.
On CLOSED, retain the last observation only if the endpoint supplies it and
label its time and stale state, including in the customer preview; do not animate
a new stock price. Keep the token price
unavailable until a real token feed exists. If showing the fixed testnet
price, label it as testnet-only and send users through the authenticated quote
flow before allowing an order. The `Live` listing badge is not a market-open
or per-symbol trading-capability flag.

The next backend stage is a separate token indicative-price and order-quote
service, backed by defined token economics, inventory, risk limits, and real
execution/settlement reconciliation. This display endpoint is not that service.
