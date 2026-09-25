import path from "path"
import { utils } from "ethers"
import type { Artifacts } from "hardhat/types"
import { filesystemStocksArtifacts } from "./prepare-deployment"
import {
  verifyPreparedExternalCashDeployment,
  externalSha,
  PLATFORM_TUSDC,
  IMPLEMENTATION_SLOT,
  ADMIN_SLOT,
  type UnsignedExternalCashDeployment,
} from "./prepare-external-cash"

import { deploymentHttpsRpc, type DeploymentReadRpc } from "./deployment-http"
import { readPublicDeploymentJson, writePublicDeploymentJson } from "./public-deployment-json"
export { deploymentHttpsRpc, type DeploymentReadRpc } from "./deployment-http"
type ArtifactReader = Pick<Artifacts, "readArtifact" | "getBuildInfo">
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function object(value: unknown): Record<string, any> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "RPC_OBJECT_REQUIRED")
  return value as Record<string, any>
}
function quantity(value: unknown): bigint {
  check(
    typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && value.length <= 66,
    "INVALID_RPC_QUANTITY",
  )
  return BigInt(value)
}
function hash(value: unknown): string {
  check(
    typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/.test(value),
    "INVALID_TRANSACTION_OR_BLOCK_HASH",
  )
  return value.toLowerCase()
}
function address(value: unknown): string {
  check(
    typeof value === "string" && utils.isAddress(value) && !/^0x0{40}$/i.test(value),
    "INVALID_PUBLIC_ADDRESS",
  )
  return value.toLowerCase()
}
function data(value: unknown): string {
  check(typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value), "INVALID_RPC_DATA")
  return value.toLowerCase()
}
function shaDigest(value: unknown): string {
  check(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value),
    "INVALID_SHA256_DIGEST",
  )
  return value
}
function block(value: unknown) {
  const row = object(value)
  return {
    number: quantity(row.number),
    hash: hash(row.hash),
    timestamp: quantity(row.timestamp),
    transactions: row.transactions,
  }
}

/** Public proxy identity at an explicit canonical block. Never reads a key or calls a mutating method. */
export async function verifyExternalCashIdentity(
  plan: UnsignedExternalCashDeployment,
  rpc: DeploymentReadRpc,
  tag: string,
) {
  const identity = plan.input.cashIdentity
  for (const [slot, expected] of [
    [IMPLEMENTATION_SLOT, identity.implementation],
    [ADMIN_SLOT, identity.proxyAdmin],
  ]) {
    const result = data(await rpc("eth_getStorageAt", [PLATFORM_TUSDC, slot, tag]))
    check(
      result === utils.hexZeroPad(expected, 32).toLowerCase(),
      "EXTERNAL_CASH_PROXY_IDENTITY_MISMATCH",
    )
  }
  for (const [contract, expected] of [
    [PLATFORM_TUSDC, plan.input.cashCodeHash],
    [identity.implementation, identity.implementationCodeHash],
    [identity.proxyAdmin, identity.proxyAdminCodeHash],
  ]) {
    const code = data(await rpc("eth_getCode", [contract, tag]))
    check(
      code !== "0x" && utils.keccak256(code) === expected,
      "EXTERNAL_CASH_CODE_IDENTITY_MISMATCH",
    )
  }
  return plan.input.cashCodeHash
}

async function verifyPristineExternalCashEpoch(
  plan: UnsignedExternalCashDeployment,
  rpc: DeploymentReadRpc,
  from: bigint,
  to: bigint,
) {
  check(to >= from && to - from <= 100_000n, "PRE_ACTIVATION_REVIEW_RANGE_EXCEEDED")
  const upgradeTopics = [
    utils.id("Upgraded(address)"),
    utils.id("AdminChanged(address,address)"),
    utils.id("BeaconUpgraded(address)"),
  ]
  const transfer = utils.id("Transfer(address,address,uint256)")
  const vaultTopic = utils.hexZeroPad(plan.steps[0].predictedAddress, 32).toLowerCase()
  // Some GIWA providers cap eth_getLogs at 100 blocks. Any RPC failure is a verification failure.
  for (let first = from; first <= to; first += 100n) {
    const last = first + 99n < to ? first + 99n : to
    const range = { fromBlock: `0x${first.toString(16)}`, toBlock: `0x${last.toString(16)}` }
    for (const filter of [
      { ...range, address: plan.steps.map((step) => step.predictedAddress) },
      { ...range, address: PLATFORM_TUSDC, topics: [upgradeTopics] },
      { ...range, address: PLATFORM_TUSDC, topics: [transfer, null, vaultTopic] },
      { ...range, address: PLATFORM_TUSDC, topics: [transfer, vaultTopic] },
    ]) {
      const logs = await rpc("eth_getLogs", [filter])
      check(Array.isArray(logs) && logs.length === 0, "PRE_ACTIVATION_ECONOMIC_OR_PROXY_ACTIVITY")
    }
  }
}

