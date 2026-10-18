import assert from "node:assert/strict"
import test from "node:test"
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem"
import { getAbiEvents, type ContractArtifactName } from "../evm/abi.js"
import { decodeIndexedEventLog, type RawEvmLog } from "./event-decoder.js"

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const BUYER = A(0xb0)
const ROUTER = A(0xde)
const OTHER = A(0x07)

function log(contract: ContractArtifactName, eventName: string, args: Record<string, unknown>): RawEvmLog {
  const event = getAbiEvents(contract).find((item) => item.name === eventName) as AbiEvent
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    event.inputs.filter((input) => !input.indexed).map((input) => args[input.name!]),
  )
  return {
    address: A(0x71),
    blockNumber: 1n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`,
    logIndex: 0,
    data,
    topics: encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[],
  }
}

const walletOf = (entry: RawEvmLog) => decodeIndexedEventLog(entry)?.args.walletAddress

test("activity attribution: deposits go to the share recipient, redemptions to the holder", () => {
  // A buy through the ArcoRouter: the Router sends, the buyer receives the shares.
  const routed = { sender: ROUTER, recipient: BUYER, paymentAssets: 999_000n, sharesOut: 10n ** 18n }
  assert.equal(walletOf(log("ArcoDepositVault", "ProductDeposit", routed)), BUYER.toLowerCase())
  assert.equal(
    walletOf(
      log("ArcoDepositVault", "ProductDepositRequested", {
        requestId: 1n,
        ...routed,
        paymentRate: 10n ** 18n,
        productRate: 2n * 10n ** 18n,
      }),
    ),
    BUYER.toLowerCase(),
  )
  assert.equal(
    walletOf(log("ArcoDepositVault", "ProductDepositFulfilled", { requestId: 1n, recipient: BUYER, sharesOut: 1n })),
    BUYER.toLowerCase(),
  )
  // A direct buy: sender and recipient are the same wallet.
  assert.equal(
    walletOf(log("ArcoDepositVault", "ProductDeposit", { sender: BUYER, recipient: BUYER, paymentAssets: 1n, sharesOut: 1n })),
    BUYER.toLowerCase(),
  )
  // Redemptions stay with the wallet whose shares were burned, whoever receives the assets.
  assert.equal(
    walletOf(log("ArcoRedemptionVault", "ProductRedeemInstant", { sender: BUYER, recipient: OTHER, sharesIn: 1n, assetsOut: 1n })),
    BUYER.toLowerCase(),
  )
  assert.equal(
    walletOf(log("ArcoRedemptionVault", "ProductRedeemClaimed", { requestId: 1n, recipient: OTHER, assetsOut: 1n })),
    OTHER.toLowerCase(),
  )
})
