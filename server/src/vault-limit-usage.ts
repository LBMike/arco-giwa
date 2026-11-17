import { formatUnits } from "viem"

// How much of a vault's on-chain limits is already used. The vaults count CUMULATIVE mints
// (mintedByVault) and CUMULATIVE redemptions (redeemedByVault) against their allowances: a
// redemption never gives mint allowance back, so a vault can be "full" while its token supply is
// far below the supply cap. Deposits then revert with "ADV: vault allowance" (or "ADV: max supply"
// at the cap) and withdrawals with "ARV: vault allowance". This turns the raw reads into the
// numbers an operator needs before that happens.

export type LimitUsageLevel = "ok" | "near" | "exhausted"

// A side is "near" its limit once this share of it is used.
export const LIMIT_NEAR_BPS = 8000n

export type LimitUsageSide = {
  /** Human units (shares for deposits, payment asset for withdrawals). */
  readonly used: string
  readonly limit: string
  readonly remaining: string
  /** 0–100, two decimals at most; 100 when the limit is 0. */
  readonly usedPct: number
  readonly level: LimitUsageLevel
}

export type DepositLimitUsage = {
  /** Lifetime shares minted by the deposit vault vs vaultMintAllowance. */
  readonly mintAllowance: LimitUsageSide
  /** Product token totalSupply vs maxSupplyCap; null when the supply could not be read. */
  readonly supplyCap: LimitUsageSide | null
  /** Shares the next deposit can still mint: the smaller of the two remainders. */
  readonly remainingShares: string
  /** Which check a too-large deposit hits first. */
  readonly binding: "mintAllowance" | "supplyCap"
  readonly level: LimitUsageLevel
}

export type VaultLimitUsage = {
  readonly deposit: DepositLimitUsage
  /** Lifetime payment assets redeemed by the redemption vault vs vaultRedeemAllowance. */
  readonly redemption: LimitUsageSide
}

export type VaultLimitUsageInput = {
  readonly vaultMintAllowance: string
  readonly maxSupplyCap: string
  readonly vaultRedeemAllowance: string
  readonly mintedByVault: string
  readonly redeemedByVault: string
  readonly shareSupply?: string | null
}

function side(usedRaw: bigint, limitRaw: bigint, decimals: number): LimitUsageSide {
  const remainingRaw = limitRaw > usedRaw ? limitRaw - usedRaw : 0n
  // Basis points, capped at 100%. A zero limit is fully used by definition.
  const usedBps = limitRaw === 0n ? 10000n : usedRaw >= limitRaw ? 10000n : (usedRaw * 10000n) / limitRaw
  const level: LimitUsageLevel = remainingRaw === 0n ? "exhausted" : usedBps >= LIMIT_NEAR_BPS ? "near" : "ok"
  return {
    used: formatUnits(usedRaw, decimals),
    limit: formatUnits(limitRaw, decimals),
    remaining: formatUnits(remainingRaw, decimals),
    usedPct: Number(usedBps) / 100,
    level,
  }
}

const LEVEL_RANK: Record<LimitUsageLevel, number> = { ok: 0, near: 1, exhausted: 2 }

/** Pure: raw base-unit strings in, operator-facing usage out. Shares are 18-decimal. */
export function computeVaultLimitUsage(raw: VaultLimitUsageInput, paymentDecimals: number): VaultLimitUsage {
  const mintAllowance = side(BigInt(raw.mintedByVault), BigInt(raw.vaultMintAllowance), 18)
  const supplyCap = raw.shareSupply == null ? null : side(BigInt(raw.shareSupply), BigInt(raw.maxSupplyCap), 18)

  const allowanceLeft = BigInt(raw.vaultMintAllowance) > BigInt(raw.mintedByVault) ? BigInt(raw.vaultMintAllowance) - BigInt(raw.mintedByVault) : 0n
  const capLeft =
    raw.shareSupply == null
      ? null
      : BigInt(raw.maxSupplyCap) > BigInt(raw.shareSupply)
        ? BigInt(raw.maxSupplyCap) - BigInt(raw.shareSupply)
        : 0n
  const capBinds = capLeft !== null && capLeft < allowanceLeft
  const worst = supplyCap && LEVEL_RANK[supplyCap.level] > LEVEL_RANK[mintAllowance.level] ? supplyCap.level : mintAllowance.level

  return {
    deposit: {
      mintAllowance,
      supplyCap,
      remainingShares: formatUnits(capBinds ? (capLeft as bigint) : allowanceLeft, 18),
      binding: capBinds ? "supplyCap" : "mintAllowance",
      level: worst,
    },
    redemption: side(BigInt(raw.redeemedByVault), BigInt(raw.vaultRedeemAllowance), paymentDecimals),
  }
}
