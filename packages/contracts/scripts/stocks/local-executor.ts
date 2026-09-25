import { utils } from "ethers"
import type { Artifacts } from "hardhat/types"
import {
  assertPreparedLocalStep,
  verifyPreparedLocalDeployment,
  isExternalCashPlan,
  type LocalUnsignedDeployment,
} from "./local-plan"
import { verifyExternalCashIdentity } from "./verify-external-cash"
import { attestSignedStocksCreate, type SignedCreateFeeLimits } from "./attest-signed-create"
import {
  readLocalCreateIntents,
  persistLocalCreateIntent,
  type LocalCreateIntent,
} from "./local-journal"
import type { DeploymentReadRpc } from "./deployment-http"

type ArtifactsReader = Pick<Artifacts, "readArtifact" | "getBuildInfo">
export type LocalDeploymentApproval = {
  expectedPlanDigest: string
  genesisHash: string
  maxGas: string
  maxPriorityFeePerGas: string
  maxFeePerGas: string
  maxTotalFeeWei: string
}
export type LocalDeploymentContext = {
  plan: unknown
  approval: LocalDeploymentApproval
  expectedDeployer: string
  artifacts: ArtifactsReader
  rpc: DeploymentReadRpc
  journal: string
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code)
}
function row(value: unknown): Record<string, any> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "LOCAL_DEPLOYMENT_RPC_INVALID",
  )
  return value as Record<string, any>
}
function qty(value: unknown): bigint {
  check(
    typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && value.length <= 66,
    "LOCAL_DEPLOYMENT_RPC_INVALID",
  )
  return BigInt(value)
}
function hash(value: unknown): string {
  check(
    typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/.test(value),
    "LOCAL_DEPLOYMENT_RPC_INVALID",
  )
  return value.toLowerCase()
}
function address(value: unknown) {
  check(typeof value === "string" && utils.isAddress(value), "LOCAL_DEPLOYMENT_RPC_INVALID")
  return value.toLowerCase()
}
function bytes(value: unknown) {
  check(
    typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value),
    "LOCAL_DEPLOYMENT_RPC_INVALID",
  )
  return value.toLowerCase()
}
function decimal(value: unknown) {
  check(
    typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value),
    "LOCAL_DEPLOYMENT_APPROVAL_INVALID",
  )
  return BigInt(value)
}
const hex = (value: bigint) => `0x${value.toString(16)}`
function limits(value: LocalDeploymentApproval): SignedCreateFeeLimits {
  check(
    value &&
      Object.keys(value).sort().join(",") ===
        "expectedPlanDigest,genesisHash,maxFeePerGas,maxGas,maxPriorityFeePerGas,maxTotalFeeWei",
    "LOCAL_DEPLOYMENT_APPROVAL_INVALID",
  )
  check(
    typeof value.expectedPlanDigest === "string" && /^[a-f0-9]{64}$/.test(value.expectedPlanDigest),
    "LOCAL_DEPLOYMENT_APPROVAL_INVALID",
  )
  hash(value.genesisHash)
  const result = {
    maxGas: decimal(value.maxGas),
    maxPriorityFeePerGas: decimal(value.maxPriorityFeePerGas),
    maxFeePerGas: decimal(value.maxFeePerGas),
    maxTotalFeeWei: decimal(value.maxTotalFeeWei),
  }
  check(
    result.maxGas > 0n &&
      result.maxFeePerGas > 0n &&
      result.maxTotalFeeWei > 0n &&
      result.maxPriorityFeePerGas <= result.maxFeePerGas,
    "LOCAL_DEPLOYMENT_APPROVAL_INVALID",
  )
  return result
}
async function network(context: LocalDeploymentContext) {
  check(qty(await context.rpc("eth_chainId", [])) === 91342n, "LOCAL_DEPLOYMENT_WRONG_CHAIN")
  const genesis = row(await context.rpc("eth_getBlockByNumber", ["0x0", false]))
  check(
    qty(genesis.number) === 0n && hash(genesis.hash) === context.approval.genesisHash,
    "LOCAL_DEPLOYMENT_WRONG_GENESIS",
  )
}

function externalCashFailure(error: unknown): never {
  if (error instanceof Error) {
    // Preserve only exact sanitized transport/cancellation codes, never provider details.
    if (
      [
        "DEPLOYMENT_RPC_UNAVAILABLE",
        "LOCAL_DEPLOYMENT_RPC_UNAVAILABLE",
        "DEPLOYMENT_RPC_RESPONSE_INVALID",
        "TUSDC_DEPLOYMENT_STOPPED",
      ].includes(error.message)
    )
      throw Error(error.message)
    if (error.name === "AbortError") throw Error("TUSDC_DEPLOYMENT_STOPPED")
  }
  throw Error("LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED")
}

