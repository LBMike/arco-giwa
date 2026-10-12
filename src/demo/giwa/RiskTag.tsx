import type { VaultCategory } from "../../../shared/vault-taxonomy"

export type RiskLevel = "low" | "medium" | "high"

// Investor-facing risk tier per category. The Strategies cards ("<tier> Risk") and the funds-list
// tags read these same tiers, so a product's tag always matches its card. Deployed vaults and the
// listed funds share the taxonomy, so this one map covers both. Arco Saving has no tier: it is
// hidden from the investor Strategies section and gets no tag.
const VAULT_CATEGORY_RISK: Partial<Record<VaultCategory, RiskLevel>> = {
  "U.S Treasuries": "low",
  "Prime Credit": "medium",
  "Equity Exposure": "high",
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: "Low Risk",
  medium: "Medium Risk",
  high: "High Risk",
}

const RISK_TONE: Record<RiskLevel, string> = {
  low: "bg-[var(--color-risk-low-bg)] text-[var(--color-risk-low-ink)]",
  medium: "bg-[var(--color-risk-medium-bg)] text-[var(--color-risk-medium-ink)]",
  high: "bg-[var(--color-risk-high-bg)] text-[var(--color-risk-high-ink)]",
}

export function vaultCategoryRisk(category: VaultCategory): RiskLevel | null {
  return VAULT_CATEGORY_RISK[category] ?? null
}

// Admin dropdown label for a taxonomy value: names the tier customers will see for it. The option
// value stays the bare category.
export function categoryOptionLabel(category: VaultCategory): string {
  const tier = vaultCategoryRisk(category)
  return tier ? `${category} · ${RISK_LABEL[tier]}` : `${category} · no risk tag`
}

export function RiskTag({ level }: { level: RiskLevel }) {
  return (
    <span
      data-risk={level}
      className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none ${RISK_TONE[level]}`}
    >
      {RISK_LABEL[level]}
    </span>
  )
}
