import assert from "node:assert/strict"
import test from "node:test"
import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { DemoPresentationContext } from "../demo-presentation"
import { tusdcFixture } from "../stocks-wallet/tusdc-fixture"
import { PLATFORM_TUSDC } from "../stocks-wallet/types"
import { evidence } from "../stocks-wallet-http/test-support"
import { classifyFaucet, readTusdcFunding, readWalletTusdc, type FaucetFacts, type FundingBlock, type FundingRpc, type WalletCashRpc } from "./funding-read"
import { faucetMessage, sameFundingScope, StocksFundingStatus, type WalletCashStatus } from "./funding-status"
import type { ExecutionHostView } from "../stocks-execution-host/registry"

const facts: FaucetFacts = { config: [1000000000n, 10000000000n, 100000000000n, 86400n, true], lastDrip: 0n, today: 0n, total: 0n, paused: false, dripAllPaused: false }
const block: FundingBlock = { number: 20n, hash: `0x${"a".repeat(64)}`, timestamp: 1800000000n }
function setup() {
  const f = tusdcFixture(), owners: string[] = []
  let current = true
  const rpc: FundingRpc = {
    async chainId() { return 91342 }, async block(n) { return n === undefined ? block : { ...block, number: n, hash: f.m.checkpointHash } },
    async token(token, owner, n) { assert.equal(token.toLowerCase(), f.m.cashToken); assert.equal(n, block.number); owners.push(owner.toLowerCase()); return { balance: owner.toLowerCase() === f.wallet.toLowerCase() ? 2000000001n : 700000000n, decimals: 6, symbol: "tUSDC" } },
    async gas(_owner, n) { assert.equal(n, block.number); return 1000000000000000n }, async faucet() { return facts },
  }
  const options = { deployment: f.deployment, wallet: f.wallet, rpc, current: () => current, now: () => f.now }
  return { f, rpc, owners, options, end: () => { current = false } }
}

test("two customer addresses read their own exact tUSDC and gas at the same GIWA block", async () => {
  const h = setup(), a = await readTusdcFunding(h.options)
  const b = await readTusdcFunding({ ...h.options, wallet: "0x2222222222222222222222222222222222222222" })
  assert.equal(a.balance, "2000000001"); assert.equal(b.balance, "700000000")
  assert.equal(a.faucet.status, "AVAILABLE"); assert.equal(a.gas, "1000000000000000")
  assert.equal(new Set(h.owners).size, 2)
  // The verified deployment's addresses the one-click trade approves and reads allowances for.
  assert.deepEqual([a.cashToken, a.fundingVault, a.redemptionEscrow, a.stockToken], [h.f.m.cashToken, h.f.m.fundingVault, h.f.m.redemptionEscrow, h.f.m.stockToken].map((value) => value.toLowerCase()))
})

test("v2, another chain/checkpoint, bad token identity, RPC failure and changed wallet never become balances", async () => {
  const legacy = setup()
  await assert.rejects(readTusdcFunding({ ...legacy.options, deployment: evidence() as typeof legacy.f.deployment }))
  assert.equal(legacy.owners.length, 0)
  for (const patch of [
    { chainId: async () => 1 }, { block: async () => ({ ...block, hash: `0x${"b".repeat(64)}` as const }) },
    { token: async () => ({ balance: 2000n, decimals: 18, symbol: "tUSDC" }) },
    { token: async () => ({ balance: 2000n, decimals: 6, symbol: "ARCO_TEST_USDC" }) },
    { token: async () => { throw Error("offline") } },
  ]) {
    const h = setup(); Object.assign(h.rpc, patch)
    await assert.rejects(readTusdcFunding(h.options))
  }
  const h = setup()
  let finish!: (value: { balance: bigint; decimals: number; symbol: string }) => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  h.rpc.token = () => { started(); return new Promise(resolve => { finish = resolve }) }
  const running = readTusdcFunding(h.options)
  await entered; h.end(); finish({ balance: 999999n, decimals: 6, symbol: "tUSDC" })
  await assert.rejects(running, /CONTEXT_CHANGED/)
})

