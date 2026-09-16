import assert from "node:assert/strict"
import test from "node:test"
import { createSiweMessage } from "viem/siwe"
import { createWalletMessageSigner, type MessageWallet } from "./wallet-bridge"
import { signWithActiveGiwaWallet } from "./active-wallet"
import { setDynamicWalletClient, setInjectedWalletSource } from "../contracts"

const A = "0x1111111111111111111111111111111111111111" as const
const B = "0x2222222222222222222222222222222222222222" as const
const SIG = `0x${"11".repeat(65)}` as const
const request = { account: A, chainId: 91342 as const, message: createSiweMessage({ address: A, chainId: 91342, domain: "app.example", uri: "https://app.example", version: "1", nonce: "abcdefgh" }) }

test("current client signs only a message, with account and chain checks before and after", async () => {
  const methods: string[] = []
  const client: MessageWallet = {
    getAddresses: async () => { methods.push("accounts"); return [A] },
    getChainId: async () => { methods.push("chain"); return 91342 },
    signMessage: async args => { methods.push("message"); assert.deepEqual(args, { account: A, message: request.message }); return SIG },
  }
  assert.equal(await createWalletMessageSigner(() => client)(request), SIG)
  assert.deepEqual(methods, ["accounts", "chain", "message", "accounts", "chain"])
})

test("wrong account, chain, unsupported client or mismatched SIWE message never signs", async () => {
  let count = 0
  for (const client of [
    {},
    { getAddresses: async () => [B], getChainId: async () => 91342 },
    { getAddresses: async () => [A], getChainId: async () => 1 },
  ]) {
    await assert.rejects(createWalletMessageSigner(() => ({ ...client, signMessage: async () => { count++; return SIG } }))(request))
  }
  await assert.rejects(createWalletMessageSigner(() => ({}))({ ...request, account: B }))
  assert.equal(count, 0)
})

test("account change while the wallet prompt is open rejects its signature", async () => {
  let changed = false
  const client: MessageWallet = { getAddresses: async () => [changed ? B : A], getChainId: async () => 91342, signMessage: async () => { changed = true; return SIG } }
  await assert.rejects(createWalletMessageSigner(() => client)(request), /SIGN_IN_WALLET_MISMATCH/)
})

test("active Dynamic wallet source is reused without transaction or contract calls", async () => {
  let transactions = 0
  setDynamicWalletClient({
    getAddresses: async () => [A], getChainId: async () => 91342, signMessage: async () => SIG,
    sendTransaction: async () => { transactions++; return SIG }, writeContract: async () => { transactions++; return SIG },
  })
  try { assert.equal(await signWithActiveGiwaWallet(request), SIG); assert.equal(transactions, 0) }
  finally { setInjectedWalletSource() }
})

test("active injected wallet uses only eth_accounts, eth_chainId and personal_sign", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  const methods: string[] = []
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: {
    async request({ method, params }: { method: string; params: unknown[] }) {
      methods.push(method)
      if (method === "eth_accounts") return [A]
      if (method === "eth_chainId") return "0x164ce"
      if (method === "personal_sign") { assert.equal(params[1], A); return SIG }
      throw new Error(`Unexpected wallet method: ${method}`)
    },
  } } })
  setInjectedWalletSource()
  try {
    assert.equal(await signWithActiveGiwaWallet(request), SIG)
    assert.equal(methods.filter(method => method === "personal_sign").length, 1)
    assert.ok(methods.every(method => ["eth_accounts", "eth_chainId", "personal_sign"].includes(method)))
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
    setInjectedWalletSource()
  }
})