/** Verifies actual original on-chain creations; this function has no signing API. */
export async function verifyExternalCashDeploymentEvidence(
  value: unknown,
  artifacts: ArtifactReader,
  rpc: DeploymentReadRpc,
) {
  const input = object(value)
  check(
    Object.keys(input).sort().join(",") === "expectedPlanDigest,plan,transactionHashes",
    "UNEXPECTED_VERIFICATION_INPUT",
  )
  const expectedDigest = shaDigest(input.expectedPlanDigest)
  check(
    Array.isArray(input.transactionHashes) && input.transactionHashes.length === 4,
    "FOUR_ORIGINAL_TRANSACTION_HASHES_REQUIRED",
  )
  const transactionHashes: string[] = input.transactionHashes.map(hash)
  check(new Set(transactionHashes).size === 4, "DUPLICATE_DEPLOYMENT_TRANSACTION")
  const plan = await verifyPreparedExternalCashDeployment(input.plan, artifacts)
  check(plan.planDigest === expectedDigest, "ORIGINAL_APPROVED_PLAN_DIGEST_MISMATCH")
  check(quantity(await rpc("eth_chainId", [])) === 91342n, "GIWA_TESTNET_ONLY")
  const cutoff = block(await rpc("eth_getBlockByNumber", ["finalized", false]))
  const cutoffTag = `0x${cutoff.number.toString(16)}`
  check(
    block(await rpc("eth_getBlockByNumber", [cutoffTag, false])).hash === cutoff.hash,
    "FINALIZED_CUTOFF_NOT_CANONICAL",
  )

  const creations: {
    index: number
    transactionHash: string
    address: string
    blockNumber: string
    blockHash: string
    transactionIndex: string
  }[] = []
  let previous: { block: bigint; index: bigint } | null = null
  for (const [index, step] of plan.steps.entries()) {
    const txHash = transactionHashes[index]
    const rawTx = await rpc("eth_getTransactionByHash", [txHash])
    const rawReceipt = await rpc("eth_getTransactionReceipt", [txHash])
    check(rawTx !== null && rawReceipt !== null, "DEPLOYMENT_TRANSACTION_PENDING_OR_MISSING")
    const tx = object(rawTx)
    const receipt = object(rawReceipt)
    check(
      tx.blockNumber !== null && tx.blockHash !== null && tx.transactionIndex !== null,
      "DEPLOYMENT_TRANSACTION_PENDING_OR_MISSING",
    )
    const number = quantity(receipt.blockNumber)
    const indexInBlock = quantity(receipt.transactionIndex)
    check(number <= cutoff.number, "DEPLOYMENT_NOT_FINALIZED")
    check(
      hash(tx.hash) === txHash && hash(receipt.transactionHash) === txHash,
      "DEPLOYMENT_TRANSACTION_HASH_MISMATCH",
    )
    check(quantity(tx.chainId) === 91342n, "DEPLOYMENT_TRANSACTION_CHAIN_MISMATCH")
    check(
      address(tx.from) === plan.input.deployer && address(receipt.from) === plan.input.deployer,
      "DEPLOYMENT_SENDER_MISMATCH",
    )
    check(tx.to === null && receipt.to === null, "EXPECTED_ORIGINAL_CREATE_TRANSACTION")
    check(quantity(tx.nonce) === BigInt(step.transaction.nonce), "DEPLOYMENT_NONCE_MISMATCH")
    check(
      quantity(tx.value) === 0n && data(tx.input) === step.transaction.data.toLowerCase(),
      "DEPLOYMENT_CALLDATA_OR_VALUE_MISMATCH",
    )
    check(quantity(receipt.status) === 1n, "DEPLOYMENT_TRANSACTION_REVERTED")
    check(address(receipt.contractAddress) === step.predictedAddress, "DEPLOYED_ADDRESS_MISMATCH")
    check(
      quantity(tx.blockNumber) === number &&
        quantity(tx.transactionIndex) === indexInBlock &&
        hash(tx.blockHash) === hash(receipt.blockHash),
      "TRANSACTION_RECEIPT_BLOCK_MISMATCH",
    )
    if (previous)
      check(
        number > previous.block || (number === previous.block && indexInBlock > previous.index),
        "DEPLOYMENT_ORDER_MISMATCH",
      )
    previous = { block: number, index: indexInBlock }
    const canonical = block(await rpc("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]))
    check(
      canonical.number === number && canonical.hash === hash(receipt.blockHash),
      "DEPLOYMENT_RECEIPT_NOT_CANONICAL",
    )
    check(
      Array.isArray(canonical.transactions) &&
        indexInBlock < BigInt(canonical.transactions.length) &&
        hash(canonical.transactions[Number(indexInBlock)]) === txHash,
      "DEPLOYMENT_NOT_IN_CANONICAL_BLOCK",
    )
    creations.push({
      index,
      transactionHash: txHash,
      address: step.predictedAddress,
      blockNumber: number.toString(),
      blockHash: canonical.hash,
      transactionIndex: indexInBlock.toString(),
    })
  }

  const codeHashes: Record<string, string> = {}
  for (const step of plan.steps) {
    const code = data(await rpc("eth_getCode", [step.predictedAddress, cutoffTag]))
    check(
      code !== "0x" && utils.keccak256(code) === step.expectedRuntimeCodeHash,
      "DEPLOYED_RUNTIME_CODE_MISMATCH",
    )
    codeHashes[step.predictedAddress] = utils.keccak256(code)
    for (const binding of step.expectedBindings) {
      const abi = new utils.Interface([`function ${binding.getter}() view returns(address)`])
      const result = data(
        await rpc("eth_call", [
          { to: step.predictedAddress, data: abi.encodeFunctionData(binding.getter) },
          cutoffTag,
        ]),
      )
      check(
        result === utils.hexZeroPad(binding.expected, 32).toLowerCase(),
        "DEPLOYED_CONSTRUCTOR_BINDING_MISMATCH",
      )
    }
  }
  codeHashes[PLATFORM_TUSDC] = await verifyExternalCashIdentity(plan, rpc, cutoffTag)
  const decimals = new utils.Interface(["function decimals() view returns(uint8)"])
  for (const [token, expected] of [
    [PLATFORM_TUSDC, 6n],
    [plan.steps[2].predictedAddress, 9n],
  ] as const) {
    const result = data(
      await rpc("eth_call", [
        { to: token, data: decimals.encodeFunctionData("decimals") },
        cutoffTag,
      ]),
    )
    check(result.length === 66 && BigInt(result) === expected, "DEPLOYED_TOKEN_SCALE_MISMATCH")
  }
  const tokenAbi = new utils.Interface([
    "function symbol() view returns(string)",
    "function totalSupply() view returns(uint256)",
    "function balanceOf(address) view returns(uint256)",
  ])
  const symbol = data(
    await rpc("eth_call", [
      { to: PLATFORM_TUSDC, data: tokenAbi.encodeFunctionData("symbol") },
      cutoffTag,
    ]),
  )
  check(
    symbol === tokenAbi.encodeFunctionResult("symbol", ["tUSDC"]).toLowerCase(),
    "PLATFORM_TUSDC_SYMBOL_MISMATCH",
  )
  // Existing platform cash already has circulation. Its global supply is deliberately NOT required to be zero.
  for (const [to, fn, args, failure] of [
    [PLATFORM_TUSDC, "balanceOf", [plan.steps[0].predictedAddress], "PRE_ACTIVATION_VAULT_BALANCE"],
    [plan.steps[2].predictedAddress, "totalSupply", [], "PRE_ACTIVATION_STOCK_ACTIVITY"],
  ] as const) {
    const result = data(
      await rpc("eth_call", [{ to, data: tokenAbi.encodeFunctionData(fn, args) }, cutoffTag]),
    )
    check(result.length === 66 && BigInt(result) === 0n, failure)
  }
  const checkpoint = plan.input.network
  check(
    BigInt(checkpoint.checkpointNumber) <= BigInt(creations[0].blockNumber),
    "NETWORK_CHECKPOINT_AFTER_CREATION",
  )
  const checkpointTag = `0x${BigInt(checkpoint.checkpointNumber).toString(16)}`
  const anchor = block(await rpc("eth_getBlockByNumber", [checkpointTag, false]))
  check(
    anchor.number.toString() === checkpoint.checkpointNumber &&
      anchor.hash === checkpoint.checkpointHash,
    "NETWORK_CHECKPOINT_MISMATCH",
  )
  // Zero supply/balance alone cannot distinguish fresh contracts from a completed buy/sell cycle.
  // Inspect the entire newly created epoch, including direct cash donations to its predicted vault.
  await verifyPristineExternalCashEpoch(plan, rpc, BigInt(creations[0].blockNumber), cutoff.number)

  // No manifest escapes if any deployment or cutoff changed during RPC reads.
  check(quantity(await rpc("eth_chainId", [])) === 91342n, "GIWA_TESTNET_ONLY")
  for (const creation of creations) {
    const canonical = block(
      await rpc("eth_getBlockByNumber", [`0x${BigInt(creation.blockNumber).toString(16)}`, false]),
    )
    check(
      canonical.hash === creation.blockHash && canonical.number.toString() === creation.blockNumber,
      "DEPLOYMENT_CANONICAL_HISTORY_CHANGED",
    )
  }
  const finalAgain = block(await rpc("eth_getBlockByNumber", ["finalized", false]))
  check(finalAgain.number >= cutoff.number, "FINALIZED_HEAD_REGRESSED")
  const cutoffAgain = block(await rpc("eth_getBlockByNumber", [cutoffTag, false]))
  check(
    cutoffAgain.number === cutoff.number && cutoffAgain.hash === cutoff.hash,
    "FINALIZED_CUTOFF_CHANGED",
  )

  const anchorAgain = block(await rpc("eth_getBlockByNumber", [checkpointTag, false]))
  check(
    anchorAgain.number.toString() === checkpoint.checkpointNumber &&
      anchorAgain.hash === checkpoint.checkpointHash,
    "NETWORK_CHECKPOINT_CHANGED",
  )
  const identity = externalSha({
    kind: "ARCO_GIWA_STOCKS_EXTERNAL_CASH_V3",
    planDigest: expectedDigest,
    firstCreation: creations[0],
  })
  const manifest = {
    schemaVersion: 3 as const,
    profile: "DEMO_TESTNET" as const,
    chainId: 91342 as const,
    deploymentId: `giwa-stocks-tusdc-${identity}`,
    ...checkpoint,
    abiDigest: plan.input.abiDigest,
    finalityPolicy: "FINALIZED" as const,
    cashToken: PLATFORM_TUSDC,
    cashSymbol: "tUSDC" as const,
    cashScale: 6 as const,
    stockToken: plan.steps[2].predictedAddress,
    quantityScale: 9 as const,
    fundingVault: plan.steps[0].predictedAddress,
    mintController: plan.steps[1].predictedAddress,
    redemptionEscrow: plan.steps[3].predictedAddress,
    signerAddress: plan.input.operator,
    codeHashes,
    cashIdentity: plan.input.cashIdentity,
    restrictedTransfers: true as const,
    nonUpgradeable: false as const,
    stockContractsNonUpgradeable: true as const,
  }
  return {
    manifest,
    evidence: {
      planDigest: expectedDigest,
      creations,
      finalizedCutoff: { number: cutoff.number.toString(), hash: cutoff.hash },
      checkpointPolicy: "EXPLICIT_REVIEWED_NETWORK_ANCHOR" as const,
      pristineFromBlock: creations[0].blockNumber,
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  check(
    args.length === 6 &&
      args[0] === "--input" &&
      args[2] === "--rpc" &&
      args[4] === "--output" &&
      path.isAbsolute(args[1]) &&
      path.isAbsolute(args[5]),
    "Usage: verify-external-cash.ts --input /absolute/creation-evidence.json --rpc https://explicit-rpc --output /absolute/manifest.json",
  )
  const rpc = deploymentHttpsRpc(args[3])
  const input = await readPublicDeploymentJson(args[1])
  const artifacts = filesystemStocksArtifacts(path.resolve(__dirname, "../../artifacts/stocks"))
  const result = await verifyExternalCashDeploymentEvidence(input, artifacts, rpc)
  await writePublicDeploymentJson(args[5], result.manifest)
  console.log(`Verified GIWA testnet deployment: ${result.manifest.deploymentId}`)
  console.log(
    `Finalized cutoff ${result.evidence.finalizedCutoff.number}; no transaction signed or broadcast.`,
  )
}
if (require.main === module)
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Deployment evidence verification failed",
    )
    process.exitCode = 1
  })
