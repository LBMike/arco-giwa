import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { formatElapsed, TransactionFlowCard, TransactionFlowModal, type FlowStep, type TransactionFlowProps } from "./TransactionFlowModal"

const noop = () => undefined
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()

const approve: FlowStep = {
  id: "approve",
  label: "Approve USDC",
  walletLabel: "Approve USDC in your wallet",
  processingLabel: "Approving USDC…",
  help: { question: "Why do I have to approve?", answer: "Approving lets this fund take USDC from your wallet. You only do this once." },
  state: "wallet",
}
const confirm: FlowStep = {
  id: "submit",
  label: "Confirm investment",
  walletLabel: "Confirm investment in your wallet",
  processingLabel: "Investment pending…",
  hint: "Waiting for GIWA to confirm your transaction.",
  state: "upcoming",
}
const base: TransactionFlowProps = {
  title: "Review investment",
  pay: { caption: "You pay", amount: "1,000", symbol: "USDC", sub: "~$1000.00" },
  receive: { caption: "You receive", amount: "9.87", symbol: "aCAPIX" },
  steps: [approve, confirm],
  result: null,
  error: null,
  onClose: noop,
}
const card = (patch: Partial<TransactionFlowProps> = {}) => renderToStaticMarkup(<TransactionFlowCard {...base} {...patch} />)

test("the running flow: amounts, then each step in the words of its state", () => {
  const html = card()
  assert.match(text(html), /^Review investment You pay 1,000 USDC ~\$1000\.00 You receive 9\.87 aCAPIX Approve USDC in your wallet Why do I have to approve\? .* Confirm investment Approve USDC in your wallet$/)
  assert.match(html, /aria-label="Close"/)
  assert.match(html, /<li[^>]*aria-current="step"[^>]*data-step="approve"[^>]*data-state="wallet"/, "the active step is marked")
  assert.doesNotMatch(html, /data-step="submit"[^>]*aria-current/)
  assert.match(html, /<details[^>]*><summary[^>]*>Why do I have to approve\?<\/summary>/, "the why is collapsed under the wallet step")
  assert.doesNotMatch(html, /Waiting for GIWA/, "a hint shows only under the active step")
  assert.match(html, /data-outcome="running"/)

  const pending = card({ steps: [{ ...approve, state: "done" }, { ...confirm, state: "processing" }] })
  assert.match(text(pending), /Approve USDC Done Investment pending… Waiting for GIWA to confirm your transaction\. Investment pending…$/, "done steps say so; the live region says the current step")
  assert.doesNotMatch(pending, /Why do I have to approve/, "the why goes once the wallet step is done")
  assert.match(pending, /animate-spin/)
})

test("a failed step: its reason, Try again (when given) and Close", () => {
  const failed = card({ steps: [{ ...approve, state: "failed" }, confirm], error: "User rejected the request.", onRetry: noop })
  assert.match(failed, /role="alert"[^>]*>.*User rejected the request\./)
  assert.match(text(failed), /Approve USDC Failed Confirm investment User rejected the request\. Try again Close\s*$/)
  assert.match(failed, /data-outcome="failed"/)
  assert.doesNotMatch(card({ error: "Nope" }), />Try again</, "no retry offered without onRetry")
})

test("the result screen: check, what went in and came out, the product's line, the explorer and Done", () => {
  const html = card({
    result: {
      tone: "success",
      title: "Investment successful!",
      from: { amount: "1,000", symbol: "USDC" },
      to: { amount: "9.8765", symbol: "aCAPIX" },
      message: "You now hold 9.8765 aCAPIX in Aksia CAPIX.",
      explorerHref: "https://sepolia-explorer.giwa.io/tx/0xabc",
    },
  })
  assert.equal(
    text(html),
    "Review investment Investment successful! 1,000 USDC to 9.8765 aCAPIX You now hold 9.8765 aCAPIX in Aksia CAPIX. View on GIWA explorer Done Investment successful! You now hold 9.8765 aCAPIX in Aksia CAPIX.",
  )
  assert.match(html, /<a href="https:\/\/sepolia-explorer\.giwa\.io\/tx\/0xabc" target="_blank" rel="noreferrer"/)
  assert.match(html, /data-outcome="success"/)
  assert.doesNotMatch(html, /You pay|Transaction steps/, "the steps give way to the result")
  const held = card({ result: { tone: "held", title: "Purchase held for review", message: "Trading was paused.", from: null, to: null } })
  assert.match(held, /data-outcome="held"/)
  assert.doesNotMatch(text(held), / to /, "no summary line without both sides")
  assert.match(text(card({ result: { tone: "pending", title: "Redemption requested", message: "Later." }, doneLabel: "Close" })), /Later\. Close /)
})

test("a slow flow shows its note and action; the modal renders nothing on the server", () => {
  assert.match(text(card({ note: { message: "Settlement is taking longer than usual.", action: { label: "Check again", onClick: noop } } })), /Settlement is taking longer than usual\. Check again/)
  assert.equal(renderToStaticMarkup(<TransactionFlowModal {...base} open />), "")
  assert.equal(formatElapsed(0), "00:00")
  assert.equal(formatElapsed(14.9), "00:14")
  assert.equal(formatElapsed(65), "01:05")
  assert.equal(formatElapsed(-3), "00:00")
})
