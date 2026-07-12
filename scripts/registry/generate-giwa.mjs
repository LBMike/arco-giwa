import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { mkdirSync } from "node:fs"
import { buildDryRunGiwaRegistry } from "../../server/dist/registry/generate.js"
import { DEFAULT_GIWA_REGISTRY_PATH } from "../../server/dist/registry/io.js"
import { validateGiwaRegistry } from "../../server/dist/registry/validation.js"

const registry = buildDryRunGiwaRegistry()
const result = validateGiwaRegistry(registry)
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2))
  process.exit(1)
}

const outputPath = process.env.GIWA_REGISTRY_PATH ?? DEFAULT_GIWA_REGISTRY_PATH
mkdirSync(dirname(join(process.cwd(), outputPath)), { recursive: true })
writeFileSync(join(process.cwd(), outputPath), `${JSON.stringify(registry, null, 2)}\n`)
console.log(`Wrote ${outputPath}`)
