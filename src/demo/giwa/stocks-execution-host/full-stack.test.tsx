// Full stack without a browser: the REAL execution registry (owner composition), wallet controller, execution read
// adapter, submission client and wallet source ports, against the REAL server plugins (Stocks, execution, wallet
// submissions with the real receipt verifier and RPC port) over the test-only in-process harness, and a fake
// EIP-1193 wallet on the same fake chain. Every "check" below is what the panel's Check button runs: an explicit
// evidence read, then the read-only controller check. No socket, database, public network, key or signature.

import assert from "node:assert/strict"
import test from "node:test"

import { encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem"

import type { HostSession } from "../stocks-host/session"
import { STOCKS_ABI } from "../stocks-wallet/abi"
import type { Side, WalletSnapshot } from "../stocks-wallet/types"
import type { ActiveWalletSource } from "../stocks-wallet-source"
import { createExecutionRegistry, type ExecutionHostView, type ExecutionOwner, type ExecutionRegistry } from "./registry"
import type { NetworkVariant } from "./testing/fake-chain"
import { createFakeEip1193Wallet, providerError, type FakeEip1193Wallet } from "./testing/fake-wallet"
import { createInProcessStocks } from "./testing/in-process-stocks"

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const A = getAddress("0x000000000000000000000000000000000000a11c")
const B = getAddress("0x000000000000000000000000000000000000b0b0")
const QUANTITY = 1_000_000_000n
const CASH = 120_000_000n
const WALLET_READS = ["eth_chainId", "eth_accounts", "eth_getBlockByNumber", "eth_call"]

type WorldOptions = {
  network?: NetworkVariant
  lifetimeMs?: number
  /** Test-only rewrite of a real server response (for example a shorter policy lease). */
  rewrite?: (path: string, response: Response) => Promise<Response> | Response
}

async function world(side: Side, options: WorldOptions = {}) {
  const h = await createInProcessStocks()
  if (side === "SELL") h.seedStock(A, QUANTITY)
  else h.seedCash(A, CASH)
  let session: HostSession = h.session(A, options.lifetimeMs ? { lifetimeMs: options.lifetimeMs } : {})
  const created = await h.createOrder(side, session)
  const wallet = createFakeEip1193Wallet(h.chain, { account: A, network: options.network })
  let source: ActiveWalletSource = { mode: "injected", provider: wallet }
  let active: ActiveWalletSource | null = source
  let view: ExecutionHostView = { session, wallet: { source, address: A, chainId: 91342, epoch: "injected:1" }, apiBase: h.apiBase }
  // Browser clocks: real time plus test offsets, like a stalled page or a sleeping laptop.
  const offsets = { wall: 0, monotonic: 0 }
  const invalidated: string[] = []
  let rewrite = options.rewrite ?? null
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await h.fetch(input, init)
    return rewrite ? rewrite(new URL(String(input)).pathname, response) : response
  }) as typeof globalThis.fetch
  const newRegistry = () => createExecutionRegistry({
    view: () => view,
    invalidate: (id) => invalidated.push(id),
    fetch,
    now: () => Date.now() + offsets.wall,
    monotonicNow: () => performance.now() + offsets.monotonic,
    activeSource: () => active,
  })
  let registry: ExecutionRegistry = newRegistry()
  const m = h.manifest
  const token = side === "BUY" ? m.cashToken : m.stockToken
  const spender = side === "BUY" ? m.fundingVault : m.redemptionEscrow
  const order = created.order as Json
  const amount = side === "BUY" ? CASH : QUANTITY
  const expected = {
    approval: { from: A, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), value: "0x0" },
    transfer: {
      from: A,
      to: spender,
      data: side === "BUY" ? encodeFunctionData({ abi: STOCKS_ABI, functionName: "depositForOrder", args: [order.orderKey as Hex, amount] }) : encodeFunctionData({ abi: STOCKS_ABI, functionName: "escrowForOrder", args: [order.orderKey as Hex, m.stockToken, amount] }),
      value: "0x0",
    },
  }
  function ownerOf(): ExecutionOwner {
    const lookup = registry.ownerFor(side, order)
    assert.ok(lookup.owner, `owner: ${lookup.code}`)
    return lookup.owner
  }
  const w = {
    h, wallet, order, side, offsets, invalidated, expected, token, spender,
    get registry() { return registry },
    get session() { return session },
    owner: ownerOf,
    /** What the panel's Check button runs. */
    async check(owner: ExecutionOwner = ownerOf()): Promise<WalletSnapshot> {
      await owner.refreshEvidence()
      await owner.controller.prepare()
      return owner.controller.getSnapshot()
    },
    snapshot: (owner: ExecutionOwner = ownerOf()): WalletSnapshot => owner.controller.getSnapshot(),
    sends: () => wallet.callsOf("eth_sendTransaction"),
    /** Anything a wallet port must never call: other send methods, account requests, chain switches, estimates. */
    forbidden: () => wallet.calls.filter((call) => ![...WALLET_READS, "eth_sendTransaction"].includes(call.method)),
    server: (method: string, suffix: string) => h.requests.filter((request) => request.method === method && request.path.endsWith(suffix)),
    journal: async (): Promise<Json> => {
      const response = await h.fetch(`${h.apiBase}/api/v1/stocks/wallet-submissions/${side}/${order.id}`, { headers: { authorization: `Bearer ${session.accessToken}`, accept: "application/json" } })
      return ((await response.json()) as Json).data
    },
    setView(change: Partial<ExecutionHostView>) { view = { ...view, ...change } },
    setWallet(change: Partial<ExecutionHostView["wallet"]>) { view = { ...view, wallet: { ...view.wallet, ...change } } },
    setActive(next: ActiveWalletSource | null) { active = next },
    replaceSource(next: FakeEip1193Wallet) { source = { mode: "injected", provider: next }; active = source; view = { ...view, wallet: { ...view.wallet, source } } },
    /** A new page owner for the same identity, as after a remount or reload. */
    remount() { registry.dispose(); registry = newRegistry(); return registry },
    signInAgain() { session = h.session(A); view = { ...view, session }; registry.dispose(); registry = newRegistry() },
    setRewrite(next: WorldOptions["rewrite"] | null) { rewrite = next ?? null },
    async close() { registry.dispose(); await h.close() },
  }
  return w
}
type World = Awaited<ReturnType<typeof world>>

