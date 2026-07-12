import { readFileSync } from "fs"
import path from "path"
import { GIWA_EXPLORER_BASE_URL } from "./keystore-constants"
import { REGISTRY_OUTPUT_PATH } from "./deploy-plan"

type RegistryWithDeployments = {
  deploymentRecords?: Array<{
    key: string
    logicalLabel: string
    contractName: string
    proxy: string
    implementation: string
  }>
}

function repoRoot() {
  return path.resolve(__dirname, "../../..")
}

function main() {
  const registryPath = path.join(repoRoot(), REGISTRY_OUTPUT_PATH)
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryWithDeployments
  const records = registry.deploymentRecords ?? []
  if (!records.length) {
    throw new Error(`No deploymentRecords found in ${registryPath}`)
  }

  console.log(
    JSON.stringify(
      {
        mode: "blockscout-verification-scaffold",
        registryPath,
        explorer: GIWA_EXPLORER_BASE_URL,
        note: "Run these after the GIWA broadcast. Constructor args are intentionally deferred for manual review before submission.",
        contracts: records.map((record) => ({
          key: record.key,
          label: record.logicalLabel,
          contractName: record.contractName,
          proxy: record.proxy,
          implementation: record.implementation,
          proxyExplorerUrl: `${GIWA_EXPLORER_BASE_URL}/address/${record.proxy}`,
          implementationExplorerUrl: `${GIWA_EXPLORER_BASE_URL}/address/${record.implementation}`,
          implementationVerifyCommand: `cd packages/contracts && corepack yarn hardhat verify --network giwaSepolia ${record.implementation}`,
        })),
      },
      null,
      2,
    ),
  )
}

main()