async function externalCashPreflight(
  context: LocalDeploymentContext,
  plan: LocalUnsignedDeployment,
) {
  if (!isExternalCashPlan(plan)) return
  try {
    const expected = plan.input.network
    const anchor = row(
      await context.rpc("eth_getBlockByNumber", [hex(BigInt(expected.checkpointNumber)), false]),
    )
    check(
      qty(anchor.number).toString() === expected.checkpointNumber &&
        hash(anchor.hash) === expected.checkpointHash,
      "LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED",
    )
    for (const head of ["finalized", "latest"]) {
      const current = row(await context.rpc("eth_getBlockByNumber", [head, false]))
      const tag = hex(qty(current.number))
      check(
        qty(current.number) >= BigInt(expected.checkpointNumber),
        "LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED",
      )
      await verifyExternalCashIdentity(plan, context.rpc, tag)
      const again = row(await context.rpc("eth_getBlockByNumber", [tag, false]))
      check(
        hash(again.hash) === hash(current.hash) && qty(again.number) === qty(current.number),
        "LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED",
      )
    }
  } catch (error) {
    externalCashFailure(error)
  }
}

/** Validates every recorded original against one pinned canonical cutoff. */
async function canonicalPrefix(
  plan: LocalUnsignedDeployment,
  entries: LocalCreateIntent[],
  context: LocalDeploymentContext,
  head: "finalized" | "latest",
) {
  const cutoff = row(await context.rpc("eth_getBlockByNumber", [head, false]))
  const cutoffNumber = qty(cutoff.number),
    cutoffHash = hash(cutoff.hash),
    tag = hex(cutoffNumber)
  const completed: Parameters<typeof assertPreparedLocalStep>[2]["completed"] = []
  const blocks: { number: bigint; hash: string }[] = []
  const originals: {
    transactionHash: string
    blockNumber: string
    blockHash: string
    transactionIndex: string
  }[] = []
  let previous: { number: bigint; index: bigint } | undefined
  for (const [index, entry] of entries.entries()) {
    const step = plan.steps[index]
    check(
      entry.planDigest === plan.planDigest &&
        entry.genesisHash === context.approval.genesisHash &&
        entry.deployer === plan.input.deployer &&
        entry.nonce === BigInt(step.transaction.nonce).toString(),
      "LOCAL_DEPLOYMENT_JOURNAL_BINDING_MISMATCH",
    )
    const rawReceipt = await context.rpc("eth_getTransactionReceipt", [entry.transactionHash])
    const rawTx = await context.rpc("eth_getTransactionByHash", [entry.transactionHash])
    check(rawReceipt !== null && rawTx !== null, "LOCAL_DEPLOYMENT_ORIGINAL_UNRESOLVED")
    const receipt = row(rawReceipt),
      tx = row(rawTx)
    check(
      tx.blockNumber !== null && tx.blockHash !== null && tx.transactionIndex !== null,
      "LOCAL_DEPLOYMENT_ORIGINAL_UNRESOLVED",
    )
    const number = qty(receipt.blockNumber),
      transactionIndex = qty(receipt.transactionIndex)
    check(
      number <= cutoffNumber,
      head === "finalized"
        ? "LOCAL_DEPLOYMENT_ORIGINAL_NOT_FINALIZED"
        : "LOCAL_DEPLOYMENT_ORIGINAL_NOT_INCLUDED",
    )
    check(
      hash(receipt.transactionHash) === entry.transactionHash &&
        hash(tx.hash) === entry.transactionHash &&
        qty(receipt.status) === 1n,
      "LOCAL_DEPLOYMENT_ORIGINAL_FAILED",
    )
    check(
      qty(tx.chainId) === 91342n &&
        address(tx.from) === plan.input.deployer &&
        address(receipt.from) === plan.input.deployer &&
        tx.to === null &&
        receipt.to === null &&
        qty(tx.nonce) === BigInt(step.transaction.nonce) &&
        qty(tx.value) === 0n &&
        bytes(tx.input) === step.transaction.data.toLowerCase() &&
        address(receipt.contractAddress) === step.predictedAddress,
      "LOCAL_DEPLOYMENT_ORIGINAL_CHANGED",
    )
    check(
      qty(tx.blockNumber) === number &&
        qty(tx.transactionIndex) === transactionIndex &&
        hash(tx.blockHash) === hash(receipt.blockHash),
      "LOCAL_DEPLOYMENT_ORIGINAL_CHANGED",
    )
    check(
      !previous ||
        number > previous.number ||
        (number === previous.number && transactionIndex > previous.index),
      "LOCAL_DEPLOYMENT_ORDER_CHANGED",
    )
    previous = { number, index: transactionIndex }
    const block = row(await context.rpc("eth_getBlockByNumber", [hex(number), false]))
    check(
      qty(block.number) === number &&
        hash(block.hash) === hash(receipt.blockHash) &&
        Array.isArray(block.transactions) &&
        transactionIndex < BigInt(block.transactions.length) &&
        hash(block.transactions[Number(transactionIndex)]) === entry.transactionHash,
      "LOCAL_DEPLOYMENT_CANONICAL_HISTORY_CHANGED",
    )
    const code = bytes(await context.rpc("eth_getCode", [step.predictedAddress, tag]))
    check(
      code !== "0x" && utils.keccak256(code) === step.expectedRuntimeCodeHash,
      "LOCAL_DEPLOYMENT_RUNTIME_CHANGED",
    )
    blocks.push({ number, hash: hash(block.hash) })
    originals.push({
      transactionHash: entry.transactionHash,
      blockNumber: number.toString(),
      blockHash: hash(block.hash),
      transactionIndex: transactionIndex.toString(),
    })
    completed.push({
      index,
      address: step.predictedAddress,
      runtimeCodeHash: utils.keccak256(code),
    })
  }
  for (const block of [...blocks, { number: cutoffNumber, hash: cutoffHash }]) {
    const again = row(await context.rpc("eth_getBlockByNumber", [hex(block.number), false]))
    check(
      qty(again.number) === block.number && hash(again.hash) === block.hash,
      "LOCAL_DEPLOYMENT_CANONICAL_HISTORY_CHANGED",
    )
  }
  check(
    qty(row(await context.rpc("eth_getBlockByNumber", [head, false])).number) >= cutoffNumber,
    head === "finalized"
      ? "LOCAL_DEPLOYMENT_FINALITY_REGRESSED"
      : "LOCAL_DEPLOYMENT_INCLUSION_REGRESSED",
  )
  return {
    completed,
    inclusionCutoff: { number: cutoffNumber.toString(), hash: cutoffHash },
    originals,
  }
}

