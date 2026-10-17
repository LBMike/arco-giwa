import { parseAdminOperatorsEnv, type AdminOperator } from "../admin-auth/operators.js"
import { parseAdminWithdrawAllowlist } from "../admin-auth/withdraw-allowlist.js"

const SERVER_ONLY_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "INDEXER_RPC_URL",
  "AUTH_JWT_SECRET",
] as const

const FRONTEND_PUBLIC_KEYS = [
  "VITE_DYNAMIC_ENVIRONMENT_ID",
  "VITE_PUBLIC_GIWA_RPC",
  "VITE_GIWA_CHAIN_ID",
  "VITE_GIWA_EXPLORER",
  "VITE_ARCO_API_BASE",
] as const

export type ServerEnv = {
  readonly port: number
  readonly corsAllowedOrigins: readonly string[]
  readonly authNonceTtlSeconds: number
  readonly databaseUrl: string
  readonly directUrl: string
  readonly indexerRpcUrl: string
  readonly authJwtSecret: string
  /** Legacy shared operator token ("" when unset); required and honored only when adminLegacyTokenAuth. */
  readonly adminOperatorToken: string
  /** ADMIN_LEGACY_TOKEN_AUTH=1 re-enables x-operator-token on the Vault admin routes. */
  readonly adminLegacyTokenAuth: boolean
  /** ADMIN_OPERATORS: the Vault operator directory. Unset or [] denies every Vault admin route. */
  readonly adminOperators: readonly AdminOperator[]
  /** ADMIN_WITHDRAW_ALLOWLIST (lowercased): extra withdrawTo recipients beyond each product's adminDepositAddress. */
  readonly adminWithdrawAllowlist: readonly string[]
  readonly giwaChainId: number
  readonly indexerConfirmations: number
  readonly indexerMaxBlockRange: bigint
  readonly indexerPollIntervalMs: number
  readonly registryPath: string
}

export function parseCorsAllowedOrigins(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function assertNoWildcardCors(origins: readonly string[]): void {
  if (origins.includes("*")) {
    throw new Error("CORS_ALLOWED_ORIGINS must be explicit; '*' is not allowed")
  }
}

export function validateServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  for (const key of SERVER_ONLY_KEYS) {
    if (!env[key]) throw new Error(`${key} is required in server env`)
  }

  for (const key of FRONTEND_PUBLIC_KEYS) {
    if (key.includes("SECRET") || key.endsWith("_KEY")) {
      throw new Error(`${key} looks secret-like and must not be VITE_*`)
    }
  }

  const legacyTokenFlag = env.ADMIN_LEGACY_TOKEN_AUTH ?? ""
  if (!["", "0", "1"].includes(legacyTokenFlag)) {
    throw new Error("ADMIN_LEGACY_TOKEN_AUTH must be 1 (enabled) or 0/unset (disabled)")
  }
  const adminLegacyTokenAuth = legacyTokenFlag === "1"
  if (adminLegacyTokenAuth && !env.ADMIN_OPERATOR_TOKEN) {
    throw new Error("ADMIN_OPERATOR_TOKEN is required when ADMIN_LEGACY_TOKEN_AUTH=1")
  }

  let adminOperators: AdminOperator[]
  try {
    adminOperators = parseAdminOperatorsEnv(env.ADMIN_OPERATORS)
  } catch {
    // Never echo the configured value.
    throw new Error(
      'ADMIN_OPERATORS must be a JSON array of {"wallet","operatorId","permissions":["vault:read"|"vault:write"]} with unique wallets and ids',
    )
  }

  // Throws a fixed message (never the configured value) on a malformed list.
  const adminWithdrawAllowlist = parseAdminWithdrawAllowlist(env.ADMIN_WITHDRAW_ALLOWLIST)

  const corsAllowedOrigins = parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS)
  assertNoWildcardCors(corsAllowedOrigins)

  const authNonceTtlSeconds = Number(env.AUTH_NONCE_TTL_SECONDS ?? "300")
  if (!Number.isInteger(authNonceTtlSeconds) || authNonceTtlSeconds <= 0 || authNonceTtlSeconds > 300) {
    throw new Error("AUTH_NONCE_TTL_SECONDS must be an integer between 1 and 300")
  }

  const giwaChainId = Number(env.GIWA_CHAIN_ID ?? "91342")
  if (giwaChainId !== 91342) throw new Error("GIWA_CHAIN_ID must be 91342")

  const indexerConfirmations = Number(env.INDEXER_CONFIRMATIONS ?? "5")
  if (!Number.isInteger(indexerConfirmations) || indexerConfirmations < 0) {
    throw new Error("INDEXER_CONFIRMATIONS must be a non-negative integer")
  }

  const indexerMaxBlockRange = BigInt(env.INDEXER_MAX_BLOCK_RANGE ?? "500")
  if (indexerMaxBlockRange <= 0n) throw new Error("INDEXER_MAX_BLOCK_RANGE must be positive")

  const indexerPollIntervalMs = Number(env.INDEXER_POLL_INTERVAL_MS ?? "5000")
  if (!Number.isInteger(indexerPollIntervalMs) || indexerPollIntervalMs < 1000) {
    throw new Error("INDEXER_POLL_INTERVAL_MS must be an integer >= 1000")
  }

  return {
    port: Number(env.PORT ?? "8080"),
    corsAllowedOrigins,
    authNonceTtlSeconds,
    databaseUrl: env.DATABASE_URL!,
    directUrl: env.DIRECT_URL!,
    indexerRpcUrl: env.INDEXER_RPC_URL!,
    authJwtSecret: env.AUTH_JWT_SECRET!,
    adminOperatorToken: env.ADMIN_OPERATOR_TOKEN ?? "",
    adminLegacyTokenAuth,
    adminOperators,
    adminWithdrawAllowlist,
    giwaChainId,
    indexerConfirmations,
    indexerMaxBlockRange,
    indexerPollIntervalMs,
    registryPath: env.GIWA_REGISTRY_PATH ?? "deployments/91342/arco-giwa-preprod.json",
  }
}
