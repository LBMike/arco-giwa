import { createHash } from "crypto"
import { readFile } from "fs/promises"
import path from "path"
import { readPublicDeploymentJson, writePublicDeploymentJson } from "./public-deployment-json"
import { constants, ContractFactory, utils } from "ethers"
import type { Artifact, Artifacts, BuildInfo } from "hardhat/types"

type ArtifactReader = Pick<Artifacts, "readArtifact" | "getBuildInfo">
export type PublicDeploymentInput = {
  chainId: 91342
  deployer: string
  operator: string
  faucetOperator: string
  startingNonce: string
}
const names = [
  "StocksTestCash",
  "StocksFundingVault",
  "StocksMintController",
  "StocksToken",
  "StocksRedemptionEscrow",
] as const
const MAX_TRANSACTION_NONCE = (1n << 64n) - 2n

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function publicAddress(value: unknown): string {
  requireValue(typeof value === "string" && utils.isAddress(value), "PUBLIC_ADDRESS_REQUIRED")
  requireValue(value.toLowerCase() !== constants.AddressZero, "ZERO_ROLE_FORBIDDEN")
  return utils.getAddress(value).toLowerCase()
}
function nonce(value: unknown): bigint {
  requireValue(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20,
    "DECIMAL_NONCE_REQUIRED",
  )
  const parsed = BigInt(value)
  requireValue(parsed <= MAX_TRANSACTION_NONCE, "NONCE_OUT_OF_RANGE")
  return parsed
}
function canonical(value: unknown): string {
  const order = (node: any): any =>
    Array.isArray(node)
      ? node.map(order)
      : node !== null && typeof node === "object"
        ? Object.fromEntries(
            Object.entries(node)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, order(v)]),
          )
        : node
  return JSON.stringify(order(value))
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}
function validateInput(value: unknown): PublicDeploymentInput {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "PUBLIC_INPUT_REQUIRED",
  )
  const row = value as Record<string, unknown>
  requireValue(
    Object.keys(row).sort().join(",") === "chainId,deployer,faucetOperator,operator,startingNonce",
    "UNEXPECTED_DEPLOYMENT_INPUT",
  )
  requireValue(row.chainId === 91342, "GIWA_TESTNET_ONLY")
  const input = {
    chainId: 91342 as const,
    deployer: publicAddress(row.deployer),
    operator: publicAddress(row.operator),
    faucetOperator: publicAddress(row.faucetOperator),
    startingNonce: nonce(row.startingNonce).toString(),
  }
  requireValue(
    new Set([input.deployer, input.operator, input.faucetOperator]).size === 3,
    "DISTINCT_PUBLIC_ROLES_REQUIRED",
  )
  requireValue(
    nonce(input.startingNonce) + 4n <= MAX_TRANSACTION_NONCE,
    "DEPLOYMENT_NONCE_RANGE_OVERFLOW",
  )
  return input
}
function fullyQualified(name: (typeof names)[number]): string {
  return `contracts/stocks/${name}.sol:${name}`
}

function runtimeHash(
  artifact: Artifact,
  build: BuildInfo,
  bindings: Record<string, string>,
): string {
  const output: any = build.output.contracts[artifact.sourceName]?.[artifact.contractName]
  requireValue(
    output?.evm?.bytecode?.object === artifact.bytecode.slice(2) &&
      output?.evm?.deployedBytecode?.object === artifact.deployedBytecode.slice(2),
    "ARTIFACT_BUILD_MISMATCH",
  )
  const runtime: string = output.evm.deployedBytecode.object
  requireValue(/^(?:[0-9a-f]{2})+$/.test(runtime), "UNLINKED_RUNTIME_BYTECODE")
  const variables = new Map<string, string>()
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return
    if (value.nodeType === "VariableDeclaration" && value.mutability === "immutable")
      variables.set(String(value.id), value.name)
    for (const child of Object.values(value))
      if (Array.isArray(child)) child.forEach(walk)
      else walk(child)
  }
  for (const source of Object.values(build.output.sources)) walk(source.ast)
  const code = Buffer.from(runtime, "hex")
  const seen = new Set<string>()
  for (const [id, references] of Object.entries(
    output.evm.deployedBytecode.immutableReferences ?? {},
  )) {
    const name = variables.get(id)
    requireValue(
      name &&
        Object.prototype.hasOwnProperty.call(bindings, name) &&
        Array.isArray(references) &&
        references.length > 0,
      "UNEXPECTED_IMMUTABLE_REFERENCE",
    )
    const encoded = Buffer.from(utils.hexZeroPad(bindings[name], 32).slice(2), "hex")
    for (const reference of references as { start: number; length: number }[]) {
      requireValue(
        Number.isSafeInteger(reference.start) &&
          reference.start >= 0 &&
          reference.length === 32 &&
          reference.start + 32 <= code.length,
        "INVALID_IMMUTABLE_OFFSET",
      )
      requireValue(
        code.subarray(reference.start, reference.start + 32).every((byte) => byte === 0),
        "IMMUTABLE_TEMPLATE_NOT_ZERO",
      )
      encoded.copy(code, reference.start)
    }
    seen.add(name)
  }
  requireValue(
    [...seen].sort().join(",") === Object.keys(bindings).sort().join(","),
    "MISSING_IMMUTABLE_REFERENCE",
  )
  return utils.keccak256(code)
}