test("faucet reads distinguish cooldown, capacity, pause and unavailable without faking a balance failure", async () => {
  const cooldown = classifyFaucet({ ...facts, lastDrip: block.timestamp - 1n }, block)
  assert.equal(cooldown.status, "COOLDOWN")
  assert.equal(cooldown.remainingSeconds, "86399")
  assert.equal(faucetMessage({ cashSymbol: "tUSDC", balance: "0", gas: "0", blockNumber: "20", faucet: cooldown, cashToken: PLATFORM_TUSDC, fundingVault: VAULT, redemptionEscrow: ESCROW, stockToken: STOCK }), "Mint cooldown: 23h 59m 59s remaining at the last balance check.")
  const largeTimestamp = 9007199254740993n
  assert.equal(classifyFaucet({ ...facts, lastDrip: largeTimestamp }, { ...block, timestamp: largeTimestamp + 86399n }).remainingSeconds, "1")
  assert.equal(classifyFaucet({ ...facts, lastDrip: largeTimestamp }, { ...block, timestamp: largeTimestamp + 86400n }).status, "AVAILABLE")
  assert.equal(classifyFaucet({ ...facts, today: facts.config[1] }, block).status, "DAILY_CAP")
  assert.equal(classifyFaucet({ ...facts, total: facts.config[2] }, block).status, "TOTAL_CAP")
  assert.equal(classifyFaucet({ ...facts, paused: true }, block).status, "PAUSED")
  assert.equal(classifyFaucet({ ...facts, dripAllPaused: true }, block).status, "PAUSED")
  assert.equal(classifyFaucet({ ...facts, config: [1n, 2n, 3n, 0n, false] }, block).status, "DISABLED")
  const h = setup(); h.rpc.faucet = async () => { throw Error("offline") }
  const value = await readTusdcFunding(h.options)
  assert.equal(value.balance, "2000000001"); assert.equal(value.faucet.status, "UNAVAILABLE")
  const html = renderToStaticMarkup(<StocksFundingStatus funding={{ data: { ...value, gas: "0" }, status: "ready", refresh() {} }} requiredCash="3000000000" />)
  assert.match(html, /Insufficient USDC/); assert.match(html, /Add GIWA test ETH/); assert.match(html, /could not be checked/)
})

test("funding scope rejects wallet, chain, epoch, API, session and source changes", () => {
  const f = tusdcFixture()
  const view: ExecutionHostView = { apiBase: f.context.apiBase, session: f.context.session, wallet: { address: f.wallet, chainId: 91342, epoch: "1", source: null } }
  assert.equal(sameFundingScope(view, view, f.now), true)
  for (const next of [
    { ...view, apiBase: "https://other.test" }, { ...view, session: null },
    { ...view, session: { ...view.session!, id: "new-session" } },
    { ...view, wallet: { ...view.wallet, address: "0x2222222222222222222222222222222222222222" } },
    { ...view, wallet: { ...view.wallet, chainId: 1 } }, { ...view, wallet: { ...view.wallet, epoch: "2" } },
  ]) assert.equal(sameFundingScope(view, next, f.now), false)
  assert.equal(sameFundingScope(view, view, f.context.session!.expiresAt), false)
})

const WALLET = "0x3185f0eFB95228c9E476De5C9da1d1aA8ccf76D2"
const VAULT = "0xfee20054736ef175afadfda59e3c7250d28ec707"
const ESCROW = "0x1111111111111111111111111111111111111111"
const STOCK = "0x2222222222222222222222222222222222222222"
const NO_APPROVALS = { spender: null, allowance: null, stockBalance: null, stockSpender: null, stockAllowance: null }
function walletRpc(overrides: Partial<WalletCashRpc> = {}) {
  const reads: { token: string; owner: string; block: bigint }[] = []
  const rpc: WalletCashRpc = {
    async chainId() { return 91342 },
    async latestBlock() { return 36979608n },
    async token(token, owner, block) { reads.push({ token: token.toLowerCase(), owner: owner.toLowerCase(), block }); return { balance: 2000000000n, decimals: 6, symbol: "tUSDC" } },
    ...overrides,
  }
  return { rpc, reads }
}

test("without a Stocks session the connected wallet's platform tUSDC is read at one head block", async () => {
  const { rpc, reads } = walletRpc()
  assert.deepEqual(await readWalletTusdc({ wallet: WALLET, rpc, current: () => true }), { cashSymbol: "tUSDC", balance: "2000000000", blockNumber: "36979608", ...NO_APPROVALS })
  assert.deepEqual(reads, [{ token: PLATFORM_TUSDC, owner: WALLET.toLowerCase(), block: 36979608n }])
})

