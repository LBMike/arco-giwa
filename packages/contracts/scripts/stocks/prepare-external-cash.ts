import { createHash } from "crypto"
import path from "path"
import { constants, ContractFactory, utils } from "ethers"
import type { Artifacts } from "hardhat/types"
import { EXPECTED_GIWA_DEPLOYER } from "../keystore-constants"
import { filesystemStocksArtifacts, runtimeHash } from "./prepare-deployment"
import { readPublicDeploymentJson, writePublicDeploymentJson } from "./public-deployment-json"

export const PLATFORM_TUSDC = "0x869d9c8d9bf0a961fc2fd3bba300fdbeee3c2633"
export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
type ArtifactReader = Pick<Artifacts, "readArtifact" | "getBuildInfo">
export type ExternalCashIdentity = {
  kind: "ERC1967"
  implementation: string
  implementationCodeHash: string
  proxyAdmin: string
  proxyAdminCodeHash: string
}
export type ExternalCashDeploymentInput = {
  chainId: 91342
  deployer: string
  operator: string
  startingNonce: string
  abiDigest: string
  cashToken: typeof PLATFORM_TUSDC
  cashCodeHash: string
  cashIdentity: ExternalCashIdentity
  /** Explicitly reviewed chain anchor; may retain the prior epoch's signer anchor. */
  network: { networkInstance: string; checkpointNumber: string; checkpointHash: string }
}
const names = [
  "StocksFundingVault",
  "StocksMintController",
  "StocksToken",
  "StocksRedemptionEscrow",
] as const
const MAX_TRANSACTION_NONCE = (1n << 64n) - 2n
export function externalCheck(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code)
}
export function externalObject(value: unknown): Record<string, any> {
  externalCheck(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "PUBLIC_OBJECT_REQUIRED",
  )
  return value as Record<string, any>
}
export function exactKeys(value: Record<string, unknown>, keys: string[]) {
  externalCheck(
    Object.keys(value).sort().join(",") === [...keys].sort().join(","),
    "UNEXPECTED_DEPLOYMENT_INPUT",
  )
}
export function externalAddress(value: unknown): string {
  externalCheck(
    typeof value === "string" &&
      utils.isAddress(value) &&
      value.toLowerCase() !== constants.AddressZero,
    "PUBLIC_ADDRESS_REQUIRED",
  )
  return utils.getAddress(value).toLowerCase()
}
export function externalHash(value: unknown): string {
  externalCheck(
    typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value),
    "PUBLIC_HASH_REQUIRED",
  )
  return value
}
export function externalDigest(value: unknown): string {
  externalCheck(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value),
    "PUBLIC_DIGEST_REQUIRED",
  )
  return value
}
function decimal(value: unknown, max: bigint): bigint {
  externalCheck(
    typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= max,
    "DECIMAL_NONCE_OR_BLOCK_REQUIRED",
  )
  return BigInt(value)
}
export function externalCanonical(value: unknown): string {
  const order = (node: any): any =>
    Array.isArray(node)
      ? node.map(order)
      : node !== null && typeof node === "object"
        ? Object.fromEntries(
            Object.entries(node)
              .sort(([a], [b]) => a.localeCompare(b, "en-US"))
              .map(([k, v]) => [k, order(v)]),
          )
        : node
  return JSON.stringify(order(value))
}
export function externalSha(value: unknown): string {
  return createHash("sha256").update(externalCanonical(value)).digest("hex")
}
function validateInput(value: unknown): ExternalCashDeploymentInput {
  const row = externalObject(value)
  exactKeys(row, [
    "chainId",
    "deployer",
    "operator",
    "startingNonce",
    "abiDigest",
    "cashToken",
    "cashCodeHash",
    "cashIdentity",
    "network",
  ])
  externalCheck(row.chainId === 91342, "GIWA_TESTNET_ONLY")
  externalCheck(externalAddress(row.cashToken) === PLATFORM_TUSDC, "PLATFORM_TUSDC_ONLY")
  const cash = externalObject(row.cashIdentity)
  exactKeys(cash, [
    "kind",
    "implementation",
    "implementationCodeHash",
    "proxyAdmin",
    "proxyAdminCodeHash",
  ])
  externalCheck(cash.kind === "ERC1967", "ERC1967_CASH_REQUIRED")
  const network = externalObject(row.network)
  exactKeys(network, ["networkInstance", "checkpointNumber", "checkpointHash"])
  externalCheck(
    typeof network.networkInstance === "string" &&
      /^[a-zA-Z0-9:_-]{8,128}$/.test(network.networkInstance),
    "EXPLICIT_NETWORK_IDENTITY_REQUIRED",
  )
  const input: ExternalCashDeploymentInput = {
    chainId: 91342,
    deployer: externalAddress(row.deployer),
    operator: externalAddress(row.operator),
    startingNonce: decimal(row.startingNonce, MAX_TRANSACTION_NONCE - 3n).toString(),
    abiDigest: externalDigest(row.abiDigest),
    cashToken: PLATFORM_TUSDC,
    cashCodeHash: externalHash(row.cashCodeHash),
    cashIdentity: {
      kind: "ERC1967",
      implementation: externalAddress(cash.implementation),
      implementationCodeHash: externalHash(cash.implementationCodeHash),
      proxyAdmin: externalAddress(cash.proxyAdmin),
      proxyAdminCodeHash: externalHash(cash.proxyAdminCodeHash),
    },
    network: {
      networkInstance: network.networkInstance,
      checkpointNumber: decimal(network.checkpointNumber, (1n << 64n) - 1n).toString(),
      checkpointHash: externalHash(network.checkpointHash),
    },
  }
  externalCheck(
    input.deployer !== input.operator || input.deployer === EXPECTED_GIWA_DEPLOYER.toLowerCase(),
    "DISTINCT_PUBLIC_ROLES_REQUIRED",
  )
  const cashAddresses = [
    input.cashToken,
    input.cashIdentity.implementation,
    input.cashIdentity.proxyAdmin,
  ]
  externalCheck(
    new Set(cashAddresses).size === 3 &&
      !cashAddresses.some((a) => [input.deployer, input.operator].includes(a)),
    "CASH_IDENTITY_ADDRESS_OVERLAP",
  )
  return input
}

