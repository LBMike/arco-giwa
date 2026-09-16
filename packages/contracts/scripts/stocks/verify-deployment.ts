import { createHash, randomUUID } from "crypto"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { utils } from "ethers"
import type { Artifacts } from "hardhat/types"
import { filesystemStocksArtifacts, verifyPreparedDeployment } from "./prepare-deployment"

export type DeploymentReadRpc = (method: string, params: unknown[]) => Promise<unknown>
type ArtifactReader = Pick<Artifacts, "readArtifact" | "getBuildInfo">
const reads = new Set([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
  "eth_call",
])
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
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
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

/** Verifies actual original on-chain creations; this function has no signing API. */
export async function verifyStocksDeploymentEvidence(
  value: unknown,
  artifacts: ArtifactReader,
  rpc: DeploymentReadRpc,
) {
  const input = object(value)
  check(
    Object.keys(input).sort().join(",") === "abiDigest,expectedPlanDigest,plan,transactionHashes",
    "UNEXPECTED_VERIFICATION_INPUT",
  )
  const expectedDigest = shaDigest(input.expectedPlanDigest)
  const abiDigest = shaDigest(input.abiDigest)
  check(
    Array.isArray(input.transactionHashes) && input.transactionHashes.length === 5,
    "FIVE_ORIGINAL_TRANSACTION_HASHES_REQUIRED",
  )
  const transactionHashes: string[] = input.transactionHashes.map(hash)
  check(new Set(transactionHashes).size === 5, "DUPLICATE_DEPLOYMENT_TRANSACTION")
  const plan = await verifyPreparedDeployment(input.plan, artifacts)
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
  const decimals = new utils.Interface(["function decimals() view returns(uint8)"])
  for (const [index, expected] of [
    [0, 6n],
    [3, 9n],
  ] as const) {
    const result = data(
      await rpc("eth_call", [
        { to: plan.steps[index].predictedAddress, data: decimals.encodeFunctionData("decimals") },
        cutoffTag,
      ]),
    )
    check(result.length === 66 && BigInt(result) === expected, "DEPLOYED_TOKEN_SCALE_MISMATCH")
  }
  // Bootstrap only from pristine reviewed tokens. This exact test cash has no
  // burn path; any prior positive funding/refund/redemption necessarily leaves
  // positive total supply, even when vault balances later return to zero.
  const supply = new utils.Interface(["function totalSupply() view returns(uint256)"])
  for (const [index, failure] of [
    [0, "PRE_ACTIVATION_TEST_CASH_ACTIVITY"],
    [3, "PRE_ACTIVATION_STOCK_ACTIVITY"],
  ] as const) {
    const result = data(
      await rpc("eth_call", [
        { to: plan.steps[index].predictedAddress, data: supply.encodeFunctionData("totalSupply") },
        cutoffTag,
      ]),
    )
    check(result.length === 66 && BigInt(result) === 0n, failure)
  }

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

  const checkpoint = creations[0]
  const identity = sha256(
    `ARCO_GIWA_STOCKS_V2:${expectedDigest}:${checkpoint.blockNumber}:${checkpoint.blockHash}`,
  )
  const manifest = {
    schemaVersion: 2 as const,
    profile: "DEMO_TESTNET" as const,
    chainId: 91342 as const,
    deploymentId: `giwa-stocks-${identity}`,
    networkInstance: `giwa-91342-${identity}`,
    checkpointNumber: checkpoint.blockNumber,
    checkpointHash: checkpoint.blockHash,
    abiDigest,
    finalityPolicy: "FINALIZED" as const,
    cashToken: plan.steps[0].predictedAddress,
    cashSymbol: "ARCO_TEST_USDC" as const,
    cashScale: 6 as const,
    stockToken: plan.steps[3].predictedAddress,
    quantityScale: 9 as const,
    fundingVault: plan.steps[1].predictedAddress,
    mintController: plan.steps[2].predictedAddress,
    redemptionEscrow: plan.steps[4].predictedAddress,
    signerAddress: plan.input.operator,
    codeHashes,
    restrictedTransfers: true as const,
    nonUpgradeable: true as const,
  }
  return {
    manifest,
    evidence: {
      planDigest: expectedDigest,
      creations,
      finalizedCutoff: { number: cutoff.number.toString(), hash: cutoff.hash },
      checkpointPolicy: "FIRST_CREATION_BLOCK_INCLUSIVE" as const,
    },
  }
}

/** Explicit HTTPS-only read transport. It never exposes a send/sign method. */
export function deploymentHttpsRpc(
  endpoint: string,
  request: typeof fetch = fetch,
): DeploymentReadRpc {
  const target = new URL(endpoint)
  check(
    target.protocol === "https:" &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
    "EXPLICIT_HTTPS_READ_RPC_REQUIRED",
  )
  return async (method, params) => {
    check(reads.has(method), "READ_ONLY_DEPLOYMENT_RPC")
    const id = randomUUID()
    const response = await request(target, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    })
    check(response.ok, "DEPLOYMENT_RPC_UNAVAILABLE")
    const row = object(await response.json())
    check(
      row.jsonrpc === "2.0" &&
        row.id === id &&
        !row.error &&
        Object.prototype.hasOwnProperty.call(row, "result"),
      "DEPLOYMENT_RPC_RESPONSE_INVALID",
    )
    return row.result
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
    "Usage: verify-deployment.ts --input /absolute/creation-evidence.json --rpc https://explicit-rpc --output /absolute/manifest.json",
  )
  const rpc = deploymentHttpsRpc(args[3])
  let input: unknown
  try {
    input = JSON.parse(await readFile(args[1], "utf8"))
  } catch {
    throw new Error("INVALID_PUBLIC_DEPLOYMENT_EVIDENCE_FILE")
  }
  const artifacts = filesystemStocksArtifacts(path.resolve(__dirname, "../../artifacts/stocks"))
  const result = await verifyStocksDeploymentEvidence(input, artifacts, rpc)
  await writeFile(args[5], JSON.stringify(result.manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  })
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
