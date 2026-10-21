// The ArcoUSD v1 provider's "pending" signal: the Savings page waits until both reads have described the contracts
// (live or not deployed). A read that has not landed, failed, or came back "unavailable" keeps it waiting (and the
// queries keep retrying) instead of letting the page open on the vault sArcoUSD replaces.

import assert from "node:assert/strict"
import test from "node:test"
import { useContext } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ArcoUsdLiveContext, ArcoUsdLivePendingContext, ArcoUsdLiveProvider } from "./arcousd-live-context"
import type { SavingsRoute } from "./savings-assets"
import { SavingsRoutesContext } from "./savings-routes"

function Probe() {
  const pending = useContext(ArcoUsdLivePendingContext)
  const live = useContext(ArcoUsdLiveContext)
  return <p>{`pending=${pending} live=${live !== null}`}</p>
}

function render(seed: { reserve?: unknown; savings?: unknown }, options: { enabled?: boolean; routes?: readonly SavingsRoute[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (seed.reserve !== undefined) client.setQueryData(["giwa", "arcousd", "reserve"], seed.reserve)
  if (seed.savings !== undefined) client.setQueryData(["giwa", "arcousd", "savings"], seed.savings)
  const tree = (
    <QueryClientProvider client={client}>
      <ArcoUsdLiveProvider enabled={options.enabled}>
        <Probe />
      </ArcoUsdLiveProvider>
    </QueryClientProvider>
  )
  const html = renderToStaticMarkup(
    options.routes ? <SavingsRoutesContext.Provider value={options.routes}>{tree}</SavingsRoutesContext.Provider> : tree,
  )
  return html.replace(/<[^>]+>/g, "")
}

const NOT_DEPLOYED = { status: "not-deployed" }
const UNAVAILABLE = { status: "unavailable" }

test("pending until both reads describe the contracts; an unavailable or missing read keeps it pending", () => {
  // Nothing landed yet.
  assert.equal(render({}), "pending=true live=false")
  // One read answered, the other not yet.
  assert.equal(render({ reserve: NOT_DEPLOYED }), "pending=true live=false")
  // A first read the server could not make is not an answer: the page keeps waiting rather than open the old vault.
  assert.equal(render({ reserve: NOT_DEPLOYED, savings: UNAVAILABLE }), "pending=true live=false")
  assert.equal(render({ reserve: UNAVAILABLE, savings: NOT_DEPLOYED }), "pending=true live=false")
  // Both answered (not deployed is an answer): the page goes on, without the live account.
  assert.equal(render({ reserve: NOT_DEPLOYED, savings: NOT_DEPLOYED }), "pending=false live=false")
})

test("nothing is pending where nothing is read: the admin console, or a host with its own routes", () => {
  assert.equal(render({}, { enabled: false }), "pending=false live=false")
  const route = { vault: "arcousd", option: "usdt-giwa" } as unknown as SavingsRoute
  assert.equal(render({}, { routes: [route] }), "pending=false live=false")
})

// Polls over time in React DOM (gated like the other DOM tests: GIWA_HOST_DOM_RUNTIME = a jsdom package.json).
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("over time: a later unavailable poll keeps the answer; reads that keep failing are reported, with a retry (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async () => {
  const { createRequire } = await import("node:module")
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    Event: w.Event, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const { giwaApi } = await import("./api")
  const arcousd = giwaApi.arcousd
  try {
    const React = await import("react")
    const { createRoot } = await import("react-dom/client")
    const { ArcoUsdLiveFailedContext } = await import("./arcousd-live-context")
    const settle = () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    let failed: { retry: () => void } | null = null
    function Status() {
      failed = useContext(ArcoUsdLiveFailedContext)
      return <Probe />
    }
    async function mount(answers: { reserve: () => Promise<unknown>; savings: () => Promise<unknown> }) {
      giwaApi.arcousd = { ...arcousd, reserve: answers.reserve, savings: answers.savings } as typeof arcousd
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const element = w.document.createElement("div")
      w.document.body.append(element)
      const root = createRoot(element)
      await React.act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <ArcoUsdLiveProvider>
              <Status />
            </ArcoUsdLiveProvider>
          </QueryClientProvider>,
        ),
      )
      await settle()
      const poll = async () => {
        await React.act(async () => {
          await client.refetchQueries({ queryKey: ["giwa", "arcousd"] })
        })
        await settle()
      }
      return { text: () => element.textContent ?? "", client, poll, close: () => React.act(async () => root.unmount()) }
    }

    // Answered (not deployed), then one poll the server could not make: still answered, nothing pending or failed.
    let savingsAnswer: unknown = NOT_DEPLOYED
    const steady = await mount({ reserve: async () => NOT_DEPLOYED, savings: async () => savingsAnswer })
    assert.equal(steady.text(), "pending=false live=false")
    savingsAnswer = UNAVAILABLE
    for (let i = 0; i < 3; i++) await steady.poll()
    assert.equal(steady.text(), "pending=false live=false")
    assert.equal(failed, null)
    await steady.close()

    // Never answered: pending, and after three answers without a description (unavailable or a failed request) failed.
    let calls = 0
    const down = await mount({ reserve: async () => NOT_DEPLOYED, savings: async () => { calls += 1; throw new Error("down") } })
    assert.equal(down.text(), "pending=true live=false")
    assert.equal(failed, null)
    await down.poll()
    await down.poll()
    assert.equal(down.text(), "pending=true live=false")
    assert.notEqual(failed, null, "reported after three failed answers")
    // Retry asks again; a recovery clears the failure by itself.
    const before = calls
    savingsAnswer = NOT_DEPLOYED
    giwaApi.arcousd = { ...arcousd, reserve: async () => NOT_DEPLOYED, savings: async () => { calls += 1; return savingsAnswer } } as typeof arcousd
    await React.act(async () => failed!.retry())
    await settle()
    assert.ok(calls > before)
    assert.equal(down.text(), "pending=false live=false")
    assert.equal(failed, null)
    await down.close()
  } finally {
    giwaApi.arcousd = arcousd
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    w.close()
  }
})
