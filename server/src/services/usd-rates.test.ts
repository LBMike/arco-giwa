import assert from "node:assert/strict"
import test from "node:test"
import {
  COINGECKO_URL,
  KRAKEN_URL,
  baseUsd,
  createUsdRatesFetcher,
  ounceQuote,
  ounceUsd,
  parseKraken,
  type UsdRatesOptions,
} from "./usd-rates.js"

type Reply = { status: number; body?: unknown } | Error | "hang"

const CG_OK = { bitcoin: { usd: 90_000 }, ethereum: { usd: 3_000 }, ripple: { usd: 2.5 }, "pax-gold": { usd: 2_400 } }
// Kraken's real shape: its own pair names, prices as strings, c[0] = last trade.
const KRAKEN_OK = {
  error: [],
  result: {
    XXBTZUSD: { a: ["90010.0", "1", "1.000"], c: ["90005.1", "0.01"] },
    XETHZUSD: { c: ["3001.5", "1"] },
    XXRPZUSD: { c: ["2.51", "100"] },
    PAXGUSD: { c: ["2405.25", "0.1"] },
  },
}

function harness(replies: { coingecko?: Reply[]; kraken?: Reply[] }, options: Partial<UsdRatesOptions> = {}) {
  let clock = 1_000_000
  const calls: string[] = []
  const warnings: Record<string, unknown>[] = []
  const queues = { coingecko: [...(replies.coingecko ?? [])], kraken: [...(replies.kraken ?? [])] }
  const fetcher = createUsdRatesFetcher({
    now: () => clock,
    logger: { warn: (message) => warnings.push(JSON.parse(message)) },
    fetch: (url, init) => {
      const source = url === COINGECKO_URL ? "coingecko" : url === KRAKEN_URL ? "kraken" : null
      assert.ok(source, `unexpected url ${url}`)
      assert.ok(init.signal instanceof AbortSignal, "every upstream call carries a timeout signal")
      calls.push(source)
      const reply = queues[source].shift()
      assert.ok(reply !== undefined, `no scripted reply left for ${source}`)
      if (reply instanceof Error) return Promise.reject(reply)
      if (reply === "hang")
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
      return Promise.resolve({ ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body })
    },
    ...options,
  })
  return { fetcher, calls, warnings, advance: (ms: number) => (clock += ms) }
}

test("CoinGecko ok: its prices are served, Kraken is not called, the success is cached for the TTL", async () => {
  const h = harness({ coingecko: [{ status: 200, body: CG_OK }, { status: 200, body: CG_OK }] })
  const rates = await h.fetcher()
  assert.deepEqual(
    [rates!.USDC, rates!.BTC, rates!.ETH, rates!.XRP, rates!.XAU],
    [1, 90_000, 3_000, 2.5, 2_400],
  )
  assert.deepEqual(rates!.sources, { BTC: "coingecko", ETH: "coingecko", XRP: "coingecko", XAU: "coingecko" })
  assert.deepEqual(ounceQuote(rates), { usd: 2_400, source: "coingecko:pax-gold" })
  h.advance(119_000)
  await h.fetcher()
  assert.deepEqual(h.calls, ["coingecko"])
  h.advance(2_000)
  await h.fetcher()
  assert.deepEqual(h.calls, ["coingecko", "coingecko"])
  assert.equal(h.warnings.length, 0)
})

test("CoinGecko 429: Kraken's ticker is used and the failure is logged with source and status", async () => {
  const h = harness({ coingecko: [{ status: 429 }], kraken: [{ status: 200, body: KRAKEN_OK }] })
  const rates = await h.fetcher()
  assert.deepEqual([rates!.BTC, rates!.ETH, rates!.XRP, rates!.XAU], [90_005.1, 3_001.5, 2.51, 2_405.25])
  assert.deepEqual(rates!.sources, { BTC: "kraken", ETH: "kraken", XRP: "kraken", XAU: "kraken" })
  assert.deepEqual(ounceQuote(rates), { usd: 2_405.25, source: "kraken:paxg" })
  assert.equal(baseUsd("tBTC", rates), 90_005.1)
  assert.deepEqual(h.calls, ["coingecko", "kraken"])
  assert.equal(h.warnings.length, 1)
  assert.equal(h.warnings[0].source, "coingecko")
  assert.equal(h.warnings[0].status, 429)
  assert.equal(h.warnings[0].usdRates, "upstream-failed")
})

