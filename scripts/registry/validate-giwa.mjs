import { createPublicClient, http } from "viem"
import { readRegistryFile } from "../../server/dist/registry/io.js"
import {
  attestRegistryOnchain,
  validateGiwaRegistry,
} from "../../server/dist/registry/validation.js"

const registry = readRegistryFile()
const local = validateGiwaRegistry(registry)

if (!local.ok) {
  console.error(JSON.stringify(local, null, 2))
  process.exit(1)
}

if (registry.activationFlags.deployed) {
  if (!process.env.INDEXER_RPC_URL) {
    console.error("INDEXER_RPC_URL is required for deployed registry onchain attestation")
    process.exit(1)
  }
  const attestation = await attestRegistryOnchain(registry, createPublicClient({ transport: http(process.env.INDEXER_RPC_URL) }))
  if (!attestation.ok) {
    console.error(JSON.stringify(attestation, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify({ ok: true, mode: "deployed", attestation }, null, 2))
} else {
  console.log(JSON.stringify({ ok: true, mode: "not-yet-deployed", local }, null, 2))
}
