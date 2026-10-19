import { getAddress, isAddress } from "viem"

// ArcoUSD queue keeper settings (docs/operations/arcousd-keeper.md). Nothing here is secret: the
// keeper's key arrives as two platform secret files (keystore + password), never through the
// environment. Unlike the alert settings, a bad value here is not papered over with a default:
// outside `off` the keeper refuses to start (fail closed) and names the variable.

export type KeeperMode = "off" | "dry-run" | "live"

export type ArcoUSDKeeperEnvKey =
  | "ARCOUSD_KEEPER_MODE"
  | "ARCOUSD_KEEPER_ADDRESS"
  | "ARCOUSD_KEEPER_INTERVAL_MS"
  | "ARCOUSD_KEEPER_BATCH"
  | "ARCOUSD_KEEPER_GAS_LIMIT"
  | "ARCOUSD_KEEPER_MAX_FEE_WEI"
  | "ARCOUSD_KEEPER_PRIORITY_FEE_WEI"
  | "ARCOUSD_KEEPER_LOW_GAS_WEI"

export type ArcoUSDKeeperEnv = {
  /** off: idle (default) · dry-run: simulate and report, never sign · live: sign and send. */
  readonly mode: KeeperMode
  /** The keeper wallet (checksummed); its keystore must decrypt to exactly this address. */
  readonly address: `0x${string}` | null
  readonly intervalMs: number
  /** processQueue maxCount per transaction (1..50). */
  readonly batch: number
  /** Fixed gas limit per transaction: unused gas is not charged; processQueue stops early below 150k left. */
  readonly gasLimit: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  /** Below this wallet balance (wei) the watcher warns that the keeper is running out of gas. */
  readonly lowGasWei: bigint
  readonly invalid: readonly ArcoUSDKeeperEnvKey[]
}

export const KEEPER_DEFAULTS = {
  intervalMs: 60_000,
  batch: 20,
  gasLimit: 3_000_000n,
  maxFeePerGas: 1_000_000_000n, // 1 gwei ceiling; GIWA's base fee is far below it, and only base + tip is paid
  maxPriorityFeePerGas: 1_000_000n, // 0.001 gwei
  lowGasWei: 10_000_000_000_000_000n, // 0.01 ETH
} as const

const LIMITS = {
  gasLimit: [200_000n, 15_000_000n],
  maxFeePerGas: [1n, 100_000_000_000n], // up to 100 gwei
  lowGasWei: [0n, 10n ** 21n],
} as const

export function parseArcoUSDKeeperEnv(env: NodeJS.ProcessEnv): ArcoUSDKeeperEnv {
  const invalid: ArcoUSDKeeperEnvKey[] = []
  const read = (key: ArcoUSDKeeperEnvKey) => {
    const value = env[key]?.trim()
    return value ? value : undefined
  }
  const integer = (key: ArcoUSDKeeperEnvKey, fallback: number, min: number, max: number) => {
    const raw = read(key)
    if (raw === undefined) return fallback
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value
    invalid.push(key)
    return fallback
  }
  const wei = (key: ArcoUSDKeeperEnvKey, fallback: bigint, [min, max]: readonly [bigint, bigint]) => {
    const raw = read(key)
    if (raw === undefined) return fallback
    if (/^\d{1,30}$/.test(raw)) {
      const value = BigInt(raw)
      if (value >= min && value <= max) return value
    }
    invalid.push(key)
    return fallback
  }

  let mode: KeeperMode = "off"
  const rawMode = read("ARCOUSD_KEEPER_MODE")
  if (rawMode !== undefined) {
    if (rawMode === "off" || rawMode === "dry-run" || rawMode === "live") mode = rawMode
    else invalid.push("ARCOUSD_KEEPER_MODE")
  }

  let address: `0x${string}` | null = null
  const rawAddress = read("ARCOUSD_KEEPER_ADDRESS")
  if (rawAddress !== undefined) {
    if (isAddress(rawAddress, { strict: false })) address = getAddress(rawAddress)
    else invalid.push("ARCOUSD_KEEPER_ADDRESS")
  } else if (mode !== "off") {
    invalid.push("ARCOUSD_KEEPER_ADDRESS") // required to simulate as, and to check the keystore against
  }

  const intervalMs = integer("ARCOUSD_KEEPER_INTERVAL_MS", KEEPER_DEFAULTS.intervalMs, 15_000, 3_600_000)
  const batch = integer("ARCOUSD_KEEPER_BATCH", KEEPER_DEFAULTS.batch, 1, 50)
  const gasLimit = wei("ARCOUSD_KEEPER_GAS_LIMIT", KEEPER_DEFAULTS.gasLimit, LIMITS.gasLimit)
  const maxFeePerGas = wei("ARCOUSD_KEEPER_MAX_FEE_WEI", KEEPER_DEFAULTS.maxFeePerGas, LIMITS.maxFeePerGas)
  const maxPriorityFeePerGas = wei("ARCOUSD_KEEPER_PRIORITY_FEE_WEI", KEEPER_DEFAULTS.maxPriorityFeePerGas, [0n, LIMITS.maxFeePerGas[1]])
  if (maxPriorityFeePerGas > maxFeePerGas && !invalid.includes("ARCOUSD_KEEPER_PRIORITY_FEE_WEI")) invalid.push("ARCOUSD_KEEPER_PRIORITY_FEE_WEI")
  const lowGasWei = wei("ARCOUSD_KEEPER_LOW_GAS_WEI", KEEPER_DEFAULTS.lowGasWei, LIMITS.lowGasWei)

  return { mode, address, intervalMs, batch, gasLimit, maxFeePerGas, maxPriorityFeePerGas, lowGasWei, invalid }
}

/** The most one keeper transaction can cost (gas limit × fee ceiling), in wei. */
export function maxTransactionFee(env: Pick<ArcoUSDKeeperEnv, "gasLimit" | "maxFeePerGas">): bigint {
  return env.gasLimit * env.maxFeePerGas
}
