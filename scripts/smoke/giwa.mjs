import { validateServerEnv } from "../../server/dist/config/env.js"
import { readRegistryFile } from "../../server/dist/registry/io.js"
import { validateGiwaRegistry } from "../../server/dist/registry/validation.js"

const registry = readRegistryFile()
const registryResult = validateGiwaRegistry(registry)
if (!registryResult.ok) {
  console.error(JSON.stringify(registryResult, null, 2))
  process.exit(1)
}

if (process.env.CHECK_SERVER_ENV === "true") {
  validateServerEnv(process.env)
}

console.log(
  JSON.stringify({
    ok: true,
    registryMode: registry.activationFlags.deployed ? "deployed" : "not-yet-deployed",
    liveRpcChecked: false,
  }),
)
