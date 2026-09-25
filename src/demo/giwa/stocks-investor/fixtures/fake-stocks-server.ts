// EXPLICIT TEST / VERIFICATION FIXTURE — never imported by the feature itself.
//
// An in-memory stand-in for the GIWA Stocks HTTP API that follows the server code at this commit
// (plugin routes, envelope vs top-level catalog, BUY/SELL row differences, quote rounding,
// single-use quotes, actor-bound idempotency, sell reservations, portfolio projection). It lets
// the real HTTP client and validators run without a server, and adds controls to hold, drop or
// corrupt answers so late-response, lost-response and invalid-DTO behaviour can be exercised.
// It holds no secret: fixture tokens are unsigned JWT-shaped strings that only this fake accepts.

type Json = Record<string, unknown>
type Route = "catalog" | "quote" | "sell-quote" | "order" | "sell-order" | "orders" | "sell-orders" | "order-detail" | "sell-order-detail" | "portfolio"

const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" }
const QUANTITY = /^(0|[1-9]\d*)(\.\d+)?$/

export type FakeCatalogMode = "registered" | "not-registered" | "not-activated" | "invalid" | "direct"

/** The contracts the "direct" catalog publishes (platform tUSDC; the rest are fixture addresses). */
export const DIRECT_CONTRACTS = Object.freeze({
  cashToken: "0x869d9c8d9bf0a961fc2fd3bba300fdbeee3c2633",
  fundingVault: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  stockToken: "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  redemptionEscrow: "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
} as const)

type Held = { route: Route; release: () => void }

type OrderRow = Json & { id: string; actorId: string; wallet: string; state: string; version: number; quantity: string; cashAmount: string; side?: "SELL" }

export type FakeStocksServerOptions = {
  deploymentId?: string
  /** Wall-clock milliseconds used for timestamps and quote expiry. */
  wallClock?: () => number
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodePayload(token: string): Json | null {
  try {
    const segment = token.split(".")[1] ?? ""
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=")
    const binary = atob(padded)
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))) as Json
  } catch {
    return null
  }
}

