import assert from "node:assert/strict"
import test from "node:test"
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem"
import { giwaSepolia } from "../../config"
import { receivedTokenAmount } from "../../contracts"
import { computeQuote, fromAnswer } from "../../price-policy"
import { pendingWithdrawals } from "../../savings-transfer"
import type { GiwaProduct } from "../../types"
import snapshot from "./deployed-giwa.snapshot.json"
import { DemoChain, demoProducts, MINING_MS } from "./demo-chain"
import { DEMO_ARCOUSD_TOKEN, demoArcoUsdConvert, demoSavingsRoutes } from "./demo-routes"
import { createDemoWallet, DEMO_ACCOUNT, type DemoWallet } from "./demo-wallet"

const products = demoProducts(snapshot.catalog as unknown as GiwaProduct[], snapshot.market)
const arcoUsd = products.find((product) => product.productId === "arcousd")!
const usdc = arcoUsd.payment
const config = { account: DEMO_ACCOUNT, products }

const depositAbi = parseAbi(["function deposit(uint256 paymentAssets, uint256 minSharesOut, address recipient) returns (uint256)"])
const redeemAbi = parseAbi([
  "function redeemInstant(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256)",
  "function requestRedeem(uint256 sharesIn, uint256 minAssetsOut, address recipient) returns (uint256)",
  "function claimRedeem(uint256 requestId)",
])
const faucetAbi = parseAbi(["function dripAll()"])

/** The page's public client, its fetch answered by the demo chain the way the preview's fetch guard does. */
function pageClient(rpc: (body: string) => string) {
  return createPublicClient({
    chain: giwaSepolia,
    pollingInterval: 50,
    transport: http(giwaSepolia.rpcUrls.default.http[0], {
      retryCount: 0,
      fetchFn: async (_url, init) => new Response(rpc(String(init?.body)), { headers: { "content-type": "application/json" } }),
    }),
  })
}
const balanceOf = (chain: DemoChain, token: Hex, owner: Hex) =>
  pageClient((body) => chain.respond(body)).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })

async function nextPrompt(wallet: DemoWallet) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const prompt = wallet.getSnapshot().prompt
    if (prompt !== null) return prompt
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("The demo wallet asked nothing")
}
async function rejectsWith(promise: Promise<unknown>, code: number) {
  await assert.rejects(promise, (err: unknown) => (err as { code?: number }).code === code)
}

/** A transaction as the wallet sends it (eth_sendTransaction params). */
const tx = (to: Hex, data: Hex) => ({ from: DEMO_ACCOUNT, to, data })
const approveData = (spender: Hex, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] })

test("demo products are the captured catalog's deployments at their captured NAV", () => {
  assert.deepEqual(
    ["arcousd", "aeth", "axrp"].filter((id) => products.some((product) => product.productId === id)),
    ["arcousd", "aeth", "axrp"],
  )
  assert.equal(usdc.symbol, "tUSDC")
  assert.equal(usdc.decimals, 6)
  assert.equal(arcoUsd.symbol, "arcoUSD")
  assert.equal(arcoUsd.answer, 100_020_000n)
})

test("the demo account starts with test assets and gas; each vault holds about $50K, a tenth of it in the reserve", async () => {
  const chain = new DemoChain(config)
  const client = pageClient((body) => chain.respond(body))
  assert.equal(await balanceOf(chain, usdc.address, DEMO_ACCOUNT), parseUnits("10000", 6))
  assert.equal(await balanceOf(chain, arcoUsd.token, DEMO_ACCOUNT), 0n)
  assert.equal(await client.getBalance({ address: DEMO_ACCOUNT }), parseUnits("0.05", 18))
  assert.equal(await balanceOf(chain, usdc.address, arcoUsd.redemptionVault), parseUnits("5000", 6))
  const supply = await client.readContract({ address: arcoUsd.token, abi: erc20Abi, functionName: "totalSupply" })
  const tvl = Number(formatUnits(supply, 18)) * fromAnswer(arcoUsd.answer)
  assert.ok(Math.abs(tvl - 50_000) < 1, `TVL ${tvl}`)
  assert.equal(await client.readContract({ address: arcoUsd.token, abi: parseAbi(["function greenlistEnforced() view returns (bool)"]), functionName: "greenlistEnforced" }), false)
})

