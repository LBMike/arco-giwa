import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { GiwaDeploymentRegistry } from "./types.js"

export const DEFAULT_GIWA_REGISTRY_PATH = "deployments/91342/arco-giwa-preprod.json"

export function registryPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.GIWA_REGISTRY_PATH ?? DEFAULT_GIWA_REGISTRY_PATH
}

export function readRegistryFile(path = registryPathFromEnv()): GiwaDeploymentRegistry {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as GiwaDeploymentRegistry
}