async function run(side: Side, options: WorldOptions, body: (w: World) => Promise<void>) {
  const w = await world(side, options)
  try {
    await body(w)
  } finally {
    await w.close()
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out: ${label}`)
}

for (const side of ["BUY", "SELL"] as const) {
  const transferWord = side === "BUY" ? "deposit" : "escrow"

  test(`${side}: check → exact approval → server-verified approval → separate ${transferWord}; exact wallet and server requests`, async () => {
    await run(side, {}, async (w) => {
      const owner = w.owner()
      w.h.clearRequests()
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      assert.equal(w.server("GET", "/api/v1/stocks/execution/deployment").length, 1, "one explicit evidence read")
      assert.deepEqual([...new Set(w.wallet.calls.map((call) => call.method))].sort(), [...WALLET_READS].sort(), "a check only reads through the wallet")
      assert.equal(w.sends().length, 0)
      assert.equal(w.server("POST", "/claims").length, 0)

      // Two activations share one attempt.
      await Promise.all([owner.controller.approve(), owner.controller.approve()])
      assert.equal(w.sends().length, 1, "one approval request")
      assert.deepEqual(w.sends()[0]!.params, [w.expected.approval], "exact from/to/data/value, nothing added")
      assert.equal(w.snapshot().status, "READY_TRANSFER", "approval confirmed by the server; the transfer waits for its own click")
      assert.equal(w.h.chain.allowance(w.token, A, w.spender), side === "BUY" ? CASH : QUANTITY, "exact allowance, never max")
      assert.equal(w.server("POST", "/claims").length, 1)
      assert.equal(w.server("POST", "/outcomes").length, 1)
      assert.equal(w.server("POST", "/reconcile").length, 1)
      await flush()
      assert.equal(w.sends().length, 1, `no automatic ${transferWord}`)

      await Promise.all([owner.controller.submit(), owner.controller.submit()])
      assert.equal(w.sends().length, 2, `one ${transferWord} request`)
      assert.deepEqual(w.sends()[1]!.params, [w.expected.transfer])
      const shown = w.snapshot()
      assert.deepEqual([shown.status, shown.stage, shown.error], ["SUBMITTED", "TRANSFER", null])
      assert.match(shown.txHash ?? "", /^0x[0-9a-f]{64}$/)
      assert.equal(w.server("POST", "/claims").length, 2)
      assert.equal(w.server("POST", "/outcomes").length, 2)
      assert.equal(w.server("POST", "/reconcile").length, 1, "the transfer is never reconciled from the browser")
      assert.deepEqual(w.forbidden(), [], "no wallet_sendTransaction, eth_sendRawTransaction, account request, switch or estimate")
      assert.equal(w.h.chain.balanceOf(w.token, w.spender), side === "BUY" ? CASH : QUANTITY)
      const journal = await w.journal()
      assert.deepEqual([journal.approval.status, journal.transfer.status, journal.transfer.txHash], ["CONFIRMED", "SUBMITTED", shown.txHash])
      const row = (await (await w.h.fetch(`${w.h.apiBase}${side === "BUY" ? "/api/v1/stocks/orders" : "/api/v1/stocks/sell-orders"}/${w.order.id}`, { headers: { authorization: `Bearer ${w.session.accessToken}` } })).json()) as Json
      assert.equal(row.data.state, side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW", "a transfer hash does not move the order: only the server observer does")
      assert.deepEqual(w.invalidated, [])
    })
  })

  test(`${side}: another network behind the same chain ID, another chain and a missing checkpoint block stop at the check with no claim`, async () => {
    for (const network of ["other-checkpoint", "other-chain", "missing-checkpoint"] as const) {
      await run(side, { network }, async (w) => {
        const shown = await w.check()
        assert.deepEqual([shown.status, shown.error], ["BLOCKED", "WALLET_NETWORK_INSTANCE_MISMATCH"], network)
        const approve = w.owner().controller.approve()
        await approve
        assert.equal(w.sends().length, 0, network)
        assert.equal(w.server("POST", "/claims").length, 0, network)
        assert.ok(w.wallet.callsOf("eth_getBlockByNumber").length >= (network === "other-chain" ? 0 : 1), `${network}: the checkpoint is read from the wallet's own source`)
      })
    }
  })

  test(`${side}: account A→B→A, a same-address source swap and a swap during the allowance read never reach a claim or the wallet`, async () => {
    await run(side, {}, async (w) => {
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      w.wallet.setAccount(B)
      w.wallet.setAccount(A)
      await w.owner().controller.approve()
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "WALLET_CHANGED"], "A→B→A retires the captured source for good")
      assert.equal(w.sends().length + w.server("POST", "/claims").length, 0)
    })
    await run(side, {}, async (w) => {
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      w.setActive({ mode: "injected", provider: createFakeEip1193Wallet(w.h.chain, { account: A }) })
      await w.owner().controller.approve()
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "WALLET_CHANGED"], "same address, another provider object")
      assert.equal(w.sends().length + w.server("POST", "/claims").length, 0)
    })
    await run(side, {}, async (w) => {
      const held = w.wallet.holdNext("eth_call")
      const checking = w.check()
      await held.arrived
      w.wallet.setAccount(B)
      held.release()
      const shown = await checking
      assert.deepEqual([shown.status, shown.error], ["BLOCKED", "WALLET_CHANGED"], "an allowance answered after the account changed is not used")
      assert.equal(w.sends().length + w.server("POST", "/claims").length, 0)
    })
  })

  test(`${side}: an account change inside a SIGNING subscriber is refused synchronously by the port: no wallet request`, async () => {
    await run(side, {}, async (w) => {
      const owner = w.owner()
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      let fired = false
      const unsubscribe = owner.controller.subscribe(() => {
        if (!fired && owner.controller.getSnapshot().status === "SIGNING") {
          fired = true
          w.wallet.setAccount(B)
        }
      })
      await owner.controller.approve()
      unsubscribe()
      assert.ok(fired)
      assert.equal(w.sends().length, 0, "the port checks the captured source immediately before the single send")
      // The controller treats any refusal inside the wallet request as uncertain: the claim is consumed and recovery-only.
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["UNKNOWN", "WALLET_OUTCOME_UNKNOWN"])
      assert.equal((await w.journal()).approval.status, "UNKNOWN")
    })
  })
}

