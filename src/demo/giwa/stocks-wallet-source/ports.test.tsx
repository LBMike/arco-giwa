import assert from "node:assert/strict"
import test from "node:test"
import { encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem"
import { APPROVAL_ABI } from "../stocks-wallet/abi"
import type { ReviewedDeployment, Transaction } from "../stocks-wallet/types"
import { captureWalletSource } from "./capture"
import { createWalletSourcePorts } from "./ports"
import type { ActiveWalletSource } from "./types"
import { CHECKPOINT, deferred, fakeProvider, flush, OTHER, rejectsCode, reviewedDeployment, throwsCode, TX_HASH, WALLET, WALLET_METHODS, type Answer, type FakeProvider } from "./test-support"

const providers: FakeProvider[] = []
const READS = [
  { method: "eth_chainId", params: [] },
  { method: "eth_accounts", params: [] },
  { method: "eth_getBlockByNumber", params: ["0x1", false] },
]

function setup(answers: Record<string, Answer> = {}) {
  const provider = fakeProvider(answers)
  providers.push(provider)
  let active: ActiveWalletSource | null = { mode: "injected", provider }
  const capture = captureWalletSource({ source: active, address: WALLET, chainId: 91342, epoch: "injected:7" }, { activeSource: () => active })
  assert.equal(capture.status, "READY")
  const source = (capture as Extract<typeof capture, { status: "READY" }>).source
  let deployment: ReviewedDeployment | null = reviewedDeployment()
  const ports = createWalletSourcePorts({ source, deployment: () => deployment })
  return {
    provider, source, ports,
    get deployment() { return deployment },
    setDeployment(next: ReviewedDeployment | null) { deployment = next },
    setActive(next: ActiveWalletSource | null) { active = next },
  }
}
type Setup = ReturnType<typeof setup>

const m = reviewedDeployment().manifest
const identity = { address: getAddress(WALLET), chainId: 91342, connectionEpoch: "injected:7", deploymentDigest: reviewedDeployment().manifestDigest, networkInstance: m.networkInstance, checkpointHash: CHECKPOINT }
const block = (change: Record<string, unknown>) => ({ number: "0x1", hash: CHECKPOINT, ...change })
const approval = (change: Record<string, unknown> = {}) => ({ chainId: 91342, from: WALLET, to: m.cashToken, data: encodeFunctionData({ abi: APPROVAL_ABI, functionName: "approve", args: [m.fundingVault, 120000000n] }), value: "0", ...change }) as Transaction
const allowanceRequest = (change: Record<string, unknown> = {}) => ({ token: m.cashToken, owner: WALLET, spender: m.fundingVault, chainId: 91342 as const, signal: new AbortController().signal, ...change })
/** Every call other than the four read methods. */
const sends = (provider: FakeProvider) => provider.calls.filter(call => call.method !== "eth_chainId" && call.method !== "eth_accounts" && call.method !== "eth_getBlockByNumber" && call.method !== "eth_call")

async function attested(answers: Record<string, Answer> = {}): Promise<Setup> {
  const s = setup(answers)
  assert.deepEqual(await s.ports.readWallet(), identity)
  return s
}

test.after(() => {
  // Read ports never use any other method; only requestTransaction tests below add eth_sendTransaction.
  for (const provider of providers) for (const call of provider.calls) assert.ok([...WALLET_METHODS, "eth_sendTransaction"].includes(call.method), call.method)
})

test("readWallet: exact method sequence and params, attested identity", async () => {
  const s = setup()
  assert.deepEqual(await s.ports.readWallet(), identity)
  assert.deepEqual(s.provider.calls, [...READS, READS[0], READS[1]])
  assert.equal(sends(s.provider).length, 0)
})

test("readWallet: the checkpoint number is requested as a canonical hex quantity", async () => {
  const s = setup({ eth_getBlockByNumber: block({ number: "0x12d687" }) })
  s.setDeployment(reviewedDeployment({ checkpointNumber: "1234567" }))
  await s.ports.readWallet()
  assert.deepEqual(s.provider.calls[2], { method: "eth_getBlockByNumber", params: ["0x12d687", false] })
  const zero = setup({ eth_getBlockByNumber: block({ number: "0x0" }) })
  zero.setDeployment(reviewedDeployment({ checkpointNumber: "0" }))
  await zero.ports.readWallet()
  assert.deepEqual(zero.provider.calls[2], { method: "eth_getBlockByNumber", params: ["0x0", false] })
})

test("readWallet: other chain, other network with the same chain ID and a missing checkpoint are network mismatches", async () => {
  const cases: [Record<string, Answer>, number][] = [
    [{ eth_chainId: "0x1" }, 1],
    [{ eth_getBlockByNumber: block({ hash: `0x${"b".repeat(64)}` }) }, 3],
    [{ eth_getBlockByNumber: null }, 3],
  ]
  for (const [answers, calls] of cases) {
    const s = setup(answers)
    await rejectsCode(s.ports.readWallet(), "WALLET_NETWORK_INSTANCE_MISMATCH")
    assert.equal(s.provider.calls.length, calls)
  }
})

test("readWallet: malformed chain, block and account answers are INVALID_RESPONSE", async () => {
  const cases: Record<string, Answer>[] = [
    { eth_chainId: 91342 }, { eth_chainId: "0x0164ce" }, { eth_chainId: "0x164CE" }, { eth_chainId: "91342" },
    { eth_getBlockByNumber: block({ hash: CHECKPOINT.toUpperCase().replace("0X", "0x") }) },
    { eth_getBlockByNumber: block({ hash: "0x1234" }) },
    { eth_getBlockByNumber: block({ hash: `0x${"0".repeat(64)}` }) },
    { eth_getBlockByNumber: block({ hash: undefined }) },
    { eth_getBlockByNumber: block({ number: "0x2" }) },
    { eth_getBlockByNumber: block({ number: "0x01" }) },
    { eth_getBlockByNumber: block({ number: 1 }) },
    { eth_getBlockByNumber: CHECKPOINT },
    { eth_getBlockByNumber: [block({})] },
    { eth_accounts: WALLET },
    { eth_accounts: ["not-an-address"] },
    { eth_accounts: [`0x${"0".repeat(40)}`] },
  ]
  for (const answers of cases) await rejectsCode(setup(answers).ports.readWallet(), "INVALID_RESPONSE")
})

test("readWallet: empty accounts, another account and an account swap between the two reads are WALLET_CHANGED", async () => {
  for (const answers of [{ eth_accounts: [] }, { eth_accounts: [OTHER] }, { eth_accounts: (_: unknown, n: number) => n === 0 ? [WALLET] : [OTHER] }] as Record<string, Answer>[]) {
    await rejectsCode(setup(answers).ports.readWallet(), "WALLET_CHANGED")
  }
})

test("readWallet: a source event or active source swap mid-read stops before the next request", async () => {
  const events = setup()
  events.provider.answers.eth_getBlockByNumber = () => { events.provider.emit("accountsChanged", [WALLET]); return block({}) }
  await rejectsCode(events.ports.readWallet(), "WALLET_CHANGED")
  assert.equal(events.provider.calls.length, 3)

  const swapped = setup()
  swapped.provider.answers.eth_accounts = (_: unknown, n: number) => { if (n === 1) swapped.setActive({ mode: "injected", provider: fakeProvider() }); return [WALLET] }
  await rejectsCode(swapped.ports.readWallet(), "WALLET_CHANGED")
  assert.equal(swapped.provider.calls.length, 5)

  const disposed = setup()
  disposed.source.dispose()
  await rejectsCode(disposed.ports.readWallet(), "WALLET_CHANGED")
  assert.equal(disposed.provider.calls.length, 0)
})

test("readWallet: a deployment digest change mid-read is CONTEXT_CHANGED", async () => {
  const s = setup()
  s.provider.answers.eth_getBlockByNumber = () => { s.setDeployment(reviewedDeployment({ networkInstance: "test-network-2" })); return block({}) }
  await rejectsCode(s.ports.readWallet(), "CONTEXT_CHANGED")
})

test("readWallet: unreviewed or tampered deployment is refused before any request", async () => {
  const s = setup()
  s.setDeployment(null)
  await rejectsCode(s.ports.readWallet(), "DEPLOYMENT_NOT_REVIEWED")
  s.setDeployment({ ...reviewedDeployment(), manifestDigest: "0".repeat(64) })
  await rejectsCode(s.ports.readWallet(), "MANIFEST_DIGEST_MISMATCH")
  s.setDeployment({ ...reviewedDeployment(), manifest: { ...m, checkpointHash: `0x${"d".repeat(64)}` } })
  await rejectsCode(s.ports.readWallet(), "MANIFEST_DIGEST_MISMATCH")
  assert.equal(s.provider.calls.length, 0)
})

test("readWallet: provider rejections are REQUEST_FAILED once, with no retry and no raw message", async () => {
  const failures: unknown[] = [{ code: -32603, message: "internal secret" }, { code: 4001, message: "User rejected the request." }, new Error("raw provider text")]
  for (const failure of failures) {
    const s = setup({ eth_chainId: () => { throw failure } })
    await rejectsCode(s.ports.readWallet(), "REQUEST_FAILED")
    await flush()
    assert.deepEqual(s.provider.methods(), ["eth_chainId"])
  }
})

test("readAllowance: exact eth_call params and decimal strings for 0, 1 and 2^256-1", async () => {
  const owner = WALLET.slice(2).toLowerCase(), spender = m.fundingVault.slice(2).toLowerCase()
  const data = `0xdd62ed3e${owner.padStart(64, "0")}${spender.padStart(64, "0")}`
  assert.equal(data, encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [WALLET, m.fundingVault] }))
  const results: [Hex, string][] = [[`0x${"0".repeat(64)}`, "0"], [`0x${"0".repeat(63)}1`, "1"], [`0x${"f".repeat(64)}`, ((1n << 256n) - 1n).toString()], [`0x${"F".repeat(64)}`, ((1n << 256n) - 1n).toString()]]
  for (const [answer, expected] of results) {
    const s = setup({ eth_call: answer })
    assert.equal(await s.ports.readAllowance(allowanceRequest()), expected)
    assert.deepEqual(s.provider.calls, [...READS, { method: "eth_call", params: [{ to: m.cashToken, data }, "latest"] }, READS[0], READS[1]])
    assert.equal(sends(s.provider).length, 0)
  }
  const sell = setup()
  assert.equal(await sell.ports.readAllowance(allowanceRequest({ token: m.stockToken, spender: m.redemptionEscrow })), "0")
  assert.deepEqual(sell.provider.calls[3], { method: "eth_call", params: [{ to: m.stockToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [WALLET, m.redemptionEscrow] }) }, "latest"] })
})

