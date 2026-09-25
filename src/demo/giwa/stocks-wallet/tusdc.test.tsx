import assert from "node:assert/strict"
import test from "node:test"
import { decodeFunctionData } from "viem"
import { manifestDigest, validateManifest } from "../../../../server/src/stocks/contracts"
import { catalog, envelope, evidence, manifest, START } from "../stocks-wallet-http/test-support"
import { acceptDeployment } from "../stocks-wallet-http/validate"
import { derivePanelModel, IDLE_SNAPSHOT } from "../stocks-wallet-ui/model"
import { APPROVAL_ABI, STOCKS_ABI } from "./abi"
import { createStocksWalletController } from "./controller"
import { digest, planOrder, validateDeployment } from "./planner"
import { tusdcFixture } from "./tusdc-fixture"
import { PLATFORM_TUSDC, type ReviewedDeployment, type WalletPorts } from "./types"

test("v3 accepts the server's full cash identity and commits its digest; v2 digest/acceptance remains unchanged", () => {
  const f = tusdcFixture()
  validateManifest(f.m)
  assert.equal(digest(f.m), manifestDigest(f.m))
  const accepted = acceptDeployment(envelope(f.deployment), { wall: START, effective: START }, null)
  assert.deepEqual(accepted.manifest, f.m)
  assert.ok(Object.isFrozen(accepted.manifest.cashIdentity))
  assert.equal(digest(manifest()), manifestDigest(manifest()))
  assert.deepEqual(acceptDeployment(envelope(evidence()), { wall: START, effective: START }, null).manifest, manifest())
})

test("v3 BUY approves/deposits existing tUSDC, SELL still escrows stock and displays tUSDC payout", () => {
  for (const side of ["BUY", "SELL"] as const) {
    const f = tusdcFixture(side), plan = planOrder(f.selection, f.context, START)
    assert.equal(plan.cashSymbol, "tUSDC")
    assert.equal(plan.token.toLowerCase(), side === "BUY" ? PLATFORM_TUSDC : f.m.stockToken.toLowerCase())
    const approval = decodeFunctionData({ abi: APPROVAL_ABI, data: plan.approval.data })
    assert.equal(approval.functionName, "approve")
    assert.equal(approval.args[1], BigInt(plan.amount))
    const transfer = decodeFunctionData({ abi: STOCKS_ABI, data: plan.transfer.data })
    assert.equal(transfer.functionName, side === "BUY" ? "depositForOrder" : "escrowForOrder")
    const panel = derivePanelModel({ snapshot: IDLE_SNAPSHOT, selection: f.selection, account: f.wallet, now: START, availability: { status: "READY", plan } })
    assert.equal(panel.order?.cashSymbol, "tUSDC")
    assert.equal(side === "BUY" ? panel.order?.transfer.text : panel.order?.payout?.text, "120 tUSDC")
  }
})

test("v3 fails closed for legacy cash, missing/proxy identity, hybrid flags and extra HTTP fields", () => {
  const f = tusdcFixture()
  const mutations = [
    { cashToken: manifest().cashToken }, { cashSymbol: "ARCO_TEST_USDC" }, { nonUpgradeable: true }, { stockContractsNonUpgradeable: false },
    { cashIdentity: undefined }, { cashIdentity: { ...f.m.cashIdentity, implementation: PLATFORM_TUSDC } },
    { cashIdentity: { ...f.m.cashIdentity, proxyAdminCodeHash: "0x00" } },
    { cashIdentity: { ...f.m.cashIdentity, unexpected: "no" } },
  ]
  for (const change of mutations) {
    const m = { ...f.m, ...change }
    const d = { ...f.deployment, manifest: m, manifestDigest: digest(m) } as unknown as ReviewedDeployment
    assert.throws(() => validateDeployment(d, START))
    assert.throws(() => acceptDeployment(envelope(d), { wall: START, effective: START }, null))
  }
  for (const change of [{ extra: true }, { codeHashes: { ...f.m.codeHashes, [f.m.cashIdentity.implementation]: f.m.cashIdentity.implementationCodeHash } }]) {
    const m = { ...f.m, ...change }
    assert.throws(() => acceptDeployment(envelope({ ...f.deployment, manifest: m, manifestDigest: digest(m) }), { wall: START, effective: START }, null))
  }
  // Identity cannot be stripped or changed while retaining approval under the old digest.
  assert.throws(() => validateDeployment({ ...f.deployment, manifest: { ...f.m, cashIdentity: { ...f.m.cashIdentity, implementation: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const } } }, START), /MANIFEST_DIGEST_MISMATCH/)
  assert.throws(() => validateDeployment({ ...f.deployment, manifest: { ...manifest(), cashIdentity: f.m.cashIdentity } } as unknown as ReviewedDeployment, START))
})

test("catalog cash must match the reviewed v3 plan before even reading allowance", async () => {
  const f = tusdcFixture()
  let allowanceReads = 0, sends = 0
  const ports: WalletPorts = {
    context: () => f.context, now: () => START, monotonicNow: () => START,
    async readWallet() { return { address: f.wallet, chainId: 91342, connectionEpoch: f.context.walletEpoch, deploymentDigest: f.deployment.manifestDigest, networkInstance: f.m.networkInstance, checkpointHash: f.m.checkpointHash } },
    async readCatalog() { return catalog() }, async readOrder() { return envelope(f.selection.order) },
    async readExecutionPolicy() { return { allowed: true, deploymentDigest: f.deployment.manifestDigest, orderId: f.selection.order.id, side: "BUY", observedAt: START, validUntil: START + 14000 } },
    async readAllowance() { allowanceReads++; return "0" }, async requestTransaction() { sends++; throw Error("unexpected") }, async waitApprovalReceipt() { throw Error("unexpected") },
    submissions: { async inspect() { return { approval: null, transfer: null } }, async claim() { throw Error("unexpected") }, async record() { throw Error("unexpected") } },
  }
  const controller = createStocksWalletController(ports)
  controller.select(f.selection)
  await controller.prepare()
  assert.equal(controller.getSnapshot().error, "CATALOG_MISMATCH")
  assert.equal(allowanceReads, 0); assert.equal(sends, 0)
  ports.readCatalog = async () => ({ ...catalog(), cashSymbol: "tUSDC" })
  await controller.prepare()
  assert.equal(controller.getSnapshot().status, "APPROVAL_REQUIRED")
  assert.equal(allowanceReads, 1); assert.equal(sends, 0)
  controller.dispose()
})
