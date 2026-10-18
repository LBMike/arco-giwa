// ArcoUSD server settings (all optional; nothing here is secret). Parsed apart from
// validateServerEnv and NEVER throws, so a bad ArcoUSD value cannot stop the API or the core
// indexer from starting. An invalid value falls back to its default and is listed in `invalid`:
// the service then closes the buy gate (fail closed) and both processes log it.
export type ArcoUSDEnvKey = "ARCOUSD_BUY_GATE_MIN" | "ARCOUSD_BUY_GATE_ASSET" | "ARCOUSD_SNAPSHOT_INTERVAL_MS"

export type ArcoUSDEnv = {
  /** deployments/91342/arcousd-giwa.json unless ARCOUSD_REGISTRY_PATH is set. */
  readonly registryPath: string
  /** Reserve asset whose free buffer gates product buys (tUSDC). */
  readonly buyGateAsset: string
  /** Minimum free buffer, in whole units of that asset, for buys to stay enabled. */
  readonly buyGateMin: string
  /** Indexer: how often to store a Lens snapshot (ms, >= 60000). */
  readonly snapshotIntervalMs: number
  /** Variables that were set but invalid (their defaults are used instead). */
  readonly invalid: readonly ArcoUSDEnvKey[]
}

const DEFAULTS = { buyGateAsset: "tUSDC", buyGateMin: "1000", snapshotIntervalMs: 300_000 } as const

export function parseArcoUSDEnv(env: NodeJS.ProcessEnv): ArcoUSDEnv {
  const invalid: ArcoUSDEnvKey[] = []
  // An empty value (a placeholder in an env group) counts as unset, for every ARCOUSD_* key.
  const read = (key: ArcoUSDEnvKey | "ARCOUSD_REGISTRY_PATH") => {
    const value = env[key]?.trim()
    return value ? value : undefined
  }

  let buyGateMin: string = DEFAULTS.buyGateMin
  const rawMin = read("ARCOUSD_BUY_GATE_MIN")
  if (rawMin !== undefined) {
    if (/^\d+(\.\d+)?$/.test(rawMin)) buyGateMin = rawMin
    else invalid.push("ARCOUSD_BUY_GATE_MIN")
  }

  let buyGateAsset: string = DEFAULTS.buyGateAsset
  const rawAsset = read("ARCOUSD_BUY_GATE_ASSET")
  if (rawAsset !== undefined) {
    if (/^[A-Za-z0-9]{2,12}$/.test(rawAsset)) buyGateAsset = rawAsset
    else invalid.push("ARCOUSD_BUY_GATE_ASSET")
  }

  let snapshotIntervalMs: number = DEFAULTS.snapshotIntervalMs
  const rawInterval = read("ARCOUSD_SNAPSHOT_INTERVAL_MS")
  if (rawInterval !== undefined) {
    const value = Number(rawInterval)
    if (Number.isInteger(value) && value >= 60_000) snapshotIntervalMs = value
    else invalid.push("ARCOUSD_SNAPSHOT_INTERVAL_MS")
  }

  return {
    registryPath: read("ARCOUSD_REGISTRY_PATH") ?? "deployments/91342/arcousd-giwa.json",
    buyGateAsset,
    buyGateMin,
    snapshotIntervalMs,
    invalid,
  }
}

/** A gate setting is invalid: once ArcoUSD is deployed the gate stays closed until it is fixed. */
export function gateConfigInvalid(env: ArcoUSDEnv): boolean {
  return env.invalid.some((key) => key.startsWith("ARCOUSD_BUY_GATE_"))
}
