// VERIFICATION SCREEN ONLY — MOCK DATA. Not the app: not referenced by index.html, src/main.tsx, the router or the
// Vite config, and never imported by product code.
//
// Renders the REAL KnownHashRecoveryCard for every store state and last-result combination of one side and stage, so the
// KEPT / RECORDED / VERIFIED / BLOCKED guidance can be read and compared at any width. Entries are fixed mock values; the card's
// action button only writes a line in this page. No server, session, wallet, store or request is involved. A kept hash in the
// product appears only after a Stocks session ended while a wallet answer was outstanding (same tab, same wallet); that path
// needs a real server session expiry and is covered by the terminating scripts/stocks-local known-hash-ui case.

import { StrictMode, useRef, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"

import "../../../../index.css"
import "../../../theme.css"
import { UserInteractionContext } from "../../stocks-investor/ui"
import type { RecoveryResult } from "../recover"
import type { KnownHashEntry, KnownHashState } from "../store"
import { KnownHashRecoveryCard } from "../KnownHashRecoveryCard"

type Side = "BUY" | "SELL"
type Stage = "APPROVAL" | "TRANSFER"
type Example = { id: string; label: string; state: KnownHashState; last: RecoveryResult | null; busy?: boolean }

const EXAMPLES: readonly Example[] = [
  { id: "kept", label: "KEPT — before any action", state: { kind: "KEPT" }, last: null },
  { id: "kept-busy", label: "KEPT — request running", state: { kind: "KEPT" }, last: null, busy: true },
  { id: "kept-failed", label: "KEPT + FAILED — the record request's answer did not arrive", state: { kind: "KEPT" }, last: { kind: "FAILED", code: "SUBMISSION_REQUEST_FAILED" } },
  { id: "kept-session", label: "KEPT + session ended during the action", state: { kind: "KEPT" }, last: { kind: "SESSION_REQUIRED" } },
  { id: "recorded", label: "RECORDED — receipt not verified yet", state: { kind: "RECORDED" }, last: { kind: "RECORDED_PENDING" } },
  { id: "recorded-failed", label: "RECORDED + FAILED — the receipt check's answer did not arrive", state: { kind: "RECORDED" }, last: { kind: "FAILED", code: "SUBMISSION_REQUEST_FAILED" } },
  { id: "confirmed", label: "VERIFIED CONFIRMED", state: { kind: "VERIFIED", status: "CONFIRMED" }, last: { kind: "CONFIRMED" } },
  { id: "reverted", label: "VERIFIED REVERTED", state: { kind: "VERIFIED", status: "REVERTED" }, last: { kind: "REVERTED" } },
  { id: "conflict", label: "BLOCKED CONFLICT — the server has another hash", state: { kind: "BLOCKED", reason: "CONFLICT" }, last: { kind: "CONFLICT" } },
  { id: "no-claim", label: "BLOCKED NO_CLAIM", state: { kind: "BLOCKED", reason: "NO_CLAIM" }, last: { kind: "NO_CLAIM" } },
]

function entryFor(side: Side, stage: Stage, example: Example): KnownHashEntry {
  const seed = `${side}${stage}${example.id}`.length.toString(16)
  return Object.freeze({
    claimId: `mock-claim-${side}-${stage}-${example.id}`,
    intentKey: `0x${"4e".repeat(32)}`,
    stage,
    transactionDigest: `0x${"11".repeat(32)}`,
    side,
    orderId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    deploymentDigest: `0x${"5f".repeat(32)}`,
    wallet: "0x1111111111111111111111111111111111111111",
    chainId: 91342,
    apiBase: window.location.origin,
    origin: window.location.origin,
    txHash: `0x${seed.padStart(2, "0").repeat(32)}`,
    capturedAt: 0,
    state: example.state,
    busy: example.busy ?? false,
  })
}

const BUTTON =
  "inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-xs font-medium text-[var(--color-arco-ink)] aria-pressed:border-[var(--color-arco-ink)] aria-pressed:bg-[var(--color-arco-chip)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={BUTTON} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  )
}

function GalleryPage() {
  const [side, setSide] = useState<Side>("BUY")
  const [stage, setStage] = useState<Stage>("APPROVAL")
  const [message, setMessage] = useState("Nothing pressed yet.")
  const interacted = useRef(false)
  return (
    <main
      className="arco-demo mx-auto flex min-h-screen w-full max-w-[var(--container-page)] min-w-0 flex-col gap-6 bg-[var(--color-arco-page)] px-8 py-8 text-[var(--color-arco-ink)]"
      onPointerDownCapture={() => {
        interacted.current = true
      }}
      onKeyDownCapture={() => {
        interacted.current = true
      }}
    >
      <section aria-label="Mock gallery controls" className="w-full min-w-0 rounded-[var(--radius-strategy)] border-2 border-dashed border-[var(--color-arco-ink-40)] bg-[var(--color-arco-surface-muted)] p-4">
        <p className="text-sm font-semibold text-[var(--color-arco-ink)]">Mock data — not the app. The real recovery card with fixed example entries; nothing is sent or recorded</p>
        <div className="mt-3 flex flex-wrap gap-4">
          <div role="group" aria-label="Side" className="flex flex-wrap gap-2">
            <Toggle pressed={side === "BUY"} onClick={() => setSide("BUY")}>BUY</Toggle>
            <Toggle pressed={side === "SELL"} onClick={() => setSide("SELL")}>SELL</Toggle>
          </div>
          <div role="group" aria-label="Stage" className="flex flex-wrap gap-2">
            <Toggle pressed={stage === "APPROVAL"} onClick={() => setStage("APPROVAL")}>APPROVAL</Toggle>
            <Toggle pressed={stage === "TRANSFER"} onClick={() => setStage("TRANSFER")}>TRANSFER ({side === "SELL" ? "escrow" : "deposit"})</Toggle>
          </div>
        </div>
        <p className="mt-3 break-words text-xs text-[var(--color-arco-ink)]" role="status" aria-live="polite" data-testid="verification-message">
          {message}
        </p>
      </section>
      <UserInteractionContext.Provider value={interacted}>
        <ol className="grid w-full min-w-0 gap-6 lg:grid-cols-2">
          {EXAMPLES.map((example) => (
            <li key={`${side}:${stage}:${example.id}`} className="flex min-w-0 flex-col gap-2" data-example={example.id}>
              <p className="font-mono text-xs text-[var(--color-arco-text-soft)]">{example.label}</p>
              <KnownHashRecoveryCard
                entry={entryFor(side, stage, example)}
                lastResult={example.last}
                onRecover={() => setMessage(`${side} ${stage} · ${example.label}: explicit action pressed (mock — nothing was sent or recorded).`)}
              />
            </li>
          ))}
        </ol>
      </UserInteractionContext.Provider>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GalleryPage />
  </StrictMode>,
)