test("a deposit waits for the approval, then mints the shares the page quotes; the receipt carries them", async () => {
  const wallet = createDemoWallet(config, null)
  const client = pageClient(wallet.rpc)
  const signer = createWalletClient({ chain: giwaSepolia, transport: custom(wallet.provider) })
  const amount = parseUnits("1000", 6)

  const connecting = wallet.provider.request<string[]>({ method: "eth_requestAccounts" })
  wallet.confirm((await nextPrompt(wallet)).id)
  assert.deepEqual(await connecting, [DEMO_ACCOUNT])

  await assert.rejects(
    client.simulateContract({ account: DEMO_ACCOUNT, address: arcoUsd.depositVault, abi: depositAbi, functionName: "deposit", args: [amount, 0n, DEMO_ACCOUNT] }),
    /insufficient allowance/,
  )

  const approving = signer.writeContract({ account: DEMO_ACCOUNT, address: usdc.address, abi: erc20Abi, functionName: "approve", args: [arcoUsd.depositVault, maxUint256] })
  const approvePrompt = await nextPrompt(wallet)
  assert.equal(approvePrompt.title, "Approve tUSDC")
  assert.deepEqual(approvePrompt.rows[0], ["Spending cap", "Unlimited"])
  wallet.confirm(approvePrompt.id)
  const approveHash = await approving
  assert.equal(await client.getTransactionReceipt({ hash: approveHash }).catch(() => null), null, "pending until mined")
  assert.equal((await client.waitForTransactionReceipt({ hash: approveHash })).status, "success")
  assert.equal(await client.readContract({ address: usdc.address, abi: erc20Abi, functionName: "allowance", args: [DEMO_ACCOUNT, arcoUsd.depositVault] }), maxUint256)

  const { request } = await client.simulateContract({ account: DEMO_ACCOUNT, address: arcoUsd.depositVault, abi: depositAbi, functionName: "deposit", args: [amount, 0n, DEMO_ACCOUNT] })
  const depositing = signer.writeContract(request)
  const depositPrompt = await nextPrompt(wallet)
  assert.equal(depositPrompt.title, "Deposit 1,000 tUSDC")
  assert.equal(depositPrompt.detail, "Into arcoUSD")
  wallet.confirm(depositPrompt.id)
  const receipt = await client.waitForTransactionReceipt({ hash: await depositing })
  const quote = computeQuote({ payAmount: 1000, price: fromAnswer(arcoUsd.answer), side: "invest" })!
  const received = receivedTokenAmount(receipt, arcoUsd.token, DEMO_ACCOUNT, 18)
  assert.equal(Number(received).toFixed(6), quote.toFixed(6))
  assert.equal(await client.readContract({ address: usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [DEMO_ACCOUNT] }), parseUnits("9000", 6))
  assert.equal(await client.readContract({ address: usdc.address, abi: erc20Abi, functionName: "allowance", args: [DEMO_ACCOUNT, arcoUsd.depositVault] }), maxUint256)
  assert.equal(wallet.getSnapshot().chain.assets.find((asset) => asset.symbol === "tUSDC")?.amount, "9,000")
})