/** Offline only: no provider, signer, existing contract mutation or nonce consumption. */
export async function prepareExternalCashDeployment(value: unknown, artifacts: ArtifactReader) {
  const input = validateInput(value)
  const first = BigInt(input.startingNonce)
  const addresses = names.map((_, i) =>
    utils
      .getContractAddress({ from: input.deployer, nonce: (first + BigInt(i)).toString() })
      .toLowerCase(),
  )
  const reserved = [
    input.deployer,
    input.operator,
    input.cashToken,
    input.cashIdentity.implementation,
    input.cashIdentity.proxyAdmin,
  ]
  externalCheck(
    new Set(addresses).size === 4 && !addresses.some((a) => reserved.includes(a)),
    "ROLE_CONTRACT_ADDRESS_OVERLAP",
  )
  const [vault, controller, stock, escrow] = addresses
  const args = [
    [input.cashToken, input.operator, escrow],
    [input.operator, stock],
    [controller, escrow],
    [input.operator, stock, vault],
  ]
  const bindings: Record<string, string>[] = [
    { cashToken: input.cashToken, operator: input.operator, redemptionEscrow: escrow },
    { operator: input.operator, stockToken: stock },
    { mintController: controller, redemptionEscrow: escrow },
    {
      operator: input.operator,
      stockToken: stock,
      fundingVault: vault,
      cashToken: input.cashToken,
    },
  ]
  const steps = []
  for (const [index, name] of names.entries()) {
    const qualified = `contracts/stocks/${name}.sol:${name}`
    const artifact = await artifacts.readArtifact(qualified)
    const build = await artifacts.getBuildInfo(qualified)
    externalCheck(
      build?.solcVersion === "0.8.28" &&
        build.solcLongVersion.startsWith("0.8.28+commit.7893614a") &&
        build.input.settings.evmVersion === "cancun" &&
        build.input.settings.optimizer?.enabled === true &&
        build.input.settings.optimizer.runs === 200,
      "PINNED_COMPILER_SETTINGS_REQUIRED",
    )
    externalCheck(
      artifact.contractName === name &&
        artifact.sourceName === `contracts/stocks/${name}.sol` &&
        Object.keys(artifact.linkReferences).length === 0 &&
        Object.keys(artifact.deployedLinkReferences).length === 0 &&
        /^0x(?:[0-9a-f]{2})+$/.test(artifact.bytecode),
      "UNEXPECTED_ARTIFACT",
    )
    const data = new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
      ...args[index],
    ).data
    externalCheck(typeof data === "string", "MISSING_CREATION_DATA")
    steps.push({
      index,
      contractName: name,
      operation: "CREATE" as const,
      predictedAddress: addresses[index],
      constructorArguments: args[index],
      creationBytecodeHash: utils.keccak256(artifact.bytecode),
      initCodeHash: utils.keccak256(data),
      expectedRuntimeCodeHash: runtimeHash(artifact, build, bindings[index]),
      transaction: {
        chainId: 91342 as const,
        from: input.deployer,
        nonce: `0x${(first + BigInt(index)).toString(16)}`,
        to: null,
        value: "0x0" as const,
        data,
      },
      expectedBindings: Object.entries(bindings[index]).map(([getter, expected]) => ({
        getter,
        returns: "address" as const,
        expected,
      })),
    })
  }
  const body = {
    kind: "ARCO_GIWA_STOCKS_EXTERNAL_CASH_UNSIGNED_DEPLOYMENT_V1" as const,
    status: "UNSIGNED_NOT_BROADCAST" as const,
    profile: "DEMO_TESTNET" as const,
    valuePolicy: "TEST_VALUE_ONLY" as const,
    input,
    compiler: { version: "0.8.28", evmVersion: "cancun", optimizerRuns: 200 },
    stockPolicy: {
      restrictedTransfers: true as const,
      stockContractsNonUpgradeable: true as const,
      cashScale: 6 as const,
      quantityScale: 9 as const,
    },
    steps,
  }
  return { ...body, planDigest: externalSha(body) }
}
export type UnsignedExternalCashDeployment = Awaited<
  ReturnType<typeof prepareExternalCashDeployment>