/** Pure offline preparation. The reader is filesystem/artifact-only: no provider or signer. */
export async function prepareStocksDeployment(value: unknown, artifacts: ArtifactReader) {
  const input = validateInput(value)
  const firstNonce = nonce(input.startingNonce)
  const addresses = names.map((_, index) =>
    utils
      .getContractAddress({ from: input.deployer, nonce: (firstNonce + BigInt(index)).toString() })
      .toLowerCase(),
  )
  requireValue(
    new Set(addresses).size === 5 &&
      !addresses.some((a) => [input.deployer, input.operator, input.faucetOperator].includes(a)),
    "ROLE_CONTRACT_ADDRESS_OVERLAP",
  )
  const [cash, vault, controller, stock, escrow] = addresses
  const argumentsByStep = [
    [input.faucetOperator],
    [cash, input.operator, escrow],
    [input.operator, stock],
    [controller, escrow],
    [input.operator, stock, vault],
  ]
  const bindingsByStep: Record<string, string>[] = [
    { faucetOperator: input.faucetOperator },
    { cashToken: cash, operator: input.operator, redemptionEscrow: escrow },
    { operator: input.operator, stockToken: stock },
    { mintController: controller, redemptionEscrow: escrow },
    { operator: input.operator, stockToken: stock, fundingVault: vault, cashToken: cash },
  ]
  const steps = []
  for (const [index, name] of names.entries()) {
    const qualified = fullyQualified(name)
    const artifact = await artifacts.readArtifact(qualified)
    const build = await artifacts.getBuildInfo(qualified)
    requireValue(
      build?.solcVersion === "0.8.28" &&
        build.solcLongVersion.startsWith("0.8.28+commit.7893614a") &&
        build.input.settings.evmVersion === "cancun" &&
        build.input.settings.optimizer?.enabled === true &&
        build.input.settings.optimizer.runs === 200,
      "PINNED_COMPILER_SETTINGS_REQUIRED",
    )
    requireValue(
      artifact.contractName === name && artifact.sourceName === `contracts/stocks/${name}.sol`,
      "UNEXPECTED_ARTIFACT",
    )
    requireValue(
      Object.keys(artifact.linkReferences).length === 0 &&
        Object.keys(artifact.deployedLinkReferences).length === 0 &&
        /^0x(?:[0-9a-f]{2})+$/.test(artifact.bytecode),
      "UNLINKED_CREATION_BYTECODE",
    )
    const args = argumentsByStep[index]
    const data = new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(
      ...args,
    ).data
    requireValue(typeof data === "string", "MISSING_CREATION_DATA")
    steps.push({
      index,
      contractName: name,
      operation: "CREATE" as const,
      predictedAddress: addresses[index],
      constructorArguments: args,
      creationBytecodeHash: utils.keccak256(artifact.bytecode),
      initCodeHash: utils.keccak256(data),
      expectedRuntimeCodeHash: runtimeHash(artifact, build, bindingsByStep[index]),
      transaction: {
        chainId: 91342 as const,
        from: input.deployer,
        nonce: `0x${(firstNonce + BigInt(index)).toString(16)}`,
        to: null,
        value: "0x0" as const,
        data,
      },
      expectedBindings: Object.entries(bindingsByStep[index]).map(([getter, expected]) => ({
        getter,
        returns: "address" as const,
        expected,
      })),
    })
  }
  const body = {
    kind: "ARCO_GIWA_STOCKS_UNSIGNED_DEPLOYMENT_V1" as const,
    status: "UNSIGNED_NOT_BROADCAST" as const,
    profile: "DEMO_TESTNET" as const,
    valuePolicy: "TEST_VALUE_ONLY" as const,
    input,
    compiler: { version: "0.8.28", evmVersion: "cancun", optimizerRuns: 200 },
    stockPolicy: {
      restrictedTransfers: true,
      nonUpgradeable: true,
      cashScale: 6,
      quantityScale: 9,
    },
    steps,
  }
  return { ...body, planDigest: digest(body) }
}
export type UnsignedStocksDeployment = Awaited<ReturnType<typeof prepareStocksDeployment>>