test("an instant withdrawal burns shares and pays from the reserve; past the reserve it must be requested", () => {
  const chain = new DemoChain(config, null, 0)
  const call = (data: Hex, to: Hex) => chain.handle("eth_call", [tx(to, data), "latest"], 0)
  chain.send(tx(usdc.address, approveData(arcoUsd.depositVault, maxUint256)), 0)
  chain.send(tx(arcoUsd.depositVault, encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [parseUnits("9000", 6), 0n, DEMO_ACCOUNT] })), 0)
  const shareBalance = () => BigInt(call(encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [DEMO_ACCOUNT] }), arcoUsd.token) as Hex)
  const usdcOf = (owner: Hex) => BigInt(call(encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }), usdc.address) as Hex)
  const shares = shareBalance()
  assert.ok(shares > 0n)

  const third = shares / 3n
  chain.send(tx(arcoUsd.redemptionVault, encodeFunctionData({ abi: redeemAbi, functionName: "redeemInstant", args: [third, 0n, DEMO_ACCOUNT] })), 0)
  const paid = (third * arcoUsd.answer) / 100_000_000n / 10n ** 12n
  assert.equal(usdcOf(DEMO_ACCOUNT), parseUnits("1000", 6) + paid)
  assert.equal(usdcOf(arcoUsd.redemptionVault), parseUnits("5000", 6) - paid)

  const rest = shareBalance()
  assert.throws(
    () => call(encodeFunctionData({ abi: redeemAbi, functionName: "redeemInstant", args: [rest, 0n, DEMO_ACCOUNT] }), arcoUsd.redemptionVault),
    (err: unknown) => (err as { code?: number }).code === 3 && /Not enough instant liquidity/.test(String((err as Error).message)),
  )
  const requestHash = chain.send(tx(arcoUsd.redemptionVault, encodeFunctionData({ abi: redeemAbi, functionName: "requestRedeem", args: [rest, 0n, DEMO_ACCOUNT] })), 0)
  assert.equal(shareBalance(), 0n)
  const rows = chain.redemptionsOf(DEMO_ACCOUNT.toLowerCase())!
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, "REQUESTED")
  assert.equal(rows[0]!.sharesIn, rest.toString())
  assert.equal(rows[0]!.lockedAssetsOut, ((rest * arcoUsd.answer) / 100_000_000n / 10n ** 12n).toString())
  assert.equal(rows[0]!.requestedTxHash, requestHash)
  assert.equal(pendingWithdrawals(rows, "arcousd").length, 1)
  assert.equal(chain.redemptionsOf("0x0000000000000000000000000000000000000001"), null)
  assert.equal(chain.view().pendingWithdrawals, 1)
  assert.throws(() => call(encodeFunctionData({ abi: redeemAbi, functionName: "claimRedeem", args: [1n] }), arcoUsd.redemptionVault), /stay pending/)
})

test("a transaction is pending, then mined MINING_MS later into a block the chain has reached", () => {
  const chain = new DemoChain(config, null, 1_000_000)
  const hash = chain.send(tx(usdc.address, approveData(arcoUsd.depositVault, 1n)), 1_000_000)
  const pending = chain.handle("eth_getTransactionByHash", [hash], 1_000_100) as { blockNumber: string | null }
  assert.equal(pending.blockNumber, null)
  assert.equal(chain.handle("eth_getTransactionReceipt", [hash], 1_000_100), null)
  const at = 1_000_000 + MINING_MS
  const receipt = chain.handle("eth_getTransactionReceipt", [hash], at) as { status: string; blockNumber: string; logs: unknown[] }
  assert.equal(receipt.status, "0x1")
  assert.equal(receipt.logs.length, 1, "the Approval log")
  assert.ok(BigInt(receipt.blockNumber) <= BigInt(chain.handle("eth_blockNumber", [], at) as string))
  const block = chain.handle("eth_getBlockByNumber", [receipt.blockNumber, false], at) as { transactions: string[] }
  assert.deepEqual(block.transactions, [hash])
  assert.equal(chain.handle("eth_getTransactionCount", [DEMO_ACCOUNT, "latest"], at), "0x1")
})

test("the wallet asks before it connects or sends: Reject is a user rejection, and Reset disconnects the page", async () => {
  const wallet = createDemoWallet(config, null)
  const { provider } = wallet
  assert.deepEqual(await provider.request({ method: "eth_accounts" }), [])
  assert.equal(await provider.request({ method: "eth_chainId" }), "0x164ce")

  const refused = provider.request({ method: "eth_requestAccounts" })
  const connectPrompt = await nextPrompt(wallet)
  assert.equal(connectPrompt.kind, "connect")
  wallet.reject(connectPrompt.id)
  await rejectsWith(refused, 4001)
  await rejectsWith(provider.request({ method: "eth_sendTransaction", params: [tx(usdc.address, approveData(arcoUsd.depositVault, 1n))] }), 4100)

  const accepted = provider.request({ method: "eth_requestAccounts" })
  wallet.confirm((await nextPrompt(wallet)).id)
  assert.deepEqual(await accepted, [DEMO_ACCOUNT])
  assert.deepEqual(await provider.request({ method: "eth_requestAccounts" }), [DEMO_ACCOUNT], "connected: no second prompt")
  assert.equal(wallet.getSnapshot().connected, true)

  const sending = provider.request({ method: "eth_sendTransaction", params: [tx(usdc.address, approveData(arcoUsd.depositVault, 1n))] })
  wallet.reject((await nextPrompt(wallet)).id)
  await rejectsWith(sending, 4001)
  assert.equal(await provider.request({ method: "eth_getTransactionCount", params: [DEMO_ACCOUNT, "latest"] }), "0x0", "nothing was sent")

  await rejectsWith(provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }), 4902)
  assert.equal(await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x164CE" }] }), null)
  await rejectsWith(provider.request({ method: "personal_sign", params: ["0x00", DEMO_ACCOUNT] }), 4200)

  const changes: unknown[] = []
  provider.on("accountsChanged", (accounts) => changes.push(accounts))
  const waiting = provider.request({ method: "eth_sendTransaction", params: [tx(usdc.address, approveData(arcoUsd.depositVault, 1n))] })
  await nextPrompt(wallet)
  wallet.reset()
  await rejectsWith(waiting, 4001)
  assert.deepEqual(changes, [[]])
  assert.deepEqual(await provider.request({ method: "eth_accounts" }), [])
  assert.equal(wallet.getSnapshot().prompt, null)
})

