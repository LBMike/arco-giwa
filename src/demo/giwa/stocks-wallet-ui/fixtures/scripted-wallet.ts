// VERIFICATION AND TEST FIXTURE ONLY.
//
// Scripted in-memory stand-ins for the wallet module's ports: a fixture "reviewed" deployment, a
// fixture durable journal and fixture server reconciliation, so the panel can be exercised with the
// real controller but without a server, wallet, chain, signature or transfer. The panel module never
// imports this file and nothing here is a production default. Every value is a fixture.

import { decodeFunctionData, sha256, toHex, type Address, type Hex } from "viem"

import { APPROVAL_ABI, STOCKS_ABI_DIGEST } from "../../stocks-wallet/abi"
import { digest, freeze } from "../../stocks-wallet/planner"
import type { AttemptRecord, ExecutionContext, ExecutionPolicy, ManifestV2, Selection, Side, Stage, SubmissionGate, Transaction, WalletPorts } from "../../stocks-wallet/types"
import type { StocksServerOrderStatus, StocksWalletControllerApi } from "../types"

export const FIXTURE_START = Date.UTC(2026, 8, 17, 0, 0, 0)
export const FIXTURE_WALLETS = { A: "0x1111111111111111111111111111111111111111", B: "0x2222222222222222222222222222222222222222" } as const
export type FixtureAccount = keyof typeof FIXTURE_WALLETS

/** hash: returns a hash · hold: wallet prompt stays open until released · reject: provider error · invalid: malformed result */
export type FixtureWalletMode = "hash" | "hold" | "reject" | "invalid"
/** Fixture server verification outcome for a submitted approval. */
export type FixtureReconcileMode = "confirm" | "pending" | "revert"
export type FixtureOptionalPort = "readExecutionPolicy" | "reconcile"

type OrderSpec = { id: string; side: Side; account: FixtureAccount; quantity: string; cashAmount: string }

export const FIXTURE_ORDERS: readonly OrderSpec[] = [
  // 2.5 NVDA at the fixed mock price 120 → 300 test cash (BUY rounds up).
  { id: "fixture-order-a-buy-1", side: "BUY", account: "A", quantity: "2500000000", cashAmount: "300000000" },
  // 0.123456789 NVDA → 14.814814 test cash (SELL rounds down).
  { id: "fixture-order-a-sell-1", side: "SELL", account: "A", quantity: "123456789", cashAmount: "14814814" },
  // The smallest order: 1 base unit NVDA → 1 base unit of test cash (0.000001), never shown as 0.
  { id: "fixture-order-b-buy-1", side: "BUY", account: "B", quantity: "1", cashAmount: "1" },
]