test("readAllowance: scope, owner and chain are refused before any request", async () => {
  const s = setup()
  const scope: [Record<string, unknown>, string][] = [
    [{ token: m.cashToken, spender: m.redemptionEscrow }, "ALLOWANCE_SCOPE_MISMATCH"],
    [{ token: m.stockToken, spender: m.fundingVault }, "ALLOWANCE_SCOPE_MISMATCH"],
    [{ token: m.fundingVault, spender: m.cashToken }, "ALLOWANCE_SCOPE_MISMATCH"],
    [{ token: m.mintController, spender: m.fundingVault }, "ALLOWANCE_SCOPE_MISMATCH"],
    [{ chainId: 1 }, "ALLOWANCE_SCOPE_MISMATCH"],
    [{ owner: OTHER }, "WALLET_CHANGED"],
  ]
  for (const [change, code] of scope) await rejectsCode(s.ports.readAllowance(allowanceRequest(change)), code)
  assert.equal(s.provider.calls.length, 0)
})

test("readAllowance: malformed eth_call results are INVALID_RESPONSE", async () => {
  for (const answer of ["0x", `0x${"0".repeat(63)}`, `0x${"z".repeat(64)}`, `0x${"0".repeat(66)}`, 0, null]) {
    await rejectsCode(setup({ eth_call: answer }).ports.readAllowance(allowanceRequest()), "INVALID_RESPONSE")
  }
})