export async function inspectLocalDeployment(context: LocalDeploymentContext) {
  const fees = limits(context.approval)
  const plan = await verifyPreparedLocalDeployment(context.plan, context.artifacts)
  check(
    plan.planDigest === context.approval.expectedPlanDigest &&
      plan.input.deployer === address(context.expectedDeployer),
    "LOCAL_DEPLOYMENT_APPROVAL_MISMATCH",
  )
  const entries = await readLocalCreateIntents(context.journal)
  check(entries.length <= plan.steps.length, "LOCAL_DEPLOYMENT_JOURNAL_BINDING_MISMATCH")
  await network(context)
  await externalCashPreflight(context, plan)
  const { completed } = await canonicalPrefix(plan, entries, context, "finalized")
  await network(context)
  if (entries.length === plan.steps.length) return { plan, fees, entries, completed, next: null }
  const pendingNonce = qty(
    await context.rpc("eth_getTransactionCount", [plan.input.deployer, "pending"]),
  ).toString()
  const observed = { chainId: 91342, deployer: plan.input.deployer, pendingNonce, completed }
  assertPreparedLocalStep(plan, entries.length, observed)
  return { plan, fees, entries, completed, next: { index: entries.length, observed } }
}

/** External-cash CREATE sequencing only. These observations never authorize activation. */
export async function inspectIncludedExternalCashDeployment(context: LocalDeploymentContext) {
  const fees = limits(context.approval)
  const plan = await verifyPreparedLocalDeployment(context.plan, context.artifacts)
  check(isExternalCashPlan(plan), "LOCAL_DEPLOYMENT_INCLUDED_REQUIRES_EXTERNAL_CASH")
  check(
    plan.planDigest === context.approval.expectedPlanDigest &&
      plan.input.deployer === address(context.expectedDeployer),
    "LOCAL_DEPLOYMENT_APPROVAL_MISMATCH",
  )
  const entries = await readLocalCreateIntents(context.journal)
  check(entries.length <= plan.steps.length, "LOCAL_DEPLOYMENT_JOURNAL_BINDING_MISMATCH")
  const prefix = await includedPrefix(context, plan, entries)
  const observed = {
    chainId: 91342,
    deployer: plan.input.deployer,
    pendingNonce: (BigInt(plan.input.startingNonce) + BigInt(entries.length)).toString(),
    completed: prefix.completed,
  }
  if (entries.length === plan.steps.length) return { plan, fees, entries, ...prefix, next: null }
  assertPreparedLocalStep(plan, entries.length, observed)
  return { plan, fees, entries, ...prefix, next: { index: entries.length, observed } }
}