const DAY = 86_400_000
const PROFILE = { profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" } as const

const address = (digit: string) => `0x${digit.repeat(40)}` as Address
const bytes32 = (digit: string) => `0x${digit.repeat(64)}` as Hex

export function fixtureManifest(): ManifestV2 {
  const contracts = [address("3"), address("4"), address("5"), address("6"), address("7")]
  return {
    schemaVersion: 2,
    redemptionEscrow: contracts[4]!,
    deploymentId: "fixture-deployment-1",
    profile: "DEMO_TESTNET",
    chainId: 91342,
    networkInstance: "fixture-giwa-sepolia-1",
    checkpointNumber: "1",
    checkpointHash: bytes32("a"),
    abiDigest: STOCKS_ABI_DIGEST,
    finalityPolicy: "FINALIZED",
    cashToken: contracts[0]!,
    cashSymbol: "ARCO_TEST_USDC",
    cashScale: 6,
    stockToken: contracts[1]!,
    quantityScale: 9,
    fundingVault: contracts[2]!,
    mintController: contracts[3]!,
    signerAddress: address("8"),
    codeHashes: Object.fromEntries(contracts.map((contract) => [contract, bytes32("b")])),
    restrictedTransfers: true,
    nonUpgradeable: true,
  }
}

export type ScriptedWalletOptions = {
  /** Fixture wall-clock origin. Default FIXTURE_START. */
  start?: number
  /** true: the fixture clock follows real elapsed time (verification page). false: manual (tests). */
  realTime?: boolean
  /** Quote lifetime of every fixture order. Default 10 minutes. */
  quoteTtlMs?: number
}

export function createScriptedWallet(options: ScriptedWalletOptions = {}) {
  const start = options.start ?? FIXTURE_START
  const realStart = Date.now()
  const quoteTtlMs = options.quoteTtlMs ?? 600_000
  const manifest = fixtureManifest()
  const manifestDigest = digest(manifest)

  let offset = 0
  let account: FixtureAccount = "A"
  let epoch = 1
  let sessionSeq = 1
  let signedIn = true
  let reviewed = true
  let policyAllowed = true
  let networkMatches = true
  let walletMode: FixtureWalletMode = "hash"
  let reconcileMode: FixtureReconcileMode = "confirm"
  let claimSeq = 0
  let hashSeq = 0
  let version = 0

  const listeners = new Set<() => void>()
  const allowances = new Map<string, string>()
  const serverStates = new Map<string, string>()
  const journal = new Map<string, AttemptRecord>()
  const intents = new Map<string, string>() // intentKey → orderId, recorded at claim time
  const held: { resolve: () => void; reject: () => void }[] = []
  const requests: Transaction[] = []
  const reads = { context: 0, readWallet: 0, readOrder: 0, readCatalog: 0, readExecutionPolicy: 0, readAllowance: 0, inspect: 0, claim: 0, record: 0, reconcile: 0 }

  const now = () => (options.realTime ? start + (Date.now() - realStart) + offset : start + offset)
  const iso = () => new Date(now()).toISOString()
  const allowanceKey = (owner: string, spender: string, token: string) => [owner, spender, token].map((value) => value.toLowerCase()).join(":")
  const initialState = (side: Side) => (side === "BUY" ? "AWAITING_FUNDING" : "AWAITING_ESCROW")
  const spec = (orderId: string) => FIXTURE_ORDERS.find((order) => order.id === orderId)

  function notify() {
    version++
    listeners.forEach((listener) => listener())
  }

  function buildContext(): ExecutionContext {
    const wallet = FIXTURE_WALLETS[account]
    return {
      session: signedIn ? { id: `fixture-session-${account}-${sessionSeq}`, walletAddress: wallet, chainId: 91342, accessToken: `fixture-token-${account}-${sessionSeq}`, createdAt: start, expiresAt: start + DAY } : null,
      walletAddress: wallet,
      chainId: 91342,
      walletEpoch: `fixture-wallet:${epoch}`,
      apiBase: "https://stocks-api.fixture.invalid",
      deployment: reviewed ? { status: "VERIFIED", evidenceId: "fixture-review-1", manifestDigest, manifest, verifiedAt: start, validUntil: start + DAY } : null,
    }
  }
  let context = buildContext()
  function changed() {
    context = buildContext()
    notify()
  }

  function row(order: OrderSpec, state: string) {
    return {
      id: order.id,
      orderKey: sha256(toHex(`${order.side === "SELL" ? "sell:" : ""}${manifest.networkInstance}:${order.id}`)),
      quoteId: `quote-${order.id}`,
      actorId: `actor-${order.account.toLowerCase()}`,
      wallet: FIXTURE_WALLETS[order.account],
      symbol: "NVDA",
      quantity: order.quantity,
      cashAmount: order.cashAmount,
      deploymentId: manifest.deploymentId,
      deploymentDigest: manifestDigest,
      quoteExpiresAt: new Date(start + quoteTtlMs).toISOString(),
      state,
      version: 0,
      idempotencyKey: `request-${order.id}`,
    }
  }

  const selections = new Map<string, Selection>()
  function selection(orderId: string): Selection {
    const order = spec(orderId)
    if (!order) throw new Error(`FIXTURE_UNKNOWN_ORDER ${orderId}`)
    let value = selections.get(orderId)
    if (!value) {
      // The ACCEPTED create-order row: later server progress is reported separately.
      value = Object.freeze({ side: order.side, order: Object.freeze(row(order, initialState(order.side))) })
      selections.set(orderId, value)
    }
    return value
  }

  const gate: SubmissionGate = {
    async inspect(intentKey) {
      reads.inspect++
      return { approval: journal.get(`${intentKey}:APPROVAL`) ?? null, transfer: journal.get(`${intentKey}:TRANSFER`) ?? null }
    },
    async claim(request) {
      reads.claim++
      const key = `${request.intentKey}:${request.stage}`
      if (journal.has(key)) return null
      intents.set(request.intentKey, request.orderId)
      const claim: AttemptRecord = freeze({ claimId: `fixture-claim-${++claimSeq}`, intentKey: request.intentKey, stage: request.stage, transactionDigest: request.transactionDigest, status: "REQUEST_MAY_START" })
      journal.set(key, claim)
      return claim
    },
    async record(value) {
      reads.record++
      const key = `${value.intentKey}:${value.stage}`
      const previous = journal.get(key)
      if (!previous || previous.claimId !== value.claimId) throw new Error("FIXTURE_UNKNOWN_CLAIM")
      if (value.status !== "UNKNOWN" && value.status !== "SUBMITTED") throw new Error("FIXTURE_CLIENT_TERMINAL_FORBIDDEN")
      if (previous.status === "CONFIRMED" || previous.status === "REVERTED" || (previous.txHash && value.status === "UNKNOWN")) return
      journal.set(key, freeze(value))
    },
    // Fixture of the trusted SERVER reconciliation port (never a wallet receipt).
    async reconcile(request) {
      reads.reconcile++
      const key = `${request.intentKey}:${request.stage}`
      const previous = journal.get(key)
      if (!previous || previous.claimId !== request.claimId || previous.txHash !== request.txHash) throw new Error("FIXTURE_RECONCILE_MISMATCH")
      if (previous.status === "CONFIRMED" || previous.status === "REVERTED" || reconcileMode === "pending") return previous
      const next: AttemptRecord = freeze({ ...previous, status: reconcileMode === "revert" ? "REVERTED" : "CONFIRMED" })
      journal.set(key, next)
      return next
    },
  }

  const approvals = new Map<Hex, Transaction>()
  const ports: WalletPorts = {
    context: () => {
      reads.context++
      return context
    },
    now,
    async readWallet() {
      reads.readWallet++
      return {
        address: context.walletAddress!,
        chainId: 91342,
        connectionEpoch: context.walletEpoch,
        deploymentDigest: manifestDigest,
        networkInstance: networkMatches ? manifest.networkInstance : "fixture-other-network",
        checkpointHash: manifest.checkpointHash,
      }
    },
    async readOrder(request) {
      reads.readOrder++
      const order = spec(request.orderId)
      if (!order || FIXTURE_WALLETS[order.account] !== context.session?.walletAddress) throw Object.assign(new Error("FIXTURE_ORDER_NOT_FOUND"), { status: 404 })
      const { ...data } = row(order, serverStates.get(order.id) ?? initialState(order.side))
      return { ...PROFILE, observedAt: iso(), data }
    },
    async readCatalog() {
      reads.readCatalog++
      return {
        ...PROFILE,
        observedAt: iso(),
        deploymentId: manifest.deploymentId,
        cashSymbol: "ARCO_TEST_USDC",
        instruments: [{ symbol: "NVDA", quantityScale: 9, price: "120.000000", priceSource: "FIXED_MOCK_PRICE", orderCapability: "CHECK_PAUSE_AT_ORDER" }],
      }
    },
    async readExecutionPolicy(request) {
      reads.readExecutionPolicy++
      const at = now()
      return { allowed: policyAllowed, deploymentDigest: manifestDigest, orderId: request.orderId, side: request.side, observedAt: at, validUntil: at + 15_000 } as ExecutionPolicy
    },
    async readAllowance(request) {
      reads.readAllowance++
      return allowances.get(allowanceKey(request.owner, request.spender, request.token)) ?? "0"
    },
    async requestTransaction(transaction) {
      requests.push(transaction)
      notify()
      if (walletMode === "reject") throw Object.assign(new Error("Fixture wallet rejected the request."), { code: 4001 })
      if (walletMode === "invalid") return "0x1234"
      const hash = sha256(toHex(`fixture-transaction-${++hashSeq}`))
      if (transaction.to.toLowerCase() === manifest.cashToken.toLowerCase() || transaction.to.toLowerCase() === manifest.stockToken.toLowerCase()) approvals.set(hash, transaction)
      if (walletMode === "hold") {
        return new Promise<string>((resolve, reject) => {
          held.push({ resolve: () => resolve(hash), reject: () => reject(Object.assign(new Error("Fixture wallet rejected the request."), { code: 4001 })) })
          notify()
        })
      }
      return hash
    },
    async waitApprovalReceipt() {
      throw new Error("FIXTURE_LEGACY_RECEIPT_PORT_NOT_USED")
    },
    submissions: {
      inspect: (intentKey) => gate.inspect(intentKey),
      claim: (request) => gate.claim(request),
      record: (value) => gate.record(value),
      async reconcile(request) {
        const result = await gate.reconcile!(request)
        // A confirmed approval moves the fixture chain allowance to exactly the approved amount.
        const approval = approvals.get(request.txHash)
        if (result.status === "CONFIRMED" && request.stage === "APPROVAL" && approval) {
          const decoded = decodeFunctionData({ abi: APPROVAL_ABI, data: approval.data })
          const [spender, value] = decoded.args as readonly [Address, bigint]
          allowances.set(allowanceKey(approval.from, spender, approval.to), value.toString())
        }
        return result
      },
    },
  }
  // Keep the originals so a verification control can remove and restore an optional port.
  const optional = { readExecutionPolicy: ports.readExecutionPolicy, reconcile: ports.submissions.reconcile }

  function intentOf(orderId: string, stage: Stage): string | null {
    for (const [intentKey, id] of intents) if (id === orderId && journal.has(`${intentKey}:${stage}`)) return intentKey
    return null
  }

  return {
    ports,
    manifest,
    requests,
    reads,
    now,
    context: () => context,
    selection,
    ordersFor: (who: FixtureAccount) => FIXTURE_ORDERS.filter((order) => order.account === who).map((order) => order.id),
    journal: () => new Map(journal),
    serverOrder(orderId: string): StocksServerOrderStatus {
      const order = spec(orderId)
      if (!order) throw new Error(`FIXTURE_UNKNOWN_ORDER ${orderId}`)
      return Object.freeze({ orderId, side: order.side, state: serverStates.get(orderId) ?? initialState(order.side), observedAt: iso() })
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    state: () => ({ account, signedIn, reviewed, policyAllowed, networkMatches, walletMode, reconcileMode, held: held.length, offset }),
    controls: {
      setAccount(next: FixtureAccount) {
        if (next === account) return
        account = next
        epoch++
        sessionSeq++
        changed()
      },
      /** Same address, replaced wallet connection (A→A with a new epoch). */
      reconnect() {
        epoch++
        changed()
      },
      setSignedIn(value: boolean) {
        signedIn = value
        if (value) sessionSeq++
        changed()
      },
      setReviewed(value: boolean) {
        reviewed = value
        changed()
      },
      setPolicyAllowed(value: boolean) {
        policyAllowed = value
        notify()
      },
      setNetworkMatches(value: boolean) {
        networkMatches = value
        notify()
      },
      setPortPresent(port: FixtureOptionalPort, present: boolean) {
        const target = port === "reconcile" ? (ports.submissions as Record<string, unknown>) : (ports as unknown as Record<string, unknown>)
        if (present) target[port] = optional[port]
        else delete target[port]
        notify()
      },
      setWalletMode(mode: FixtureWalletMode) {
        walletMode = mode
        notify()
      },
      setReconcileMode(mode: FixtureReconcileMode) {
        reconcileMode = mode
        notify()
      },
      setAllowance(orderId: string, value: string) {
        const order = spec(orderId)
        if (!order) throw new Error(`FIXTURE_UNKNOWN_ORDER ${orderId}`)
        const buy = order.side === "BUY"
        allowances.set(allowanceKey(FIXTURE_WALLETS[order.account], buy ? manifest.fundingVault : manifest.redemptionEscrow, buy ? manifest.cashToken : manifest.stockToken), value)
        notify()
      },
      advance(ms: number) {
        offset += ms
        changed()
      },
      setServerState(orderId: string, state: string) {
        serverStates.set(orderId, state)
        notify()
      },
      releaseHeld() {
        held.splice(0).forEach((entry) => entry.resolve())
        notify()
      },
      rejectHeld() {
        held.splice(0).forEach((entry) => entry.reject())
        notify()
      },
      /** Fixture server-side reconciliation marks a recorded deposit/escrow as reverted. */
      revertTransfer(orderId: string): boolean {
        const intentKey = intentOf(orderId, "TRANSFER")
        const record = intentKey ? journal.get(`${intentKey}:TRANSFER`) : undefined
        if (!intentKey || !record?.txHash) return false
        journal.set(`${intentKey}:TRANSFER`, freeze({ ...record, status: "REVERTED" }))
        notify()
        return true
      },
    },
  }
}

export type ScriptedWallet = ReturnType<typeof createScriptedWallet>

/** Counts explicit controller action calls so a page or test can show they only follow clicks. */
export function countControllerActions(controller: StocksWalletControllerApi) {
  const calls = { prepare: 0, approve: 0, submit: 0 }
  const api: StocksWalletControllerApi = {
    select: (value) => controller.select(value),
    refreshContext: () => controller.refreshContext(),
    getSnapshot: () => controller.getSnapshot(),
    subscribe: (listener) => controller.subscribe(listener),
    prepare: () => {
      calls.prepare++
      return controller.prepare()
    },
    approve: () => {
      calls.approve++
      return controller.approve()
    },
    submit: () => {
      calls.submit++
      return controller.submit()
    },
  }
  return { api, calls }
}