test("after sign-in the same head-block read adds the allowances given to the verified vault and escrow, and the wallet's NVDA", async () => {
  const allowances: { token: string; owner: string; spender: string; block: bigint }[] = []
  const { rpc, reads } = walletRpc({
    async token(token, owner, block) {
      reads.push({ token: token.toLowerCase(), owner: owner.toLowerCase(), block })
      return token.toLowerCase() === STOCK ? { balance: 500000000n, decimals: 9, symbol: "ARCO_TEST_NVDA" } : { balance: 2000000000n, decimals: 6, symbol: "tUSDC" }
    },
    async allowance(token, owner, spender, block) {
      allowances.push({ token: token.toLowerCase(), owner: owner.toLowerCase(), spender: spender.toLowerCase(), block })
      return token.toLowerCase() === STOCK ? 0n : 2n ** 256n - 1n
    },
  })
  const read = await readWalletTusdc({ wallet: WALLET, rpc, current: () => true, spender: VAULT, stock: { token: STOCK, spender: ESCROW } })
  assert.deepEqual(read, {
    cashSymbol: "tUSDC", balance: "2000000000", blockNumber: "36979608", spender: VAULT, allowance: (2n ** 256n - 1n).toString(),
    stockBalance: "500000000", stockSpender: ESCROW, stockAllowance: "0",
  })
  assert.deepEqual(allowances, [
    { token: PLATFORM_TUSDC, owner: WALLET.toLowerCase(), spender: VAULT, block: 36979608n },
    { token: STOCK, owner: WALLET.toLowerCase(), spender: ESCROW, block: 36979608n },
  ])
  assert.ok(reads.every((entry) => entry.block === 36979608n))
  // A token that is not 9-decimal NVDA is not shown as the wallet's NVDA.
  const wrong = walletRpc({ async token(token) { return token.toLowerCase() === STOCK ? { balance: 1n, decimals: 6, symbol: "X" } : { balance: 1n, decimals: 6, symbol: "tUSDC" } } })
  await assert.rejects(readWalletTusdc({ wallet: WALLET, rpc: wrong.rpc, current: () => true, stock: { token: STOCK, spender: ESCROW } }), /INVALID_FUNDING_TOKEN/)
})

test("a wallet read on another chain, with another token identity, a failed RPC or a changed wallet never becomes a balance", async () => {
  const patches: Partial<WalletCashRpc>[] = [
    { chainId: async () => 1 }, { latestBlock: async () => 0n },
    { token: async () => ({ balance: 5n, decimals: 18, symbol: "tUSDC" }) },
    { token: async () => ({ balance: 5n, decimals: 6, symbol: "ARCO_TEST_USDC" }) },
    { token: async () => { throw Error("offline") } },
  ]
  for (const patch of patches) await assert.rejects(readWalletTusdc({ wallet: WALLET, rpc: walletRpc(patch).rpc, current: () => true }))
  await assert.rejects(readWalletTusdc({ wallet: "not-an-address", rpc: walletRpc().rpc, current: () => true }))
  let current = true
  const changed = walletRpc({ latestBlock: async () => { current = false; return 5n } })
  await assert.rejects(readWalletTusdc({ wallet: WALLET, rpc: changed.rpc, current: () => current }), /CONTEXT_CHANGED/)
  assert.equal(changed.reads.length, 0)
})

test("the funding status shows the wallet's tUSDC before sign-in and keeps the balance on screen after sign-in", () => {
  const plain = (node: ReactElement) => renderToStaticMarkup(node).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ")
  const wallet = (status: WalletCashStatus["status"], balance: string | null = null): WalletCashStatus =>
    ({ status, data: balance === null ? null : { cashSymbol: "tUSDC", balance, blockNumber: "36979608", ...NO_APPROVALS }, refresh() {} })
  const signedOut = { data: null, status: "signed-out" as const, refresh() {} }
  // No wallet on GIWA (or no wallet read): connecting one is enough to see the balance, no sign-in needed.
  assert.match(plain(<StocksFundingStatus funding={signedOut} requiredCash={null} />), /Connect a wallet on GIWA Sepolia to see its USDC balance\./)
  assert.match(plain(<StocksFundingStatus funding={signedOut} wallet={wallet("unavailable")} requiredCash={null} />), /Connect a wallet on GIWA Sepolia to see its USDC balance\./)
  // A wallet read: no sign-in prompt for the balance, a refresh action, and a mint hint only for an empty wallet.
  const funded = plain(<StocksFundingStatus funding={signedOut} wallet={wallet("ready", "2000000000")} requiredCash={null} />)
  assert.doesNotMatch(funded, /Connect a wallet|Sign in|no USDC yet/)
  assert.match(funded, /Refresh balance/)
  assert.match(plain(<StocksFundingStatus funding={signedOut} wallet={wallet("ready", "0")} requiredCash={null} />), /This wallet has no USDC yet\. Use Mint test assets to get test cash\./)
  assert.match(plain(<StocksFundingStatus funding={signedOut} wallet={wallet("error")} requiredCash={null} />), /USDC balance could not be read from GIWA\. Refresh to try again\./)
  assert.doesNotMatch(plain(<StocksFundingStatus funding={signedOut} wallet={wallet("loading")} requiredCash={null} />), /Connect a wallet|Sign in|could not/)
  // Signed in: the finalized read can lag a fresh mint by minutes; the quote check uses the balance on screen.
  const verified = { data: { cashSymbol: "tUSDC" as const, balance: "1000000000", gas: "1", blockNumber: "20", faucet: { status: "UNAVAILABLE" as const, amount: null, remainingSeconds: null }, cashToken: PLATFORM_TUSDC, fundingVault: VAULT, redemptionEscrow: ESCROW, stockToken: STOCK }, status: "ready" as const, refresh() {} }
  assert.doesNotMatch(plain(<StocksFundingStatus funding={verified} wallet={wallet("ready", "2000000000")} requiredCash="1500000000" />), /Insufficient/)
  assert.match(plain(<StocksFundingStatus funding={verified} wallet={wallet("ready", "1000000000")} requiredCash="1500000000" />), /Insufficient USDC for this quote/)
  assert.match(plain(<StocksFundingStatus funding={verified} requiredCash="1500000000" />), /Insufficient USDC for this quote/)
  // A failed verified read under a wallet balance names what is missing (gas and faucet), not the balance.
  const failed = plain(<StocksFundingStatus funding={{ data: null, status: "error", refresh() {} }} wallet={wallet("ready", "2000000000")} requiredCash={null} />)
  assert.match(failed, /Gas and faucet status could not be checked\. Refresh to try again\./)
  assert.doesNotMatch(failed, /balance could not be verified/)
  assert.match(plain(<StocksFundingStatus funding={{ data: null, status: "error", refresh() {} }} requiredCash={null} />), /Test cash balance could not be verified/)
})