test("readAllowance: abort before and after the call, source swap and chain change after the call", async () => {
  const before = setup()
  const early = new AbortController(); early.abort()
  await rejectsCode(before.ports.readAllowance(allowanceRequest({ signal: early.signal })), "CONTEXT_CHANGED")
  assert.equal(before.provider.calls.length, 0)

  const after = setup()
  const late = new AbortController()
  after.provider.answers.eth_call = () => { late.abort(); return `0x${"0".repeat(64)}` }
  await rejectsCode(after.ports.readAllowance(allowanceRequest({ signal: late.signal })), "CONTEXT_CHANGED")
  assert.equal(after.provider.calls.length, 4)

  const swap = setup()
  swap.provider.answers.eth_call = () => { swap.provider.emit("chainChanged", "0x164ce"); return `0x${"0".repeat(64)}` }
  await rejectsCode(swap.ports.readAllowance(allowanceRequest()), "WALLET_CHANGED")
  assert.equal(swap.provider.calls.length, 4)

  const chain = setup({ eth_chainId: (_: unknown, n: number) => n === 0 ? "0x164ce" : "0x1" })
  await rejectsCode(chain.ports.readAllowance(allowanceRequest()), "WALLET_NETWORK_INSTANCE_MISMATCH")
  assert.equal(chain.provider.calls.length, 5)

  const account = setup({ eth_accounts: (_: unknown, n: number) => n === 0 ? [WALLET] : [OTHER] })
  await rejectsCode(account.ports.readAllowance(allowanceRequest()), "WALLET_CHANGED")

  const checkpoint = setup({ eth_getBlockByNumber: null })
  await rejectsCode(checkpoint.ports.readAllowance(allowanceRequest()), "WALLET_NETWORK_INSTANCE_MISMATCH")
  assert.equal(checkpoint.provider.calls.length, 3)

  const failing = setup({ eth_call: () => { throw { code: -32603, message: "internal" } } })
  await rejectsCode(failing.ports.readAllowance(allowanceRequest()), "REQUEST_FAILED")
  assert.equal(failing.provider.calls.filter(call => call.method === "eth_call").length, 1)
  for (const x of [before, after, swap, chain, account, checkpoint, failing]) assert.equal(sends(x.provider).length, 0)
})

