// SINGLE SOURCE OF TRUTH for the vault category taxonomy. Imported by:
//   - src/demo (GiwaCategory union, §2 AdminConfig category dropdown, Add-vault form)
//   - packages/contracts/scripts/deploy-params.ts (2c-2 deploy-params validation)
//   - server/src/app.ts keeps a literal copy for build-layout reasons, guarded by a
//     drift test in server/src/app.test.ts that compares against this file.
//
// NOTE the exact strings: the internal value is "U.S Treasuries" (NO period) — the
// period appears only in display titles. Changing any value here is a data migration
// (saved VaultConfig category overrides + filter mappings), not a rename.
export const VAULT_CATEGORIES = ["U.S Treasuries", "Prime Credit", "Arco Saving", "Equity Exposure"] as const

export type VaultCategory = (typeof VAULT_CATEGORIES)[number]

export function isVaultCategory(value: unknown): value is VaultCategory {
  return typeof value === "string" && (VAULT_CATEGORIES as readonly string[]).includes(value)
}

// Vault classification (distinct from category): "product" vaults appear in Products, "saving"
// vaults appear only on the Savings page. Same single-source + drift-guard pattern as categories:
// server/src/app.ts keeps a literal copy, checked by a drift test in server/src/app.test.ts.
export const VAULT_KINDS = ["product", "saving"] as const

export type VaultKind = (typeof VAULT_KINDS)[number]

export function isVaultKind(value: unknown): value is VaultKind {
  return typeof value === "string" && (VAULT_KINDS as readonly string[]).includes(value)
}