test("a direct trade's wallet read can add the wallet's GIWA test ETH; a failed gas read leaves it out", async () => {
  const withGas = walletRpc({ gas: async (_owner, block) => { assert.equal(block, 36979608n); return 0n } })
  assert.equal((await readWalletTusdc({ wallet: WALLET, rpc: withGas.rpc, current: () => true, gas: true })).gas, "0")
  assert.equal("gas" in (await readWalletTusdc({ wallet: WALLET, rpc: withGas.rpc, current: () => true })), false, "only when asked for")
  const failing = walletRpc({ gas: async () => { throw Error("offline") } })
  const read = await readWalletTusdc({ wallet: WALLET, rpc: failing.rpc, current: () => true, gas: true })
  assert.equal(read.balance, "2000000000")
  assert.equal("gas" in read, false)
})

test("the customer presentation shows only what the wallet must do: no 'test ETH is present' and no faucet cooldown", () => {
  const plain = (node: ReactElement) => renderToStaticMarkup(<DemoPresentationContext.Provider value>{node}</DemoPresentationContext.Provider>).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ")
  const faucet = { status: "COOLDOWN" as const, amount: "1000000000", remainingSeconds: "43563" }
  const verified = (gas: string) => ({ data: { cashSymbol: "tUSDC" as const, balance: "1000000000", gas, blockNumber: "20", faucet, cashToken: PLATFORM_TUSDC, fundingVault: VAULT, redemptionEscrow: ESCROW, stockToken: STOCK }, status: "ready" as const, refresh() {} })
  const quiet = plain(<StocksFundingStatus funding={verified("1")} requiredCash={null} />)
  assert.doesNotMatch(quiet, /test ETH|cooldown|Mint test assets for/i)
  assert.match(plain(<StocksFundingStatus funding={verified("0")} requiredCash={null} />), /Add GIWA test ETH to this wallet for transaction gas\./)
  // Without a session (a direct trade) the wallet read's own gas says the same.
  const signedOut = { data: null, status: "signed-out" as const, refresh() {} }
  const wallet = (gas?: string): WalletCashStatus => ({ status: "ready", data: { cashSymbol: "tUSDC", balance: "2000000000", blockNumber: "36979608", ...NO_APPROVALS, ...(gas === undefined ? {} : { gas }) }, refresh() {} })
  assert.match(plain(<StocksFundingStatus funding={signedOut} wallet={wallet("0")} requiredCash={null} />), /Add GIWA test ETH/)
  assert.doesNotMatch(plain(<StocksFundingStatus funding={signedOut} wallet={wallet("5")} requiredCash={null} />), /test ETH/)
  assert.match(plain(<StocksFundingStatus funding={signedOut} wallet={wallet()} requiredCash="3000000000" />), /Not enough USDC for this amount\. Use Mint test assets, then refresh the balance\./)
  // The technical preview keeps every check.
  assert.match(renderToStaticMarkup(<StocksFundingStatus funding={verified("1")} requiredCash={null} />), /GIWA test ETH is present/)
})