test("both fail with a warm cache: the last good rates are served, within the staleness limit", async () => {
  const h = harness({
    coingecko: [{ status: 200, body: CG_OK }, { status: 503 }],
    kraken: [new TypeError("fetch failed")],
  })
  await h.fetcher()
  h.advance(121_000)
  const rates = await h.fetcher()
  assert.deepEqual([rates!.BTC, rates!.XAU], [90_000, 2_400])
  assert.deepEqual(h.calls, ["coingecko", "coingecko", "kraken"])
  assert.deepEqual(
    h.warnings.map((w) => [w.source, w.status ?? w.error]),
    [
      ["coingecko", 503],
      ["kraken", "TypeError"],
    ],
  )
})

test("both fail past the staleness limit: null (never an old number dressed as current)", async () => {
  const h = harness({
    coingecko: [{ status: 200, body: CG_OK }, ...Array.from({ length: 20 }, () => ({ status: 429 }))],
    kraken: Array.from({ length: 20 }, () => ({ status: 500 })),
  })
  assert.ok(await h.fetcher())
  h.advance(14 * 60_000)
  assert.equal((await h.fetcher())!.BTC, 90_000)
  h.advance(2 * 60_000)
  const rates = await h.fetcher()
  assert.equal(rates, null)
  assert.equal(baseUsd("tBTC", rates), null)
  assert.equal(ounceUsd(rates), null)
  assert.equal(baseUsd("tUSDC", rates), 1)
})

test("cold start with both down: null", async () => {
  const h = harness({ coingecko: [{ status: 429 }], kraken: [{ status: 520 }] })
  assert.equal(await h.fetcher(), null)
  assert.equal(h.warnings.length, 2)
})

test("partial data is merged per asset: what CoinGecko lacks comes from Kraken", async () => {
  const h = harness({
    coingecko: [{ status: 200, body: { bitcoin: { usd: 90_000 }, ethereum: { usd: 3_000 } } }],
    kraken: [{ status: 200, body: KRAKEN_OK }],
  })
  const rates = await h.fetcher()
  assert.deepEqual([rates!.BTC, rates!.ETH, rates!.XRP, rates!.XAU], [90_000, 3_000, 2.51, 2_405.25])
  assert.deepEqual(rates!.sources, { BTC: "coingecko", ETH: "coingecko", XRP: "kraken", XAU: "kraken" })
  assert.equal(h.warnings.length, 0)
})

test("a value missing from both sources stays unavailable (NaN -> null), the rest are served", async () => {
  const h = harness({
    coingecko: [{ status: 200, body: { bitcoin: { usd: 90_000 }, ethereum: { usd: 3_000 }, ripple: { usd: 2.5 } } }],
    kraken: [{ status: 200, body: { error: [], result: { XXBTZUSD: { c: ["90005.1"] } } } }],
  })
  const rates = await h.fetcher()
  assert.ok(Number.isNaN(rates!.XAU))
  assert.equal(ounceUsd(rates), null)
  assert.equal(ounceQuote(rates), null)
  assert.equal(baseUsd("tXRP", rates), 2.5)
})