async function includedPrefix(
  context: LocalDeploymentContext,
  plan: LocalUnsignedDeployment,
  entries: LocalCreateIntent[],
) {
  check(isExternalCashPlan(plan), "LOCAL_DEPLOYMENT_INCLUDED_REQUIRES_EXTERNAL_CASH")
  await network(context)
  await externalCashPreflight(context, plan)
  const prefix = await canonicalPrefix(plan, entries, context, "latest")
  const tag = hex(BigInt(prefix.inclusionCutoff.number))
  // Bind the account nonce and the existing proxy identity to the same cutoff as prior code.
  const expectedNonce = BigInt(plan.input.startingNonce) + BigInt(entries.length)
  check(
    qty(await context.rpc("eth_getTransactionCount", [plan.input.deployer, tag])) ===
      expectedNonce &&
      qty(await context.rpc("eth_getTransactionCount", [plan.input.deployer, "pending"])) ===
        expectedNonce,
    "LOCAL_DEPLOYMENT_NONCE_CHANGED",
  )
  try {
    await verifyExternalCashIdentity(plan, context.rpc, tag)
  } catch (error) {
    externalCashFailure(error)
  }
  await recheckIncludedBlocks(context, prefix)
  await network(context)
  return prefix
}

type IncludedPrefix = Awaited<ReturnType<typeof canonicalPrefix>>
async function recheckIncludedBlocks(context: LocalDeploymentContext, prefix: IncludedPrefix) {
  for (const block of [
    prefix.inclusionCutoff,
    ...prefix.originals.map((original) => ({
      number: original.blockNumber,
      hash: original.blockHash,
    })),
  ]) {
    const again = row(await context.rpc("eth_getBlockByNumber", [hex(BigInt(block.number)), false]))
    check(
      qty(again.number).toString() === block.number && hash(again.hash) === block.hash,
      "LOCAL_DEPLOYMENT_CANONICAL_HISTORY_CHANGED",
    )
  }
}

function unchangedIncludedOriginals(before: IncludedPrefix, after: IncludedPrefix) {
  check(
    JSON.stringify(before.originals) === JSON.stringify(after.originals),
    "LOCAL_DEPLOYMENT_CANONICAL_HISTORY_CHANGED",
  )
  check(
    BigInt(after.inclusionCutoff.number) >= BigInt(before.inclusionCutoff.number),
    "LOCAL_DEPLOYMENT_INCLUSION_REGRESSED",
  )
  check(
    before.inclusionCutoff.number !== after.inclusionCutoff.number ||
      before.inclusionCutoff.hash === after.inclusionCutoff.hash,
    "LOCAL_DEPLOYMENT_CANONICAL_HISTORY_CHANGED",
  )
}

async function price(
  context: LocalDeploymentContext,
  plan: LocalUnsignedDeployment,
  index: number,
  fees: SignedCreateFeeLimits,
) {
  const step = plan.steps[index]
  check(
    bytes(await context.rpc("eth_getCode", [step.predictedAddress, "pending"])) === "0x",
    "LOCAL_DEPLOYMENT_ADDRESS_OCCUPIED",
  )
  const latest = row(await context.rpc("eth_getBlockByNumber", ["latest", false]))
  check(
    qty(latest.baseFeePerGas) + fees.maxPriorityFeePerGas <= fees.maxFeePerGas,
    "LOCAL_DEPLOYMENT_FEE_LIMIT",
  )
  const transaction = {
    ...step.transaction,
    type: "0x2",
    maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas),
    maxFeePerGas: hex(fees.maxFeePerGas),
  }
  const estimate = qty(await context.rpc("eth_estimateGas", [transaction, "pending"]))
  const gas = (estimate * 120n + 99n) / 100n
  check(
    estimate > 0n &&
      gas <= fees.maxGas &&
      gas <= qty(latest.gasLimit) &&
      gas * fees.maxFeePerGas <= fees.maxTotalFeeWei,
    "LOCAL_DEPLOYMENT_GAS_LIMIT",
  )
  check(
    qty(await context.rpc("eth_getBalance", [plan.input.deployer, "pending"])) >=
      gas * fees.maxFeePerGas,
    "LOCAL_DEPLOYMENT_GAS_BALANCE",
  )
  return { transaction, gas, blockGasLimit: qty(latest.gasLimit) }
}