>
export async function verifyPreparedExternalCashDeployment(
  value: unknown,
  artifacts: ArtifactReader,
) {
  const candidate = externalObject(value)
  const rebuilt = await prepareExternalCashDeployment(candidate.input, artifacts)
  externalCheck(
    externalCanonical(candidate) === externalCanonical(rebuilt),
    "DEPLOYMENT_PLAN_CHANGED",
  )
  return rebuilt
}
export function assertPreparedExternalCashStep(
  plan: UnsignedExternalCashDeployment,
  index: number,
  observed: {
    chainId: number
    deployer: string
    pendingNonce: string
    completed: { index: number; address: string; runtimeCodeHash: string }[]
  },
) {
  const { planDigest, ...body } = plan
  externalCheck(externalSha(body) === planDigest, "DEPLOYMENT_PLAN_CHANGED")
  externalCheck(
    Number.isInteger(index) && index >= 0 && index < 4 && plan.steps[index]?.index === index,
    "INVALID_DEPLOYMENT_STEP",
  )
  externalCheck(
    observed.chainId === 91342 && externalAddress(observed.deployer) === plan.input.deployer,
    "DEPLOYMENT_NETWORK_OR_SENDER_CHANGED",
  )
  externalCheck(
    decimal(observed.pendingNonce, MAX_TRANSACTION_NONCE) ===
      BigInt(plan.steps[index].transaction.nonce),
    "DEPLOYMENT_NONCE_CHANGED",
  )
  externalCheck(observed.completed.length === index, "DEPLOYMENT_SEQUENCE_INCOMPLETE")
  for (const [prior, item] of observed.completed.entries())
    externalCheck(
      item.index === prior &&
        externalAddress(item.address) === plan.steps[prior].predictedAddress &&
        item.runtimeCodeHash === plan.steps[prior].expectedRuntimeCodeHash,
      "PRIOR_DEPLOYMENT_EVIDENCE_MISMATCH",
    )
  return plan.steps[index].transaction
}

async function main() {
  const args = process.argv.slice(2)
  externalCheck(
    args.length === 4 &&
      args[0] === "--input" &&
      args[2] === "--output" &&
      path.isAbsolute(args[1]) &&
      path.isAbsolute(args[3]),
    "Usage: prepare-external-cash.ts --input /absolute/public-input.json --output /absolute/unsigned-plan.json",
  )
  const plan = await prepareExternalCashDeployment(
    await readPublicDeploymentJson(args[1]),
    filesystemStocksArtifacts(path.resolve(__dirname, "../../artifacts/stocks")),
  )
  await writePublicDeploymentJson(args[3], plan)
  console.log(
    `Unsigned four-CREATE tUSDC plan prepared: ${plan.planDigest}. No signing or broadcasting.`,
  )
}
if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "EXTERNAL_CASH_PREPARATION_FAILED")
    process.exitCode = 1
  })