function hex64(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`
}

export function createFakeStocksServer(options: FakeStocksServerOptions = {}) {
  let wallClock = options.wallClock ?? (() => Date.now())
  let offsetMs = 0
  const nowMs = () => wallClock() + offsetMs
  const iso = (ms: number) => new Date(ms).toISOString()
  let deploymentId = options.deploymentId ?? "fixture-stocks-deployment-a"
  let catalogMode: FakeCatalogMode = "registered"
  let paused = false
  let sequence = 0
  const next = (prefix: string) => `${prefix}-${String(++sequence).padStart(4, "0")}`
  const tokens = new Set<string>()
  const quotes = new Map<string, Json & { side?: "SELL"; used: boolean }>()
  const orders: OrderRow[] = []
  const holdings = new Map<string, { wallet: bigint; escrow: bigint }>()
  const requests: { method: string; path: string; authorization: string | null; body: unknown }[] = []
  const held: Held[] = []
  let holdRoutes: Route[] = []
  const dropRoutes: Route[] = []
  const failures = new Map<Route, { status: number; body: unknown }[]>()
  const corruptions = new Map<Route, ((body: Json) => unknown)[]>()
  let ignoreAbort = false

  function reservedFor(wallet: string): bigint {
    return orders.filter((order) => order.side === "SELL" && order.wallet === wallet && order.state === "AWAITING_ESCROW").reduce((sum, order) => sum + BigInt(order.quantity), 0n)
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }

  const refuse = (code: string, status = 400) => json(status, { error: code, ...PROFILE })
  const envelope = (data: unknown) => json(200, { ...PROFILE, observedAt: iso(nowMs()), data })

  function actorOf(authorization: string | null): { actorId: string; wallet: string } | null {
    if (!authorization?.startsWith("Bearer ")) return null
    const token = authorization.slice(7)
    if (!tokens.has(token)) return null
    const payload = decodePayload(token)
    if (payload === null || typeof payload.sub !== "string" || payload.chainId !== 91342) return null
    return { actorId: `evm:${payload.sub}`, wallet: payload.sub }
  }

  function exactKeys(body: unknown, keys: string[]): Json | null {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null
    const row = body as Json
    return Object.keys(row).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(row, key)) ? row : null
  }

  function units(value: unknown, scale: number): bigint | string {
    if (typeof value !== "string" || !QUANTITY.test(value) || value.length > 80) return "INVALID_DECIMAL"
    const [whole, fraction = ""] = value.split(".")
    if (fraction.length > scale) return "EXCESS_PRECISION"
    const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0")
    if (result <= 0n || result > 10n ** 30n) return "AMOUNT_BOUNDS"
    return result
  }

  function handle(method: string, path: string, authorization: string | null, body: unknown): { route: Route; response: Response } {
    if (catalogMode === "not-registered") {
      return { route: routeOf(method, path), response: json(404, { message: `Route ${method}:${path} not found`, error: "Not Found", statusCode: 404 }) }
    }
    if (method === "GET" && path === "/api/v1/stocks/catalog") {
      if (catalogMode === "invalid") return { route: "catalog", response: json(200, { ...PROFILE, instruments: [{ symbol: "NVDA", quantityScale: 9, price: 120, priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER" }], cashSymbol: "ARCO_TEST_USDC", deploymentId, observedAt: iso(nowMs()) }) }
      if (catalogMode === "direct") {
        return {
          route: "catalog",
          response: json(200, {
            ...PROFILE,
            instruments: [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER", tokenAddress: DIRECT_CONTRACTS.stockToken }],
            contracts: DIRECT_CONTRACTS,
            cashSymbol: "tUSDC",
            deploymentId,
            observedAt: iso(nowMs()),
          }),
        }
      }
      return {
        route: "catalog",
        response: json(200, {
          ...PROFILE,
          instruments: [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: catalogMode === "not-activated" ? "NOT_ACTIVATED" : "CHECK_PAUSE_AT_ORDER" }],
          cashSymbol: "ARCO_TEST_USDC",
          deploymentId,
          observedAt: iso(nowMs()),
        }),
      }
    }
    const route = routeOf(method, path)
    const actor = actorOf(authorization)
    if (actor === null) return { route, response: refuse("UNAUTHORIZED", 401) }
    const ready = () => (catalogMode === "not-activated" ? refuse("STOCKS_NOT_ACTIVATED", 503) : paused ? refuse("STOCKS_PAUSED", 503) : null)

    if (method === "POST" && (route === "quote" || route === "sell-quote")) {
      // A Buy may be quoted for an exact cash amount: the quantity it buys at the fixture's price, rounded down.
      const byCash = route === "quote" && body !== null && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "cashAmount")
      const row = exactKeys(body, ["symbol", byCash ? "cashAmount" : "quantity"])
      if (row === null) return { route, response: refuse("UNEXPECTED_FIELDS") }
      if (typeof row.symbol !== "string") return { route, response: refuse("INVALID_SYMBOL") }
      const blocked = ready()
      if (blocked) return { route, response: blocked }
      if (row.symbol !== "NVDA") return { route, response: refuse("UNSUPPORTED_SYMBOL") }
      const paid = byCash ? units(row.cashAmount, 6) : null
      if (typeof paid === "string") return { route, response: refuse(paid) }
      const quantity = paid !== null ? (paid * 1000000000n) / 120000000n : units(row.quantity, 9)
      if (typeof quantity === "string") return { route, response: refuse(quantity) }
      if (quantity <= 0n) return { route, response: refuse("QUOTE_TOO_SMALL") }
      const cash = paid !== null ? paid : route === "quote" ? (quantity * 120000000n + 999999999n) / 1000000000n : (quantity * 120000000n) / 1000000000n
      if (cash <= 0n) return { route, response: refuse("ZERO_SELL_PAYOUT") }
      const created = nowMs()
      const quote = {
        id: next(route === "quote" ? "fixture-quote" : "fixture-sell-quote"),
        actorId: actor.actorId,
        wallet: actor.wallet,
        symbol: "NVDA",
        quantity: quantity.toString(),
        cashAmount: cash.toString(),
        deploymentDigest: `digest-${deploymentId}`,
        expiresAt: iso(created + 60_000),
        createdAt: iso(created),
        ...(route === "sell-quote" ? { side: "SELL" as const } : {}),
      }
      quotes.set(quote.id, { ...quote, used: false })
      return { route, response: envelope(quote) }
    }

    if (method === "POST" && (route === "order" || route === "sell-order")) {
      const row = exactKeys(body, ["quoteId", "idempotencyKey"])
      if (row === null) return { route, response: refuse("UNEXPECTED_FIELDS") }
      if (typeof row.quoteId !== "string" || typeof row.idempotencyKey !== "string") return { route, response: refuse("INVALID_ORDER_REQUEST") }
      const blocked = ready()
      if (blocked) return { route, response: blocked }
      if (row.quoteId.length > 128 || !/^[a-zA-Z0-9:_-]{8,128}$/.test(row.idempotencyKey)) return { route, response: refuse("INVALID_ORDER_REQUEST") }
      const sell = route === "sell-order"
      const existing = orders.find((order) => order.actorId === actor.actorId && order.idempotencyKey === row.idempotencyKey && (order.side === "SELL") === sell)
      if (existing) {
        if (existing.quoteId !== row.quoteId) return { route, response: refuse("IDEMPOTENCY_CONFLICT", 409) }
        return { route, response: envelope(existing) }
      }
      const quote = quotes.get(row.quoteId)
      if (!quote || quote.actorId !== actor.actorId || (quote.side === "SELL") !== sell) return { route, response: refuse("QUOTE_NOT_FOUND", 404) }
      if (Date.parse(String(quote.expiresAt)) <= nowMs() || quote.deploymentDigest !== `digest-${deploymentId}`) return { route, response: refuse("QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED", 409) }
      if (quote.used) return { route, response: refuse("QUOTE_ALREADY_USED", 409) }
      if (sell) {
        const position = holdings.get(actor.wallet) ?? { wallet: 0n, escrow: 0n }
        if (position.wallet - reservedFor(actor.wallet) < BigInt(String(quote.quantity))) return { route, response: refuse("INSUFFICIENT_AVAILABLE_STOCK", 409) }
      }
      quote.used = true
      const created = iso(nowMs())
      const order: OrderRow = {
        id: next(sell ? "fixture-sell-order" : "fixture-order"),
        orderKey: hex64(sequence),
        quoteId: String(quote.id),
        actorId: actor.actorId,
        wallet: actor.wallet,
        symbol: "NVDA",
        quantity: String(quote.quantity),
        cashAmount: String(quote.cashAmount),
        idempotencyKey: row.idempotencyKey,
        deploymentId,
        deploymentDigest: `digest-${deploymentId}`,
        quoteExpiresAt: String(quote.expiresAt),
        state: sell ? "AWAITING_ESCROW" : "AWAITING_FUNDING",
        version: 0,
        createdAt: created,
        updatedAt: created,
        ...(sell ? { side: "SELL" as const } : {}),
      }
      orders.push(order)
      return { route, response: envelope(order) }
    }

    if (method === "GET" && (route === "orders" || route === "sell-orders")) {
      const sell = route === "sell-orders"
      return { route, response: envelope(orders.filter((order) => order.actorId === actor.actorId && (order.side === "SELL") === sell).slice().reverse().slice(0, 100)) }
    }

    if (method === "GET" && (route === "order-detail" || route === "sell-order-detail")) {
      const sell = route === "sell-order-detail"
      const id = decodeURIComponent(path.split("/").pop() ?? "")
      const order = orders.find((row) => row.id === id && row.actorId === actor.actorId && (row.side === "SELL") === sell)
      return { route, response: order ? envelope(order) : refuse("ORDER_NOT_FOUND", 404) }
    }

    if (method === "GET" && route === "portfolio") {
      const position = holdings.get(actor.wallet)
      const hasSell = orders.some((order) => order.actorId === actor.actorId && order.side === "SELL")
      const rows = position || hasSell ? [position ?? { wallet: 0n, escrow: 0n }] : []
      const reserved = reservedFor(actor.wallet)
      return {
        route,
        response: envelope({
          holdings: rows.map((row) => ({
            wallet: actor.wallet,
            symbol: "NVDA",
            walletQuantity: row.wallet.toString(),
            escrowedQuantity: row.escrow.toString(),
            reservedQuantity: reserved.toString(),
            availableQuantity: (row.wallet - reserved).toString(),
            quantity: (row.wallet + row.escrow).toString(),
          })),
          pending: orders
            .filter((order) => order.actorId === actor.actorId && !["COMPLETED", "REFUNDED", "RETURNED", "EXPIRED"].includes(order.state))
            .map((order) => ({ id: order.id, state: order.state, quantity: order.quantity, cashAmount: order.cashAmount, side: order.side ?? "BUY" })),
          projectionPolicy: "FINALIZED_RESTRICTED_TRANSFER_MOVEMENTS",
        }),
      }
    }
    return { route, response: json(404, { message: `Route ${method}:${path} not found`, error: "Not Found", statusCode: 404 }) }
  }

  function routeOf(method: string, path: string): Route {
    if (path === "/api/v1/stocks/catalog") return "catalog"
    if (path === "/api/v1/stocks/quotes") return "quote"
    if (path === "/api/v1/stocks/sell-quotes") return "sell-quote"
    if (path === "/api/v1/stocks/portfolio") return "portfolio"
    if (path === "/api/v1/stocks/orders") return method === "POST" ? "order" : "orders"
    if (path === "/api/v1/stocks/sell-orders") return method === "POST" ? "sell-order" : "sell-orders"
    if (path.startsWith("/api/v1/stocks/sell-orders/")) return "sell-order-detail"
    return "order-detail"
  }

  async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input)
    const method = (init.method ?? "GET").toUpperCase()
    const headers = new Headers(init.headers)
    const authorization = headers.get("authorization")
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined
    requests.push({ method, path: url.pathname, authorization, body })
    const signal = init.signal ?? null
    if (signal?.aborted && !ignoreAbort) throw new DOMException("Aborted", "AbortError")
    const route = routeOf(method, url.pathname)
    const failure = failures.get(route)?.shift()
    let outcome: Response
    if (failure) outcome = json(failure.status, failure.body)
    else {
      // The request is applied now, at arrival, exactly like the server would.
      const { response } = handle(method, url.pathname, authorization, body)
      const corrupt = corruptions.get(route)?.shift()
      outcome = corrupt ? json(response.status, corrupt((await response.json()) as Json)) : response
    }
    const dropIndex = dropRoutes.indexOf(route)
    if (dropIndex !== -1) {
      dropRoutes.splice(dropIndex, 1)
      throw new TypeError("fixture: response lost after the request was applied")
    }
    const holdIndex = holdRoutes.indexOf(route)
    if (holdIndex !== -1) {
      holdRoutes = holdRoutes.filter((_, index) => index !== holdIndex)
      await new Promise<void>((resolve, reject) => {
        held.push({ route, release: resolve })
        if (signal && !ignoreAbort) signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      })
    }
    return outcome
  }

  const controls = {
    requests,
    issueToken(wallet: string): string {
      const token = `${base64url(JSON.stringify({ alg: "none", typ: "FIXTURE" }))}.${base64url(JSON.stringify({ sub: wallet.toLowerCase(), chainId: 91342, domain: "fixture.invalid", n: ++sequence }))}.fixture`
      tokens.add(token)
      return token
    },
    revokeToken(token: string) {
      tokens.delete(token)
    },
    setCatalogMode(mode: FakeCatalogMode) {
      catalogMode = mode
    },
    setPaused(value: boolean) {
      paused = value
    },
    setDeploymentId(value: string) {
      deploymentId = value
    },
    advanceTime(ms: number) {
      offsetMs += ms
    },
    setWallClock(clock: () => number) {
      wallClock = clock
    },
    /** The next answer on `route` is computed at arrival but delivered only when released. */
    holdNext(route: Route) {
      holdRoutes.push(route)
    },
    releaseHeld(route?: Route) {
      for (let index = 0; index < held.length; ) {
        if (route === undefined || held[index].route === route) held.splice(index, 1)[0].release()
        else index += 1
      }
    },
    heldCount: () => held.length,
    /** Apply the next request on `route`, then lose its answer. */
    dropNext(route: Route) {
      dropRoutes.push(route)
    },
    failNext(route: Route, status: number, body: unknown) {
      failures.set(route, [...(failures.get(route) ?? []), { status, body }])
    },
    corruptNext(route: Route, mutate: (body: Json) => unknown) {
      corruptions.set(route, [...(corruptions.get(route) ?? []), mutate])
    },
    /** Deliver held answers even if their request was aborted (a transport that ignores abort). */
    setIgnoreAbort(value: boolean) {
      ignoreAbort = value
    },
    setHolding(wallet: string, walletUnits: string, escrowUnits = "0") {
      holdings.set(wallet.toLowerCase(), { wallet: BigInt(walletUnits), escrow: BigInt(escrowUnits) })
    },
    advanceOrder(orderId: string, state: string) {
      const order = orders.find((row) => row.id === orderId)
      if (!order) throw new Error("fixture: unknown order")
      order.state = state
      order.version += 1
      order.updatedAt = iso(nowMs())
    },
    orders: () => orders.map((order) => ({ ...order })),
  }

  return { fetch, controls }
}

export type FakeStocksServer = ReturnType<typeof createFakeStocksServer>