/** One original send at most. An existing durable intent is never signed or sent again. */
export async function sendNextLocalDeployment(
  context: LocalDeploymentContext,
  sign: (transaction: Record<string, unknown>) => Promise<string>,
) {
  const initial = await inspectLocalDeployment(context)
  check(initial.next !== null, "LOCAL_DEPLOYMENT_ALREADY_COMPLETE")
  const { plan, fees } = initial,
    index = initial.next.index
  const pricing = await price(context, plan, index, fees)
  const signed = await sign({
    type: 2,
    chainId: 91342,
    nonce: plan.steps[index].transaction.nonce,
    value: "0",
    data: plan.steps[index].transaction.data,
    gasLimit: pricing.gas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    accessList: [],
  })
  // Unlocking/signing may take time; refresh original identity, prefix, fee and balance.
  const fresh = await inspectLocalDeployment(context)
  check(fresh.next?.index === index, "LOCAL_DEPLOYMENT_STEP_ALREADY_CLAIMED")
  const refreshed = await price(context, plan, index, fees)
  check(refreshed.gas <= pricing.gas, "LOCAL_DEPLOYMENT_GAS_ESTIMATE_CHANGED")
  check(pricing.gas <= refreshed.blockGasLimit, "LOCAL_DEPLOYMENT_GAS_LIMIT")
  const transactionHash = await attestSignedStocksCreate(
    {
      plan,
      expectedPlanDigest: context.approval.expectedPlanDigest,
      stepIndex: index,
      observed: fresh.next.observed,
      signedTransaction: signed,
      limits: fees,
    },
    context.artifacts,
  )
  const envelope = utils.RLP.decode(`0x${signed.slice(4)}`) as string[]
  const integer = (v: string) => BigInt(v === "0x" ? "0x0" : v)
  check(
    integer(envelope[4]) === pricing.gas &&
      integer(envelope[2]) === fees.maxPriorityFeePerGas &&
      integer(envelope[3]) === fees.maxFeePerGas,
    "LOCAL_DEPLOYMENT_SIGNED_PRICING_CHANGED",
  )
  // The final network/nonce read happens after gas and signature verification.
  await network(context)
  await externalCashPreflight(context, plan)
  check(
    qty(await context.rpc("eth_getTransactionCount", [plan.input.deployer, "pending"])) ===
      BigInt(plan.steps[index].transaction.nonce),
    "LOCAL_DEPLOYMENT_NONCE_CHANGED",
  )
  check(
    qty(await context.rpc("eth_getBalance", [plan.input.deployer, "pending"])) >=
      pricing.gas * fees.maxFeePerGas,
    "LOCAL_DEPLOYMENT_GAS_BALANCE",
  )
  const entry: LocalCreateIntent = {
    version: 1,
    planDigest: plan.planDigest,
    genesisHash: context.approval.genesisHash,
    deployer: plan.input.deployer,
    index,
    nonce: BigInt(plan.steps[index].transaction.nonce).toString(),
    transactionHash,
  }
  await persistLocalCreateIntent(context.journal, entry)
  try {
    check(
      hash(await context.rpc("eth_sendRawTransaction", [signed])) === transactionHash,
      "LOCAL_DEPLOYMENT_BROADCAST_UNCERTAIN",
    )
  } catch {
    throw Error("LOCAL_DEPLOYMENT_BROADCAST_UNCERTAIN_USE_RECOVER")
  }
  return entry
}

/**
 * Sequence only the four reviewed external-cash CREATEs on successful L2 inclusion.
 * The original finalized executor and activation verifier retain their policy.
 */