test("invalid values are rejected: zero, negative, NaN strings, non-numbers", async () => {
  const h = harness({
    coingecko: [
      {
        status: 200,
        body: { bitcoin: { usd: 0 }, ethereum: { usd: -5 }, ripple: { usd: "2.5" }, "pax-gold": { usd: null } },
      },
    ],
    kraken: [
      {
        status: 200,
        body: {
          error: [],
          result: { XXBTZUSD: { c: ["0"] }, XETHZUSD: { c: ["abc"] }, XXRPZUSD: { c: [2.5] }, PAXGUSD: { c: ["-1"] } },
        },
      },
    ],
  })
  assert.equal(await h.fetcher(), null)
  assert.deepEqual(
    h.warnings.map((w) => [w.source, w.error]),
    [
      ["coingecko", "no-valid-prices"],
      ["kraken", "no-valid-prices"],
    ],
  )
})

test("Kraken parsing matches pair names defensively and honours its error array", () => {
  assert.deepEqual(
    parseKraken({
      error: [],
      result: { XBTUSD: { c: ["1"] }, ETHUSDT: { c: ["9"] }, ETHUSD: { c: ["2"] }, XRPUSD: { c: ["3"] }, XPAXGZUSD: { c: ["4"] } },
    }),
    { BTC: 1, ETH: 2, XRP: 3, XAU: 4 },
  )
  assert.deepEqual(parseKraken({ error: ["EQuery:Unknown asset pair"], result: { XXBTZUSD: { c: ["1"] } } }), {})
  assert.deepEqual(parseKraken(null), {})
  assert.deepEqual(parseKraken({ result: { ETH2USD: { c: ["5"] }, XETHZEUR: { c: ["5"] } } }), {})
})

test("backoff: a failed source is not retried inside its window, and is logged once per window", async () => {
  const h = harness(
    {
      coingecko: [{ status: 429 }, { status: 429 }, { status: 200, body: CG_OK }],
      kraken: [{ status: 500 }, { status: 200, body: KRAKEN_OK }],
    },
    { backoffMs: 60_000 },
  )
  assert.equal(await h.fetcher(), null)
  assert.deepEqual(h.calls, ["coingecko", "kraken"])
  for (let i = 0; i < 5; i++) {
    h.advance(10_000)
    await h.fetcher()
  }
  assert.deepEqual(h.calls, ["coingecko", "kraken"], "no refetch inside the backoff window")
  assert.equal(h.warnings.length, 2)
  h.advance(10_001) // 60s since the failure
  const rates = await h.fetcher()
  assert.deepEqual(h.calls, ["coingecko", "kraken", "coingecko", "kraken"])
  assert.equal(rates!.sources!.BTC, "kraken")
  assert.equal(h.warnings.length, 3)
  // CoinGecko is still backing off after the success via Kraken; the round is cached for the TTL.
  h.advance(119_000)
  await h.fetcher()
  assert.equal(h.calls.length, 4)
  h.advance(2_000)
  assert.equal((await h.fetcher())!.sources!.BTC, "coingecko")
  assert.deepEqual(h.calls, ["coingecko", "kraken", "coingecko", "kraken", "coingecko"])
})

test("concurrent callers share one upstream round", async () => {
  const h = harness({ coingecko: [{ status: 200, body: CG_OK }] })
  const all = await Promise.all([h.fetcher(), h.fetcher(), h.fetcher()])
  assert.ok(all.every((r) => r?.BTC === 90_000))
  assert.deepEqual(h.calls, ["coingecko"])
})

test("timeout: a hanging upstream is aborted and the fallback answers", async () => {
  const h = harness({ coingecko: ["hang"], kraken: [{ status: 200, body: KRAKEN_OK }] }, { timeoutMs: 20 })
  // AbortSignal.timeout's timer is unref'd (the live server keeps the loop alive); hold the loop open here.
  const keepAlive = setTimeout(() => {}, 5_000)
  const rates = await h.fetcher().finally(() => clearTimeout(keepAlive))
  assert.equal(rates!.XAU, 2_405.25)
  assert.equal(h.warnings[0].source, "coingecko")
  assert.equal(h.warnings[0].error, "TimeoutError")
})

test("no logger: failures stay silent and the fetcher still works", async () => {
  const fetcher = createUsdRatesFetcher({ fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) })
  assert.equal(await fetcher(), null)
})