test("requestTransaction: one raw eth_sendTransaction issued synchronously, nothing else", async () => {
  const s = await attested()
  const before = s.provider.calls.length
  const tx = approval()
  const pending = s.ports.requestTransaction(tx)
  assert.equal(s.provider.calls.length, before + 1, "the provider was called before requestTransaction returned")
  assert.deepEqual(s.provider.calls.slice(before), [{ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: "0x0" }] }])
  assert.equal(await pending, TX_HASH)
  await flush()
  assert.deepEqual(s.provider.methods().slice(before), ["eth_sendTransaction"])
  assert.equal(s.provider.calls.filter(call => ["wallet_sendTransaction", "eth_sendRawTransaction"].includes(call.method)).length, 0)
  assert.equal(s.provider.calls.slice(before).filter(call => call.method === "eth_chainId").length, 0, "no chain read during dispatch")
  const transfer = s.ports.requestTransaction(approval({ to: m.fundingVault, data: "0xabcd" }))
  assert.equal(s.provider.calls.length, before + 2)
  await transfer
})

test("requestTransaction: refusals are synchronous and send nothing", async () => {
  const unattested = setup()
  throwsCode(() => unattested.ports.requestTransaction(approval()), "WALLET_NOT_ATTESTED")

  const failed = await attested()
  failed.provider.answers.eth_chainId = "0x1"
  await rejectsCode(failed.ports.readWallet(), "WALLET_NETWORK_INSTANCE_MISMATCH")
  throwsCode(() => failed.ports.requestTransaction(approval()), "WALLET_NOT_ATTESTED")

  const s = await attested()
  const refusals: [Transaction, string][] = [
    [approval({ from: OTHER }), "WALLET_CHANGED"],
    [approval({ to: m.mintController }), "TRANSACTION_MISMATCH"],
    [approval({ to: m.signerAddress }), "TRANSACTION_MISMATCH"],
    [approval({ to: OTHER }), "TRANSACTION_MISMATCH"],
    [approval({ value: "1" }), "TRANSACTION_MISMATCH"],
    [approval({ value: 0 }), "TRANSACTION_MISMATCH"],
    [approval({ gas: "0x5208" }), "TRANSACTION_MISMATCH"],
    [{ chainId: 91342, from: WALLET, to: m.cashToken, value: "0" } as unknown as Transaction, "TRANSACTION_MISMATCH"],
    [approval({ chainId: 1 }), "TRANSACTION_MISMATCH"],
    [approval({ data: "0x" }), "TRANSACTION_MISMATCH"],
    [approval({ data: "0x123" }), "TRANSACTION_MISMATCH"],
    [null as unknown as Transaction, "TRANSACTION_MISMATCH"],
  ]
  for (const [tx, code] of refusals) throwsCode(() => s.ports.requestTransaction(tx), code)

  s.setDeployment(reviewedDeployment({ networkInstance: "test-network-2" }))
  throwsCode(() => s.ports.requestTransaction(approval()), "WALLET_NOT_ATTESTED")
  s.setDeployment(null)
  throwsCode(() => s.ports.requestTransaction(approval()), "DEPLOYMENT_NOT_REVIEWED")

  const stale = await attested()
  stale.provider.emit("accountsChanged", [WALLET])
  throwsCode(() => stale.ports.requestTransaction(approval()), "WALLET_CHANGED")

  const swapped = await attested()
  swapped.setActive({ mode: "injected", provider: fakeProvider() })
  throwsCode(() => swapped.ports.requestTransaction(approval()), "WALLET_CHANGED")

  const disposed = await attested()
  disposed.source.dispose()
  throwsCode(() => disposed.ports.requestTransaction(approval()), "WALLET_CHANGED")

  for (const provider of [unattested, failed, s, stale, swapped, disposed].map(x => x.provider)) assert.equal(sends(provider).length, 0)
})