test("auto-confirm answers requests by itself", async () => {
  const wallet = createDemoWallet(config, null)
  wallet.setAutoConfirm(true)
  assert.deepEqual(await wallet.provider.request({ method: "eth_requestAccounts" }), [DEMO_ACCOUNT])
  const hash = await wallet.provider.request<string>({ method: "eth_sendTransaction", params: [tx(usdc.address, approveData(arcoUsd.depositVault, 1n))] })
  assert.match(hash, /^0x[0-9a-f]{64}$/)
})

test("the demo lasts for the tab: a new wallet on the same storage has the same balances and connection", async () => {
  const items = new Map<string, string>()
  const storage = {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  } as unknown as Storage
  const first = createDemoWallet(config, storage)
  first.setAutoConfirm(true)
  await first.provider.request({ method: "eth_requestAccounts" })
  await first.provider.request({ method: "eth_sendTransaction", params: [tx(usdc.address, approveData(arcoUsd.depositVault, maxUint256))] })
  await first.provider.request({
    method: "eth_sendTransaction",
    params: [tx(arcoUsd.depositVault, encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [parseUnits("2500", 6), 0n, DEMO_ACCOUNT] }))],
  })
  const second = createDemoWallet(config, storage)
  assert.deepEqual(second.getSnapshot().chain, first.getSnapshot().chain)
  assert.equal(second.getSnapshot().connected, true)
  assert.equal(second.getSnapshot().autoConfirm, true)
  assert.equal(second.getSnapshot().chain.assets.find((asset) => asset.symbol === "tUSDC")?.amount, "7,500")
  second.reset()
  assert.equal(createDemoWallet(config, storage).getSnapshot().chain.assets.find((asset) => asset.symbol === "tUSDC")?.amount, "10,000")
})

test("JSON-RPC: batches, unknown methods and bodies, and calls the demo does not have", () => {
  const chain = new DemoChain(config)
  const batch = JSON.parse(chain.respond(JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 2, method: "eth_mining", params: [] },
  ]))) as { id: number; result?: unknown; error?: { code: number } }[]
  assert.deepEqual(batch[0], { jsonrpc: "2.0", id: 1, result: "0x164ce" })
  assert.equal(batch[1]!.error!.code, -32601)
  assert.equal((JSON.parse(chain.respond("{")) as { error: { code: number } }).error.code, -32700)
  const nowhere = JSON.parse(chain.respond(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "latest"] })))
  assert.equal(nowhere.error.code, 3)
  assert.match(nowhere.error.message, /No contract at this address/)
  assert.match(nowhere.error.data, /^0x08c379a0/)
  const unknown = JSON.parse(chain.respond(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "eth_call", params: [{ to: usdc.address, data: "0x12345678" }, "latest"] })))
  assert.match(unknown.error.message, /not part of the demo/)
})