test("a 4 s policy with a 6 s check inside the final wallet read and 15 s evidence sends nothing; a port that awaited its own check would", async () => {
  const shortPolicy = async (path: string, response: Response) => {
    if (!/^\/api\/v1\/stocks\/execution\/(BUY|SELL)\//.test(path) || response.status !== 200) return response
    const body = (await response.json()) as Json
    body.data.validUntil = body.data.observedAt + 4_000
    return new Response(JSON.stringify(body), { status: 200, headers: response.headers })
  }
  for (const side of ["BUY", "SELL"] as const) {
    await run(side, { rewrite: shortPolicy }, async (w) => {
      const owner = w.owner()
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      // The last wallet read before SIGNING follows the final order re-read after the claim.
      const unsubscribe = w.wallet.onCall("eth_getBlockByNumber", () => {
        if (w.server("POST", "/claims").length === 1 && w.h.requests[w.h.requests.length - 1]?.path.endsWith(`/${w.order.id}`)) w.offsets.monotonic += 6_000
      })
      await owner.controller.approve()
      unsubscribe()
      assert.equal(w.offsets.monotonic, 6_000, "the 6 s check ran inside the final wallet read, exactly once")
      assert.equal(owner.ports.context().deployment !== null, true, "the 15 s evidence is still current")
      assert.equal(w.sends().length, 0, `${side}: no wallet request after the policy's lifetime`)
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["UNKNOWN", "EXECUTION_POLICY_EXPIRED"])
      assert.equal((await w.journal()).approval.status, "REQUEST_MAY_START", "refused before dispatch: no uncertain outcome recorded")
    })
  }
  // Negative control: the same timing with a port that awaits an internal wallet check inside requestTransaction.
  await run("BUY", { rewrite: shortPolicy }, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    const direct = owner.ports.requestTransaction
    owner.ports.requestTransaction = async (tx: Parameters<typeof direct>[0]) => {
      w.offsets.monotonic += 6_000
      await owner.ports.readWallet()
      return direct(tx)
    }
    await owner.controller.approve()
    assert.equal(w.sends().length, 1, "an await inside the port escapes the controller's last policy check")
  })
})