test("requestTransaction: a -32603 rejection is requested exactly once and propagates unchanged", async () => {
  const failure = { code: -32603, message: "Internal JSON-RPC error." }
  const s = await attested({ eth_sendTransaction: () => { throw failure } })
  await assert.rejects(s.ports.requestTransaction(approval()), (error: unknown) => error === failure)
  await flush()
  assert.equal(sends(s.provider).length, 1)
})

test("requestTransaction: a hash answered after accountsChanged is returned unchanged; a held request is the same promise", async () => {
  const held = deferred<unknown>()
  const s = await attested({ eth_sendTransaction: () => held.promise })
  const pending = s.ports.requestTransaction(approval())
  assert.equal(pending, held.promise)
  s.provider.emit("accountsChanged", [OTHER])
  assert.equal(s.source.isCurrent(), false)
  held.resolve(TX_HASH)
  assert.equal(await pending, TX_HASH)
  assert.equal(sends(s.provider).length, 1)
  throwsCode(() => s.ports.requestTransaction(approval()), "WALLET_CHANGED")
})

test("waitApprovalReceipt is inactive and touches nothing", async () => {
  const s = setup()
  const listeners = s.provider.listenerCount()
  const signal = new AbortController().signal
  await rejectsCode(s.ports.waitApprovalReceipt({ txHash: TX_HASH, transaction: approval(), signal }), "RECEIPT_PORT_INACTIVE")
  assert.equal(s.provider.calls.length, 0)
  assert.equal(s.provider.listenerCount(), listeners)
  assert.equal(s.source.isCurrent(), true)
})
