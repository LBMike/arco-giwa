import assert from "node:assert/strict"
import test from "node:test"
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Log } from "viem"

import { receivedTokenAmount } from "./contracts"

const SHARES = "0x00000000000000000000000000000000000000b1" as const
const OTHER = "0x00000000000000000000000000000000000000a1" as const
const ME = "0x00000000000000000000000000000000000000aa" as const
const VAULT = "0x00000000000000000000000000000000000000c1" as const
const ZERO = "0x0000000000000000000000000000000000000000" as const

function transfer(token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, value: bigint): Log {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Log["topics"],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  } as Log
}

test("what reached the wallet is read from the receipt's Transfer logs of that token", () => {
  const logs = [
    transfer(OTHER, ME, VAULT, 1_000_000_000n), // the payment going out
    transfer(SHARES, ZERO, ME, 998_215_612_345_678_901_234n), // the shares minted to the wallet
    transfer(SHARES, ZERO, VAULT, 5n), // shares to someone else
  ]
  assert.equal(receivedTokenAmount({ logs }, SHARES, ME, 18), "998.215612345678901234")
  assert.equal(receivedTokenAmount({ logs }, SHARES, "0x00000000000000000000000000000000000000AA", 18), "998.215612345678901234", "addresses compare case-insensitively")
  assert.equal(receivedTokenAmount({ logs: [...logs, transfer(SHARES, VAULT, ME, 1_000_000_000_000_000_000n)] }, SHARES, ME, 18), "999.215612345678901234", "several transfers add up")
  assert.equal(receivedTokenAmount({ logs }, OTHER, ME, 6), null, "nothing of that token came in")
  assert.equal(receivedTokenAmount({ logs: [] }, SHARES, ME, 18), null)
  assert.equal(receivedTokenAmount({}, SHARES, ME, 18), null, "a receipt without logs")
  assert.equal(receivedTokenAmount(null, SHARES, ME, 18), null)
  assert.equal(receivedTokenAmount({ logs }, null, ME, 18), null, "no token address")
})