test("an open approval prompt survives evidence and policy expiry: the late hash is recorded and shown, nothing continues", async () => {
  for (const side of ["BUY", "SELL"] as const) {
    await run(side, {}, async (w) => {
      const owner = w.owner()
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      const held = w.wallet.holdNext("eth_sendTransaction")
      const approving = owner.controller.approve()
      await held.arrived
      assert.equal(w.snapshot().status, "SIGNING")
      w.offsets.wall += 16_000
      w.offsets.monotonic += 16_000
      assert.equal(owner.ports.context().deployment, null, "evidence ended")
      assert.equal(w.snapshot().status, "SIGNING", "the open prompt stays on screen")
      held.release()
      await approving
      const shown = w.snapshot()
      assert.deepEqual([shown.status, shown.error], ["APPROVAL_SUBMITTED", "EXECUTION_AUTHORITY_CHANGED"])
      assert.match(shown.txHash ?? "", /^0x[0-9a-f]{64}$/)
      assert.equal((await w.journal()).approval.txHash, shown.txHash, "recorded through the original gate")
      assert.equal(w.server("POST", "/reconcile").length, 0, "no automatic verification")
      assert.equal(w.sends().length, 1)
      // Recovery is an explicit check with current evidence and clocks; nothing is sent again.
      w.offsets.wall = 0
      w.offsets.monotonic = 0
      w.remount()
      assert.equal((await w.check()).status, "READY_TRANSFER")
      assert.equal(w.sends().length, 1)
    })
  }
})

test("logout or reload during an open prompt: the late hash reaches the original gate; a new owner recovers it only through a check", async () => {
  await run("BUY", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    const held = w.wallet.holdNext("eth_sendTransaction")
    const approving = owner.controller.approve()
    await held.arrived
    // The host leaves this identity (logout or reload): the registry is disposed while the wallet prompt is open.
    w.setView({ session: null })
    w.registry.dispose()
    held.release()
    await approving
    await until(() => w.server("POST", "/outcomes").length === 1, "late outcome")
    assert.equal((await w.journal()).approval.status, "SUBMITTED")
    assert.equal(owner.controller.getSnapshot().status, "IDLE", "a disposed owner paints nothing")
    w.signInAgain()
    const fresh = w.owner()
    assert.notEqual(fresh, owner)
    assert.equal(w.snapshot(fresh).status, "IDLE", "a new owner shows nothing before an explicit check")
    assert.equal((await w.check(fresh)).status, "READY_TRANSFER", "the recorded approval is verified by the server")
    assert.equal(w.sends().length, 1)
  })
})