export async function sendNextIncludedExternalCashDeployment(
  context: LocalDeploymentContext,
  sign: (transaction: Record<string, unknown>) => Promise<string>,
) {
  const initial = await inspectIncludedExternalCashDeployment(context)
  check(initial.next !== null, "LOCAL_DEPLOYMENT_ALREADY_COMPLETE")
  const { plan, fees } = initial,
    index = initial.next.index
  const pricing = await price(context, plan, index, fees)
  // Pricing can take time too: refresh every original immediately before asking for a signature.
  const beforeSign = await inspectIncludedExternalCashDeployment(context)
  check(beforeSign.next?.index === index, "LOCAL_DEPLOYMENT_STEP_ALREADY_CLAIMED")
  unchangedIncludedOriginals(initial, beforeSign)
  await recheckIncludedBlocks(context, initial)
  const signed = await sign({
    type: 2,
    chainId: 91342,
    nonce: plan.steps[index].transaction.nonce,
    value: "0",
    data: plan.steps[index].transaction.data,
    gasLimit: pricing.gas.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    maxFeePerGas: fees.maxFeePerGas.toString(),
    accessList: [],
  })
  const fresh = await inspectIncludedExternalCashDeployment(context)
  check(fresh.next?.index === index, "LOCAL_DEPLOYMENT_STEP_ALREADY_CLAIMED")
  unchangedIncludedOriginals(beforeSign, fresh)
  await recheckIncludedBlocks(context, beforeSign)
  const refreshed = await price(context, plan, index, fees)
  check(refreshed.gas <= pricing.gas, "LOCAL_DEPLOYMENT_GAS_ESTIMATE_CHANGED")
  check(pricing.gas <= refreshed.blockGasLimit, "LOCAL_DEPLOYMENT_GAS_LIMIT")
  const transactionHash = await attestSignedStocksCreate(
    {
      plan,
      expectedPlanDigest: context.approval.expectedPlanDigest,
      stepIndex: index,
      observed: fresh.next.observed,
      signedTransaction: signed,
      limits: fees,
    },
    context.artifacts,
  )
  const envelope = utils.RLP.decode(`0x${signed.slice(4)}`) as string[]
  const integer = (v: string) => BigInt(v === "0x" ? "0x0" : v)
  check(
    integer(envelope[4]) === pricing.gas &&
      integer(envelope[2]) === fees.maxPriorityFeePerGas &&
      integer(envelope[3]) === fees.maxFeePerGas,
    "LOCAL_DEPLOYMENT_SIGNED_PRICING_CHANGED",
  )
  check(
    qty(await context.rpc("eth_getBalance", [plan.input.deployer, "pending"])) >=
      pricing.gas * fees.maxFeePerGas,
    "LOCAL_DEPLOYMENT_GAS_BALANCE",
  )
  // Attestation, fees and balance reads can race a reorg. Rebuild the entire prefix afterward.
  const beforeIntent = await inspectIncludedExternalCashDeployment(context)
  check(beforeIntent.next?.index === index, "LOCAL_DEPLOYMENT_STEP_ALREADY_CLAIMED")
  unchangedIncludedOriginals(fresh, beforeIntent)
  await recheckIncludedBlocks(context, fresh)
  const entry: LocalCreateIntent = {
    version: 1,
    planDigest: plan.planDigest,
    genesisHash: context.approval.genesisHash,
    deployer: plan.input.deployer,
    index,
    nonce: BigInt(plan.steps[index].transaction.nonce).toString(),
    transactionHash,
  }
  await persistLocalCreateIntent(context.journal, entry)
  // The journal intentionally contains the next original already. Revalidate the known prior
  // prefix without reading that unresolved new entry. Any failure leaves a durable recovery
  // barrier; it never permits another signature or a replacement transaction.
  const beforeBroadcast = await includedPrefix(context, plan, beforeIntent.entries)
  unchangedIncludedOriginals(beforeIntent, beforeBroadcast)
  await recheckIncludedBlocks(context, beforeIntent)
  check(
    bytes(await context.rpc("eth_getCode", [plan.steps[index].predictedAddress, "pending"])) ===
      "0x",
    "LOCAL_DEPLOYMENT_ADDRESS_OCCUPIED",
  )
  check(
    qty(await context.rpc("eth_getTransactionCount", [plan.input.deployer, "pending"])) ===
      BigInt(plan.steps[index].transaction.nonce),
    "LOCAL_DEPLOYMENT_NONCE_CHANGED",
  )
  await recheckIncludedBlocks(context, beforeBroadcast)
  try {
    check(
      hash(await context.rpc("eth_sendRawTransaction", [signed])) === transactionHash,
      "LOCAL_DEPLOYMENT_BROADCAST_UNCERTAIN",
    )
  } catch {
    throw Error("LOCAL_DEPLOYMENT_BROADCAST_UNCERTAIN_USE_RECOVER")
  }
  return entry
}
