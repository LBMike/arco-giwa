// The trading limits' refusals (SIDE_DISABLED, DAILY_LIMIT_REACHED) as the quote and order flows say them.
import assert from "node:assert/strict"
import test from "node:test"
import type { FeatureError } from "./controller"
import { attemptErrorMessage, errorMessage } from "./display"

const refused = (code: string, status = 409): FeatureError => ({ kind: "REFUSED", status, code })

test("a quote refused by a limit names the side and says nothing was created", () => {
  assert.equal(errorMessage(refused("SIDE_DISABLED"), "BUY"), "Buying NVDA is paused for now. No quote or order was created.")
  assert.equal(errorMessage(refused("SIDE_DISABLED"), "SELL"), "Selling NVDA is paused for now. No quote or order was created.")
  assert.equal(errorMessage(refused("DAILY_LIMIT_REACHED"), "BUY"), "Today's NVDA buy limit has been reached. Try again after 00:00 KST. No quote or order was created.")
  assert.equal(errorMessage(refused("DAILY_LIMIT_REACHED"), "SELL"), "Today's NVDA sell limit has been reached. Try again after 00:00 KST. No quote or order was created.")
  // Without a side (a caller that does not know it) the text stays true.
  assert.equal(errorMessage(refused("SIDE_DISABLED")), "Trading on this side is paused for now. No quote or order was created.")
  assert.equal(errorMessage(refused("DAILY_LIMIT_REACHED")), "Today's NVDA limit has been reached. Try again after 00:00 KST. No quote or order was created.")
  // Other refusals are unchanged.
  assert.equal(errorMessage(refused("STOCKS_PAUSED", 503), "BUY"), "Trading is paused. No quote or order was created.")
})

test("an order refused by a limit: no order for a first send, and no claim about an earlier send whose outcome is unknown", () => {
  assert.equal(attemptErrorMessage(refused("DAILY_LIMIT_REACHED"), false, "BUY"), "Today's NVDA buy limit has been reached. Try again after 00:00 KST. No order was created.")
  assert.equal(attemptErrorMessage(refused("SIDE_DISABLED"), false, "SELL"), "Selling NVDA is paused for now. No order was created.")
  assert.equal(
    attemptErrorMessage(refused("DAILY_LIMIT_REACHED"), true, "BUY"),
    "Today's NVDA buy limit has been reached. Try again after 00:00 KST. This retry was not processed. The earlier request may still have created the order.",
  )
  assert.equal(attemptErrorMessage(refused("STOCKS_PAUSED", 503), false, "BUY"), "Trading is paused. No order was created.")
  assert.equal(attemptErrorMessage({ kind: "NETWORK", status: null, code: null }, true, "BUY"), "No answer was received from the Stocks API.")
})
