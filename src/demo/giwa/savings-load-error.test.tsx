// The Savings page while the ArcoUSD v1 reads keep failing: it says so and offers a retry, instead of loading forever
// or opening on the vault the sArcoUSD account replaces. While they are only pending it shows its skeleton.

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { ArcoUsdLiveFailedContext, ArcoUsdLivePendingContext } from "./arcousd-live-context"
import { GIWA_CHAIN_ID } from "./config"
import GiwaSavingsPage from "./SavingsPage"

function render(status: { pending: boolean; failed: { retry: () => void } | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["giwa", "catalog"], [])
  client.setQueryData(["giwa", "market", GIWA_CHAIN_ID], [])
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ArcoUsdLivePendingContext.Provider value={status.pending}>
        <ArcoUsdLiveFailedContext.Provider value={status.failed}>
          <MemoryRouter initialEntries={["/savings"]}>
            <GiwaSavingsPage />
          </MemoryRouter>
        </ArcoUsdLiveFailedContext.Provider>
      </ArcoUsdLivePendingContext.Provider>
    </QueryClientProvider>,
  )
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
}

test("Savings: pending ArcoUSD reads show the skeleton; reads that keep failing say so with Try again", () => {
  const pending = render({ pending: true, failed: null })
  assert.doesNotMatch(pending, /could not be loaded|No savings accounts yet/)
  const failed = render({ pending: true, failed: { retry: () => undefined } })
  assert.match(failed, /Savings could not be loaded/)
  assert.match(failed, /We keep checking\. Try again in a moment\./)
  assert.match(failed, /Try again/)
  assert.doesNotMatch(failed, /No savings accounts yet/)
  // Answered: the page goes on (an empty catalog here).
  assert.match(render({ pending: false, failed: null }), /No savings accounts yet/)
})
