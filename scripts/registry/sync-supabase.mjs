import { createPrismaClient } from "../../server/dist/db/prisma.js"
import { readRegistryFile } from "../../server/dist/registry/io.js"
import { registryToSyncInput, validateGiwaRegistry } from "../../server/dist/registry/validation.js"
import { PrismaArcoService } from "../../server/dist/services/prisma-arco-service.js"

const registry = readRegistryFile()
const validation = validateGiwaRegistry(registry)
if (!validation.ok) {
  console.error(JSON.stringify(validation, null, 2))
  process.exit(1)
}

const allowSample = process.env.ALLOW_SAMPLE_REGISTRY_SYNC === "true"
const input = registryToSyncInput(registry, allowSample)
const prisma = createPrismaClient()
const arco = new PrismaArcoService(prisma)
await arco.syncRegistry(input)
console.log(
  JSON.stringify({
    ok: true,
    releaseId: registry.releaseId,
    mode: registry.activationFlags.deployed ? "deployed" : "sample-sync",
  }),
)
