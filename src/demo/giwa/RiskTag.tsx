import type { VaultCategory } from "../../../shared/vault-taxonomy"
import { digiftDisplayCategory, type DigiFTDisplayCategory, type DigiFTReferenceAsset } from "./digift-reference-assets"

export type RiskLevel = "low" | "medium" | "high"

// Investor-facing risk tier per category. The Strategies cards ("<tier> Risk Strategies") and the
// funds-list tags read these same tiers, so a product's tag always matches its card. Arco Saving has
// no tier: it is hidden from the investor Strategies section and gets no tag.
const VAULT_CATEGORY_RISK: Partial<Record<VaultCategory, RiskLevel>> = {
  "U.S Treasuries": "low",
  "Prime Credit": "medium",
  "Equity Exposure": "high",
}

// DigiFT reference products have their own category names; this is Arco's display mapping, not
// DigiFT source data. It reads the category Arco shows, so GOLDX (shown as Commodity) is Medium.
const DIGIFT_CATEGORY_RISK: Record<DigiFTDisplayCategory, RiskLevel> = {
  "Cash Management": "low",
  "Income Strategies": "medium",
  Commodity: "medium",
  "Equity Exposure": "high",
  "Alternative Assets": "high",
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

export function digiftCategoryRisk(category: DigiFTDisplayCategory): RiskLevel {
  return DIGIFT_CATEGORY_RISK[category]
}

// A reference product's tier, read from the category Arco shows for it (never the raw DigiFT one).
export function digiftAssetRisk(asset: Pick<DigiFTReferenceAsset, "id" | "category">): RiskLevel {
  return digiftCategoryRisk(digiftDisplayCategory(asset))
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