test("the faucet mints the test assets, and the wallet words each request", () => {
  const chain = new DemoChain(config)
  const faucet = usdc.faucet!
  chain.send(tx(faucet, encodeFunctionData({ abi: faucetAbi, functionName: "dripAll" })))
  assert.equal(chain.view().assets.find((asset) => asset.symbol === "tUSDC")?.amount, "20,000")
  assert.equal(chain.view().assets.find((asset) => asset.symbol === "tWETH")?.amount, "10")
  assert.equal(chain.describe(tx(faucet, encodeFunctionData({ abi: faucetAbi, functionName: "dripAll" }))).title, "Mint test assets")
  const deposit = chain.describe(tx(arcoUsd.depositVault, encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [parseUnits("1234.5", 6), 0n, DEMO_ACCOUNT] })))
  assert.equal(deposit.title, "Deposit 1,234.5 tUSDC")
  assert.deepEqual(deposit.rows[0], ["You receive", "≈ 1,234.253149 arcoUSD"])
  const withdraw = chain.describe(tx(arcoUsd.redemptionVault, encodeFunctionData({ abi: redeemAbi, functionName: "redeemInstant", args: [parseUnits("100", 18), 0n, DEMO_ACCOUNT] })))
  assert.equal(withdraw.title, "Withdraw 100 arcoUSD")
  assert.deepEqual(withdraw.rows[0], ["You receive", "≈ 100.02 tUSDC"])
})

test("demo routes: every other Savings coin, in and out through the vault's own shares at its price", async () => {
  const { products: routes, routes: pageRoutes } = demoSavingsRoutes(snapshot.catalog as unknown as GiwaProduct[], products)
  assert.deepEqual(
    pageRoutes.map((route) => `${route.vault}:${route.option}`),
    ["arcousd:usdc-ethereum", "arcousd:usdt-ethereum", "arcousd:rlusd-ethereum", "arcousd:rlusd-xrpl", "arcousd:arcousd-giwa"],
  )
  assert.deepEqual(
    routes.map((route) => route.payment.symbol),
    ["USDC (Ethereum)", "USDT (Ethereum)", "RLUSD (Ethereum)", "RLUSD (XRPL)", "ArcoUSD (GIWA)"],
  )
  // The pages and the chain agree on every route's coin and contracts; each mints the vault's own shares at its price.
  for (const [index, route] of routes.entries()) {
    const page = pageRoutes[index]!
    assert.deepEqual([page.token, page.depositVault, page.redemptionVault], [route.payment.address, route.depositVault, route.redemptionVault])
    assert.deepEqual([route.productId, route.token, route.priceFeed, route.answer], ["arcousd", arcoUsd.token, arcoUsd.priceFeed, arcoUsd.answer])
  }
  const usdt = routes.find((route) => route.payment.symbol === "USDT (Ethereum)")!
  const rlusd = routes.find((route) => route.payment.symbol === "RLUSD (XRPL)")!
  const chain = new DemoChain({ ...config, routes }, null, 0)
  const client = pageClient((body) => chain.respond(body))
  const supply = () => client.readContract({ address: arcoUsd.token, abi: erc20Abi, functionName: "totalSupply" })
  const supplyBefore = await supply()

  // The wallet starts with 10,000 of each route's coin (its own decimals); a route keeps a tenth of $50K as its reserve.
  assert.equal(await balanceOf(chain, usdt.payment.address, DEMO_ACCOUNT), parseUnits("10000", 6))
  assert.equal(await balanceOf(chain, rlusd.payment.address, DEMO_ACCOUNT), parseUnits("10000", 18))
  assert.equal(await balanceOf(chain, rlusd.payment.address, rlusd.redemptionVault), parseUnits("5000", 18))
  assert.equal(await balanceOf(chain, usdc.address, DEMO_ACCOUNT), parseUnits("10000", 6), "the vault's own coin as before")

  // 1,000 USDT on Ethereum in: the approval and the deposit as the wallet words them, then the shares the vault's price gives.
  const amount = parseUnits("1000", 6)
  const deposit = tx(usdt.depositVault, encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [amount, 0n, DEMO_ACCOUNT] }))
  assert.equal(chain.describe(tx(usdt.payment.address, approveData(usdt.depositVault, maxUint256))).title, "Approve USDT (Ethereum)")
  chain.send(tx(usdt.payment.address, approveData(usdt.depositVault, maxUint256)), 0)
  assert.deepEqual([chain.describe(deposit).title, chain.describe(deposit).detail], ["Deposit 1,000 USDT (Ethereum)", "Into arcoUSD"])
  chain.send(deposit, 0)
  const shares = (amount * 10n ** 12n * 100_000_000n) / arcoUsd.answer
  assert.equal(await balanceOf(chain, arcoUsd.token, DEMO_ACCOUNT), shares)
  assert.equal(await supply(), supplyBefore + shares)
  assert.equal(await balanceOf(chain, usdt.payment.address, DEMO_ACCOUNT), parseUnits("9000", 6))

  // 100 shares out to RLUSD on XRPL, at once from that route's reserve.
  const withdraw = tx(rlusd.redemptionVault, encodeFunctionData({ abi: redeemAbi, functionName: "redeemInstant", args: [parseUnits("100", 18), 0n, DEMO_ACCOUNT] }))
  assert.deepEqual(chain.describe(withdraw).rows[0], ["You receive", "≈ 100.02 RLUSD (XRPL)"])
  chain.send(withdraw, 0)
  assert.equal(await balanceOf(chain, rlusd.payment.address, DEMO_ACCOUNT), parseUnits("10100.02", 18))
  assert.equal(await balanceOf(chain, arcoUsd.token, DEMO_ACCOUNT), shares - parseUnits("100", 18))

  // The wallet window lists each route's coin by coin and chain, and the shares once.
  const view = chain.view()
  assert.equal(view.assets.find((asset) => asset.symbol === "USDT (Ethereum)")?.amount, "9,000")
  assert.equal(view.assets.find((asset) => asset.symbol === "RLUSD (XRPL)")?.amount, "10,100.02")
  assert.deepEqual(view.shares.map((entry) => entry.symbol), ["arcoUSD"])

  // A demo saved before the routes existed gets their coins when it loads, keeps the rest, and gets them only once.
  const before = new DemoChain(config, null, 0)
  before.send(tx(usdc.address, approveData(arcoUsd.depositVault, maxUint256)), 0)
  before.send(tx(arcoUsd.depositVault, encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [amount, 0n, DEMO_ACCOUNT] })), 0)
  const restored = new DemoChain({ ...config, routes }, before.save(), 1_000)
  assert.equal(await balanceOf(restored, usdc.address, DEMO_ACCOUNT), parseUnits("9000", 6))
  assert.equal(await balanceOf(restored, usdt.payment.address, DEMO_ACCOUNT), parseUnits("10000", 6))
  assert.equal(await balanceOf(restored, rlusd.payment.address, rlusd.redemptionVault), parseUnits("5000", 18))
  const again = new DemoChain({ ...config, routes }, restored.save(), 2_000)
  assert.equal(await balanceOf(again, usdt.payment.address, DEMO_ACCOUNT), parseUnits("10000", 6))
})