/** Rebuild from pinned artifacts and reject modified fields, steps, hashes or calldata. */
export async function verifyPreparedDeployment(
  value: unknown,
  artifacts: ArtifactReader,
): Promise<UnsignedStocksDeployment> {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "INVALID_DEPLOYMENT_PLAN",
  )
  const candidate = value as UnsignedStocksDeployment
  const rebuilt = await prepareStocksDeployment(candidate.input, artifacts)
  requireValue(canonical(candidate) === canonical(rebuilt), "DEPLOYMENT_PLAN_CHANGED")
  return rebuilt
}

/** Pure pre-send guard. The authorized external executor supplies fresh chain observations. */
export function assertPreparedStep(
  plan: UnsignedStocksDeployment,
  index: number,
  observed: {
    chainId: number
    deployer: string
    pendingNonce: string
    completed: { index: number; address: string; runtimeCodeHash: string }[]
  },
) {
  const { planDigest, ...body } = plan
  requireValue(digest(body) === planDigest, "DEPLOYMENT_PLAN_CHANGED")
  requireValue(
    Number.isInteger(index) && index >= 0 && index < 5 && plan.steps[index]?.index === index,
    "INVALID_DEPLOYMENT_STEP",
  )
  requireValue(
    observed.chainId === 91342 && publicAddress(observed.deployer) === plan.input.deployer,
    "DEPLOYMENT_NETWORK_OR_SENDER_CHANGED",
  )
  requireValue(
    nonce(observed.pendingNonce) === BigInt(plan.steps[index].transaction.nonce),
    "DEPLOYMENT_NONCE_CHANGED",
  )
  requireValue(observed.completed.length === index, "DEPLOYMENT_SEQUENCE_INCOMPLETE")
  for (const [prior, item] of observed.completed.entries())
    requireValue(
      item.index === prior &&
        publicAddress(item.address) === plan.steps[prior].predictedAddress &&
        item.runtimeCodeHash === plan.steps[prior].expectedRuntimeCodeHash,
      "PRIOR_DEPLOYMENT_EVIDENCE_MISMATCH",
    )
  return plan.steps[index].transaction
}

/** Reads only the five named local artifacts and their build-info files; no Hardhat config import. */
export function filesystemStocksArtifacts(directory: string): ArtifactReader {
  const root = path.resolve(directory)
  const location = (qualified: string) => {
    const name = names.find((name) => fullyQualified(name) === qualified)
    requireValue(name, "UNEXPECTED_ARTIFACT_REQUEST")
    return path.join(root, "contracts", "stocks", `${name}.sol`, name)
  }
  return {
    async readArtifact(name) {
      return JSON.parse(await readFile(`${location(name)}.json`, "utf8")) as Artifact
    },
    async getBuildInfo(name) {
      const file = location(name)
      const debug = JSON.parse(await readFile(`${file}.dbg.json`, "utf8")) as { buildInfo: string }
      requireValue(typeof debug.buildInfo === "string", "MISSING_BUILD_INFO")
      const target = path.resolve(path.dirname(file), debug.buildInfo)
      requireValue(
        path.dirname(target) === path.join(root, "build-info") && target.endsWith(".json"),
        "UNEXPECTED_BUILD_INFO_PATH",
      )
      return JSON.parse(await readFile(target, "utf8")) as BuildInfo
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  requireValue(
    args.length === 4 &&
      args[0] === "--input" &&
      args[2] === "--output" &&
      path.isAbsolute(args[1]) &&
      path.isAbsolute(args[3]),
    "Usage: prepare-deployment.ts --input /absolute/public-roles.json --output /absolute/unsigned-plan.json",
  )
  const input = await readPublicDeploymentJson(args[1])
  const artifacts = filesystemStocksArtifacts(path.resolve(__dirname, "../../artifacts/stocks"))
  const plan = await prepareStocksDeployment(input, artifacts)
  await writePublicDeploymentJson(args[3], plan)
  console.log(`Unsigned GIWA testnet plan prepared: ${plan.planDigest}`)
  console.log(
    "No transaction was signed or broadcast; fees, external signer and finalized deployment evidence remain required.",
  )
}
if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unsigned deployment preparation failed")
    process.exitCode = 1
  })
