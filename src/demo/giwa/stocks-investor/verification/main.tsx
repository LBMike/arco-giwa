// VERIFICATION SCREEN ONLY. Mounts GiwaStocksFeature against the explicit in-memory fixture server
// so the module can be checked in a browser without a Stocks server, a wallet or any signing.
// Nothing here is a fallback for a real connection; the page says so on screen.

import { StrictMode, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"

import "../../../../index.css"
import "../../../theme.css"
import { createGiwaStocksHttpClient } from "../client"
import { createFakeStocksServer, type FakeCatalogMode } from "../fixtures/fake-stocks-server"
import { GiwaStocksFeature } from "../GiwaStocksFeature"
import type { GiwaStocksHostWallet, GiwaStocksSession, HexAddress } from "../types"

const WALLET_A = `0x${"a1".repeat(20)}` as HexAddress
const WALLET_B = `0x${"b2".repeat(20)}` as HexAddress

const params = new URLSearchParams(window.location.search)
const scenario = params.get("scenario") ?? "registered"

const server = createFakeStocksServer()
if (scenario === "not-registered" || scenario === "not-activated" || scenario === "invalid") server.controls.setCatalogMode(scenario as FakeCatalogMode)
if (scenario === "paused") server.controls.setPaused(true)
server.controls.setHolding(WALLET_A, "3000000000", "500000000")
server.controls.setHolding(WALLET_B, "1250000000")
const client = createGiwaStocksHttpClient({ baseUrl: "http://fixture.invalid", fetch: (input, init) => server.fetch(input, init) })

type Identity = "A" | "B" | "signed-out" | "mismatch"

const BUTTON =
  "inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-xs font-medium text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

function VerificationPage() {
  const [identity, setIdentity] = useState<Identity>("signed-out")
  const [tokens, setTokens] = useState(() => ({ A: server.controls.issueToken(WALLET_A), B: server.controls.issueToken(WALLET_B) }))
  const [log, setLog] = useState<string[]>([])
  const note = (line: string) => setLog((current) => [line, ...current].slice(0, 6))

  const session: GiwaStocksSession = useMemo(() => {
    if (identity === "A" || identity === "mismatch") return { status: "verified", walletAddress: WALLET_A, chainId: 91342, token: tokens.A }
    if (identity === "B") return { status: "verified", walletAddress: WALLET_B, chainId: 91342, token: tokens.B }
    return { status: "signed-out" }
  }, [identity, tokens])
  const hostWallet: GiwaStocksHostWallet | null =
    identity === "mismatch" ? { address: WALLET_B, chainId: 91342 } : identity === "A" ? { address: WALLET_A, chainId: 91342 } : identity === "B" ? { address: WALLET_B, chainId: 91342 } : { address: null, chainId: null }

  const latestOrder = () => {
    const orders = server.controls.orders()
    return orders[orders.length - 1]
  }

  return (
    <div className="arco-demo min-h-screen w-full bg-[var(--color-arco-page)]">
      <div className="w-full border-b border-[var(--color-arco-ink)] bg-[var(--color-arco-surface-muted)]" data-testid="verification-controls">
        <div className="mx-auto flex w-full max-w-[var(--container-header)] flex-col gap-2 px-4 py-3 md:px-8">
          <p className="text-xs font-medium text-[var(--color-arco-ink)]">
            Verification fixture · in-memory fake Stocks API · no server, wallet or signing · scenario: <span className="font-mono">{scenario}</span>
          </p>
          <div className="flex flex-wrap gap-2" aria-label="Fixture session">
            {(["A", "B", "signed-out", "mismatch"] as const).map((value) => (
              <button key={value} type="button" className={BUTTON} aria-pressed={identity === value} onClick={() => setIdentity(value)}>
                {value === "A" ? "Session A" : value === "B" ? "Session B" : value === "signed-out" ? "Signed out" : "A token, wallet B connected"}
              </button>
            ))}
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                server.controls.revokeToken(tokens.A)
                note("Revoked session A token (next A request gets 401)")
              }}
            >
              Revoke A token
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setTokens((current) => ({ ...current, A: server.controls.issueToken(WALLET_A) }))
                note("Issued a fresh A token")
              }}
            >
              Re-sign A
            </button>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Fixture responses">
            <button type="button" className={BUTTON} onClick={() => { server.controls.setIgnoreAbort(true); server.controls.holdNext("order"); note("Holding the next order answer (delivered even if aborted)") }}>
              Hold next order answer
            </button>
            <button type="button" className={BUTTON} onClick={() => { server.controls.setIgnoreAbort(true); server.controls.holdNext("portfolio"); note("Holding the next portfolio answer (delivered even if aborted)") }}>
              Hold next portfolio answer
            </button>
            <button type="button" className={BUTTON} onClick={() => { server.controls.releaseHeld(); note("Released held answers") }}>
              Release held
            </button>
            <button type="button" className={BUTTON} onClick={() => { server.controls.dropNext("order"); note("Next order answer will be lost after it is applied") }}>
              Lose next order answer
            </button>
            <button type="button" className={BUTTON} onClick={() => { const order = latestOrder(); if (order) { server.controls.advanceOrder(order.id, order.side === "SELL" ? "SELL_BROKER_UNKNOWN" : "MINT_UNKNOWN"); note(`Advanced ${order.id} to *_UNKNOWN`) } }}>
              Latest order → UNKNOWN
            </button>
            <button type="button" className={BUTTON} onClick={() => { server.controls.advanceTime(61_000); note("Server clock +61 s") }}>
              Server clock +61 s
            </button>
            <button type="button" className={BUTTON} onClick={() => { server.controls.setPaused(true); note("Trading paused (checked before the request key)") }}>
              Pause trading
            </button>
            <button type="button" className={BUTTON} onClick={() => { server.controls.setPaused(false); note("Trading resumed") }}>
              Resume trading
            </button>
          </div>
          {log.length > 0 ? (
            <ol className="text-xs text-[var(--color-arco-text-soft)]" aria-label="Fixture log">
              {log.map((line, index) => (
                <li key={`${index}-${line}`}>{line}</li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
      <main className="mx-auto w-full max-w-[var(--container-header)]">
        <GiwaStocksFeature client={client} session={session} hostWallet={hostWallet} statusPollMs={5_000} />
      </main>
    </div>
  )
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <VerificationPage />
  </StrictMode>,
)