test("an expired session makes the original gate refuse the late hash; the next session's check shows a recovery-only claim and never resends", async () => {
  await run("SELL", { lifetimeMs: 20_000 }, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    const held = w.wallet.holdNext("eth_sendTransaction")
    const approving = owner.controller.approve()
    await held.arrived
    w.offsets.wall += 21_000
    w.offsets.monotonic += 21_000
    held.release()
    await approving
    assert.equal(w.server("POST", "/outcomes").length, 0, "the captured gate refuses an expired session before any request")
    const shown = w.snapshot()
    assert.equal(shown.status, "APPROVAL_SUBMITTED")
    assert.match(shown.txHash ?? "", /^0x[0-9a-f]{64}$/, "the hash is still shown on the same screen")
    assert.equal((await w.journal()).approval.status, "REQUEST_MAY_START", "known limit: the server journal has no hash")
    w.offsets.wall = 0
    w.offsets.monotonic = 0
    w.signInAgain()
    const recovered = await w.check()
    assert.deepEqual([recovered.status, recovered.stage, recovered.txHash], ["UNKNOWN", "APPROVAL", null], "recovery-only: do not repeat")
    await w.owner().controller.approve()
    assert.equal(w.sends().length, 1, "never resent")
  })
})

test("a late 401 invalidates only the captured session; cancel keeps the late hash on the same screen", async () => {
  await run("BUY", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    const held = w.wallet.holdNext("eth_sendTransaction")
    const approving = owner.controller.approve()
    await held.arrived
    w.setRewrite((path: string, response: Response) => (path.endsWith("/outcomes") ? new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }) : response))
    held.release()
    await approving
    assert.deepEqual(w.invalidated, [w.session.id])
    assert.equal(w.snapshot().status, "APPROVAL_SUBMITTED")
    assert.equal(w.sends().length, 1)
  })
  await run("SELL", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    const held = w.wallet.holdNext("eth_sendTransaction")
    const approving = owner.controller.approve()
    await held.arrived
    owner.controller.cancel()
    held.release()
    await approving
    await until(() => w.snapshot().txHash !== null, "late hash shown")
    assert.equal(w.snapshot().status, "APPROVAL_SUBMITTED")
    assert.equal((await w.journal()).approval.status, "SUBMITTED")
    assert.equal(w.sends().length, 1)
  })
})

test("a rejected (4001) or failing (-32603) request is UNKNOWN and recovery-only; a reverted approval blocks the transfer; a pending receipt waits", async () => {
  for (const [error, label] of [[providerError(4001, "User rejected"), "4001"], [providerError(-32603, "Internal"), "-32603"]] as const) {
    await run("BUY", {}, async (w) => {
      const owner = w.owner()
      assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
      w.wallet.failNext("eth_sendTransaction", error)
      await owner.controller.approve()
      assert.equal(w.sends().length, 1, `${label}: sent once, never retried`)
      assert.deepEqual([w.snapshot().status, w.snapshot().error], ["UNKNOWN", "WALLET_OUTCOME_UNKNOWN"], label)
      assert.equal((await w.journal()).approval.status, "UNKNOWN")
      assert.equal((await w.check()).status, "UNKNOWN", `${label}: a later check stays recovery-only`)
      await owner.controller.approve()
      assert.equal(w.sends().length, 1)
    })
  }
  await run("SELL", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    w.h.chain.revertNextTransaction()
    await owner.controller.approve()
    assert.deepEqual([w.snapshot().status, w.snapshot().error], ["BLOCKED", "APPROVAL_REVERTED"])
    await owner.controller.submit()
    assert.equal(w.sends().length, 1, "no transfer after a reverted approval")
  })
  await run("BUY", {}, async (w) => {
    const owner = w.owner()
    assert.equal((await w.check()).status, "APPROVAL_REQUIRED")
    w.h.chain.setFinalizeImmediately(false)
    await owner.controller.approve()
    assert.deepEqual([w.snapshot().status, w.snapshot().error], ["APPROVAL_SUBMITTED", "RECEIPT_PENDING"])
    w.h.chain.finalize()
    assert.equal((await w.check()).status, "READY_TRANSFER", "an explicit check after finality")
    assert.equal(w.sends().length, 1)
  })
})