test("Get ArcoUSD: each coin converts to ArcoUSD one for one at its converter and back; ArcoUSD is also the route's coin", async () => {
  const catalog = snapshot.catalog as unknown as GiwaProduct[]
  const savings = demoSavingsRoutes(catalog, products)
  const demo = demoArcoUsdConvert(catalog, products, savings)!
  // A converter for every coin the stablecoin vault takes but ArcoUSD; the pages and the chain agree on each.
  assert.deepEqual(
    demo.convert.converters.map((entry) => entry.option),
    ["usdc-ethereum", "usdc-giwa", "usdt-ethereum", "rlusd-ethereum", "rlusd-xrpl"],
  )
  for (const [index, product] of demo.products.entries()) {
    const page = demo.convert.converters[index]!
    assert.deepEqual([page.token, page.converter], [product.payment.address, product.depositVault])
    assert.deepEqual([product.redemptionVault, product.token, product.priceFeed, product.answer], [product.depositVault, DEMO_ARCOUSD_TOKEN, demo.convert.priceFeed, 100_000_000n])
  }
  // ArcoUSD is one token: the coin the Savings route takes and what the converters mint. GIWA USDC is the vault's own coin.
  assert.equal(savings.routes.find((route) => route.option === "arcousd-giwa")!.token, demo.convert.token)
  assert.equal(demo.convert.token, DEMO_ARCOUSD_TOKEN)
  assert.equal(demo.convert.converters.find((entry) => entry.option === "usdc-giwa")!.token, usdc.address)

  const chain = new DemoChain({ ...config, routes: savings.products, converters: demo.products }, null, 0)
  const usdt = demo.products.find((product) => product.productId === "arcousd-convert-usdt-ethereum")!
  const rlusd = demo.products.find((product) => product.productId === "arcousd-convert-rlusd-xrpl")!
  const arco = demo.convert.token
  // The wallet starts with 10,000 ArcoUSD (18 decimals); each converter holds 1,000,000 of its coin to pay back.
  assert.equal(await balanceOf(chain, arco, DEMO_ACCOUNT), parseUnits("10000", 18))
  assert.equal(await balanceOf(chain, usdt.payment.address, usdt.depositVault), parseUnits("1000000", 6))
  assert.equal(await balanceOf(chain, usdc.address, demo.products.find((product) => product.payment.address === usdc.address)!.depositVault), parseUnits("1000000", 6))
  const client = pageClient((body) => chain.respond(body))
  const [, answer] = await client.readContract({
    address: usdt.priceFeed,
    abi: parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]),
    functionName: "latestRoundData",
  })
  assert.equal(answer, 100_000_000n, "the peg feed answers one for one")

  // 1,000 USDT on Ethereum to ArcoUSD: the converter is approved, then 1,000 ArcoUSD is minted for the coin.
  const amount = parseUnits("1000", 6)
  const approve = tx(usdt.payment.address, approveData(usdt.depositVault, maxUint256))
  assert.equal(chain.describe(approve).detail, "Lets the ArcoUSD converter use your USDT (Ethereum).")
  chain.send(approve, 0)
  const convertIn = tx(usdt.depositVault, encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [amount, 0n, DEMO_ACCOUNT] }))
  const asked = chain.describe(convertIn)
  assert.deepEqual([asked.title, asked.detail, asked.rows[0]], ["Convert 1,000 USDT (Ethereum)", "Into ArcoUSD (GIWA)", ["You receive", "≈ 1,000 ArcoUSD (GIWA)"]])
  chain.send(convertIn, 0)
  assert.equal(await balanceOf(chain, arco, DEMO_ACCOUNT), parseUnits("11000", 18))
  assert.equal(await balanceOf(chain, usdt.payment.address, DEMO_ACCOUNT), parseUnits("9000", 6))
  assert.equal(await balanceOf(chain, usdt.payment.address, usdt.depositVault), parseUnits("1001000", 6))

  // 500 ArcoUSD back to RLUSD on XRPL, at once and without an approval.
  const convertOut = tx(rlusd.depositVault, encodeFunctionData({ abi: redeemAbi, functionName: "redeemInstant", args: [parseUnits("500", 18), 0n, DEMO_ACCOUNT] }))
  assert.deepEqual([chain.describe(convertOut).title, chain.describe(convertOut).detail], ["Convert 500 ArcoUSD (GIWA)", "Into RLUSD (XRPL)"])
  chain.send(convertOut, 0)
  assert.equal(await balanceOf(chain, arco, DEMO_ACCOUNT), parseUnits("10500", 18))
  assert.equal(await balanceOf(chain, rlusd.payment.address, DEMO_ACCOUNT), parseUnits("10500", 18))
  // A conversion is never a request.
  assert.throws(
    () => chain.send(tx(rlusd.depositVault, encodeFunctionData({ abi: redeemAbi, functionName: "requestRedeem", args: [1n, 0n, DEMO_ACCOUNT] })), 0),
    /A conversion is instant/,
  )
  // The wallet window lists ArcoUSD once, as a coin.
  assert.equal(chain.view().assets.filter((asset) => asset.symbol === "ArcoUSD (GIWA)").length, 1)

  // A demo saved before Get ArcoUSD: ArcoUSD and the converters' coins arrive when it loads, and only once.
  const old = new DemoChain(config, null, 0)
  const restored = new DemoChain({ ...config, routes: savings.products, converters: demo.products }, old.save(), 1_000)
  assert.equal(await balanceOf(restored, arco, DEMO_ACCOUNT), parseUnits("10000", 18))
  assert.equal(await balanceOf(restored, usdt.payment.address, usdt.depositVault), parseUnits("1000000", 6))
  const again = new DemoChain({ ...config, routes: savings.products, converters: demo.products }, restored.save(), 2_000)
  assert.equal(await balanceOf(again, arco, DEMO_ACCOUNT), parseUnits("10000", 18))
  assert.equal(await balanceOf(again, usdt.payment.address, usdt.depositVault), parseUnits("1000000", 6))
})
