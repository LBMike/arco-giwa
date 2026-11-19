// ArcoGOLD server settings (optional; nothing here is secret). Never throws.
export type ArcoGoldEnv = {
  /** deployments/91342/arcogold-giwa.json unless ARCOGOLD_REGISTRY_PATH is set (an empty value counts as unset). */
  readonly registryPath: string
}

export const ARCOGOLD_REGISTRY_DEFAULT_PATH = "deployments/91342/arcogold-giwa.json"

export function parseArcoGoldEnv(env: NodeJS.ProcessEnv): ArcoGoldEnv {
  const path = env.ARCOGOLD_REGISTRY_PATH?.trim()
  return { registryPath: path ? path : ARCOGOLD_REGISTRY_DEFAULT_PATH }
}
