import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, ChevronDown, Loader2 } from "lucide-react"
import { giwaApi } from "./api"
import { vaultConfigOf, vaultDisplayName } from "./catalog"
import { buildSavingsAccounts, type SavingsAccount } from "./savings"
import { BrandMark } from "../components/BrandMark"
import { explorerAddress } from "./wallet"
import { shortAddr } from "../lib/format"
import { useGiwaAdmin } from "./GiwaAdminLayout"
import type { GiwaCatalogItem, GiwaVaultConfig } from "./types"
import { VAULT_CATEGORIES, type VaultCategory } from "../../../shared/vault-taxonomy"
import { bpsToPercentInput, parseDecimalInput, percentInputToBps, validateAcceptAssets, validatePortfolioSlices } from "./display-profile"
import type { GiwaAcceptAsset, GiwaPortfolioSlice } from "./types"
import {
  DEPLOY_PARAMS_DEFAULTS,
  validateDeployParams,
  type DeployParamsFile,
  type DeployParamsInit,
} from "../../../packages/contracts/scripts/deploy-params"

// Category is a fixed-taxonomy dropdown (never free text): the investor filter bar,
// strategy-card mapping and row highlight consult it, so an off-taxonomy value would
// make a vault unfilterable. Single source: shared/vault-taxonomy.ts (also used by the
// 2c-2 deploy-params schema, so the Add-vault form below can never drift from here).
const CATEGORY_OPTIONS = VAULT_CATEGORIES

type CardKey = "cardSnapshot" | "cardIndustry" | "cardExposure"
const CARD_TOGGLES: { key: CardKey; label: string }[] = [
  { key: "cardSnapshot", label: "Snapshot" },
  { key: "cardIndustry", label: "Industry" },
  { key: "cardExposure", label: "Exposure" },
]

// Portfolio slice editor row (P3): the three fields kept as editable strings.
type SliceRow = { label: string; percent: string; valueUsd: string }
type PortfolioKey = "portfolioSnapshot" | "portfolioIndustry" | "portfolioExposure"
const PORTFOLIO_EDITORS: { key: PortfolioKey; label: string }[] = [
  { key: "portfolioSnapshot", label: "Snapshot" },
  { key: "portfolioIndustry", label: "Industry" },
  { key: "portfolioExposure", label: "Exposure" },
]

function sliceRowsFrom(slices: GiwaPortfolioSlice[] | null): SliceRow[] {
  return (slices ?? []).map((slice) => ({
    label: slice.label,
    percent: String(slice.percent),
    valueUsd: slice.valueUsd == null ? "" : String(slice.valueUsd),
  }))
}

// Build a saveable slice value from editor rows: fully-blank set => null (clear override);
// otherwise decimal-parse each kept row (blank/invalid percent is an error, not a silent 0)
// then run the shared validator (same rules the server enforces). Exported for tests.
export function buildSlicesForSave(rows: SliceRow[]): { value: GiwaPortfolioSlice[] | null } | { error: string } {
  const nonEmpty = rows.filter((row) => row.label.trim() !== "" || row.percent.trim() !== "" || row.valueUsd.trim() !== "")
  if (nonEmpty.length === 0) return { value: null }
  const candidate: GiwaPortfolioSlice[] = []
  for (const [index, row] of nonEmpty.entries()) {
    const percent = parseDecimalInput(row.percent)
    if (percent === null || percent === "invalid") {
      return { error: `slice ${index + 1} ("${row.label.trim() || "?"}"): percent must be a number 0–100` }
    }
    const valueUsd = parseDecimalInput(row.valueUsd)
    if (valueUsd === "invalid") return { error: `slice ${index + 1}: USD value must be a number` }
    candidate.push({ label: row.label.trim(), percent, valueUsd })
  }
  const result = validatePortfolioSlices(candidate)
  if (!result.ok) return { error: result.error ?? "invalid portfolio data" }
  return { value: result.slices ?? null }
}

// Sum for the live badge; flags any kept row whose percent is blank/non-decimal so the
// badge cannot show a green "✓" while the save would actually be rejected.
export function sliceRowsSummary(rows: SliceRow[]): { sum: number; hasInvalid: boolean } {
  let sum = 0
  let hasInvalid = false
  for (const row of rows) {
    const kept = row.label.trim() !== "" || row.percent.trim() !== "" || row.valueUsd.trim() !== ""
    if (!kept) continue
    const percent = parseDecimalInput(row.percent)
    if (typeof percent === "number") sum += percent
    else hasInvalid = true // blank or non-decimal on a kept row
    if (parseDecimalInput(row.valueUsd) === "invalid") hasInvalid = true
  }
  return { sum, hasInvalid }
}

// Accept-asset editor row (Savings): the operator edits symbol/icon/isDummy plus an APY that only
// applies to a dummy (coming-soon) asset — a real asset's APY is read live from its vault. The
// stored `savingVaultId` (real → this vault; dummy → null) is derived at save. `sortOrder` (the
// global cross-vault Savings order, owned by the SavingsOrderCard) is a hidden, non-editable field
// that RIDES on the row so a per-vault edit/add/remove never wipes a sibling's order.
type AcceptRow = { symbol: string; icon: string; apy: string; isDummy: boolean; sortOrder: number | null }

function acceptRowsFrom(assets: GiwaAcceptAsset[] | null): AcceptRow[] {
  return (assets ?? []).map((asset) => ({
    symbol: asset.symbol,
    icon: asset.icon ?? "",
    apy: asset.apy == null ? "" : String(asset.apy),
    isDummy: asset.isDummy,
    sortOrder: asset.sortOrder ?? null,
  }))
}

// Build a saveable accept-asset array from editor rows for the given saving vault: a fully-blank
// set => null (clear override). A real row maps to `savingVaultId = savingVaultId` and stores APY
// null (it is read live); a dummy row maps to null and keeps its entered APY (the coming-soon
// display rate). Order is the array index. Runs the shared shape validator (dup symbols, shapes).
// Exported for tests.
export function buildAcceptAssetsForSave(
  rows: AcceptRow[],
  savingVaultId: string,
): { value: GiwaAcceptAsset[] | null } | { error: string } {
  // APY is dummy-only (its input is hidden on a Live row), so a leftover apy string on a Live row
  // must NOT keep an otherwise-blank row alive — else a visually-empty Live row would be submitted
  // and rejected with a misleading "symbol" error. Only a dummy row's apy counts toward non-emptiness.
  const nonEmpty = rows.filter(
    (row) => row.symbol.trim() !== "" || row.icon.trim() !== "" || (row.isDummy && row.apy.trim() !== ""),
  )
  if (nonEmpty.length === 0) return { value: null }
  const candidate: GiwaAcceptAsset[] = []
  for (const [index, row] of nonEmpty.entries()) {
    const at = `accept-asset ${index + 1} ("${row.symbol.trim() || "?"}")`
    // APY only applies to a dummy row (a real asset's rate is live); an entered dummy APY must parse.
    let apy: number | null = null
    if (row.isDummy && row.apy.trim() !== "") {
      const parsed = parseDecimalInput(row.apy)
      if (parsed === null || parsed === "invalid") return { error: `${at}: APY must be a non-negative number` }
      apy = parsed
    }
    candidate.push({
      symbol: row.symbol.trim(),
      icon: row.icon.trim() || null,
      apy,
      savingVaultId: row.isDummy ? null : savingVaultId,
      isDummy: row.isDummy,
      // Carry the global order through untouched — the SavingsOrderCard owns it; a new row trails (null).
      sortOrder: row.sortOrder,
    })
  }
  const result = validateAcceptAssets(candidate)
  if (!result.ok) return { error: result.error ?? "invalid accept-asset data" }
  return { value: (result.assets as GiwaAcceptAsset[] | undefined) ?? null }
}

export default function GiwaAdminConfigPage() {
  const { operatorToken } = useGiwaAdmin()
  // The merged catalog includes hidden vaults (hidden is investor-UI declutter, not
  // access control) — the config page must show every vault.
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog", "admin"], queryFn: giwaApi.catalog })
  const products = catalogQuery.data ?? []
  // The flat cross-vault selector list in its current effective order (market unused → APY not shown
  // here). Drives the single Savings-order panel; empty until a saving vault has accept-assets.
  const savingsAccounts = useMemo(() => buildSavingsAccounts(products, []), [products])

  return (
    <div className="w-full space-y-6">
      <section>
        <p className="text-sm text-[var(--color-arco-muted)]">Admin · Vault Config</p>
        <h1 className="mt-1 text-3xl font-semibold text-[var(--color-arco-ink)]">Vault configuration</h1>
      </section>

      {!operatorToken ? (
        <Card>
          <p className="text-sm text-[var(--color-arco-muted)]">Enter the operator token above to edit vault config.</p>
        </Card>
      ) : (
        <>
          <AddVaultCard products={products} />
          <RegisterVaultCard operatorToken={operatorToken} />
        </>
      )}

      {!operatorToken ? null : catalogQuery.isLoading ? (
        <Card>
          <p className="text-sm text-[var(--color-arco-muted)]">
            <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
            Loading vaults…
          </p>
        </Card>
      ) : catalogQuery.isError ? (
        <Card>
          <p className="text-sm text-[var(--color-arco-down)]">
            Could not load the catalog: {catalogQuery.error instanceof Error ? catalogQuery.error.message : String(catalogQuery.error)}
          </p>
        </Card>
      ) : (
        <>
          {savingsAccounts.length > 0 && (
            // Keyed by the account set/order so it re-seeds when the catalog changes (asset added/
            // removed, or another editor saved) but preserves state during an in-progress reorder.
            <SavingsOrderCard
              key={savingsAccounts.map((account) => `${account.vaultId}:${account.symbol}`).join("|")}
              accounts={savingsAccounts}
              products={products}
              operatorToken={operatorToken}
            />
          )}
          {products.map((product) => (
            <VaultConfigCard key={product.productId} product={product} operatorToken={operatorToken} />
          ))}
        </>
      )}
    </div>
  )
}

/* ── 2c-2: Add vault (generate deploy plan) ─────────────────────────────────
   Emits the deploy-params JSON + the exact harness command. NO network call, NO
   on-chain action — deployment stays in the gated script; the shared schema module
   guarantees the form output is exactly what the harness consumes. */

// No `description`: it is operator-reference only and renders on no surface (the displayed intro
// is the per-vault config `about`), so the form neither collects nor emits it. The deploy-params
// schema keeps `description?` optional for back-compat with existing files.
export type AddVaultFormState = {
  productId: string
  symbol: string
  name: string
  paymentAssetSymbol: "tUSDC" | "tBTC" | "tXRP" | "tWETH"
  category: VaultCategory
  init: { [K in keyof Required<DeployParamsInit>]: string }
}

export const ADD_VAULT_INITIAL_STATE: AddVaultFormState = {
  productId: "",
  symbol: "",
  name: "",
  paymentAssetSymbol: "tUSDC",
  category: VAULT_CATEGORIES[0],
  init: {
    maxSupplyCapShares: DEPLOY_PARAMS_DEFAULTS.maxSupplyCapShares,
    vaultMintAllowanceShares: DEPLOY_PARAMS_DEFAULTS.vaultMintAllowanceShares,
    maxRedemptionPayment: DEPLOY_PARAMS_DEFAULTS.maxRedemptionPayment,
    feedInitialAnswer: DEPLOY_PARAMS_DEFAULTS.feedInitialAnswer,
    feedHealthyDiffSeconds: String(DEPLOY_PARAMS_DEFAULTS.feedHealthyDiffSeconds),
    feedMaxAnswer: DEPLOY_PARAMS_DEFAULTS.feedMaxAnswer,
    feedMinAnswer: DEPLOY_PARAMS_DEFAULTS.feedMinAnswer,
  },
}

// Pure emitter (exported for tests): form state -> deploy-params file object.
export function buildDeployParams(form: AddVaultFormState): DeployParamsFile {
  return {
    schemaVersion: 1,
    products: [
      {
        productId: form.productId.trim(),
        symbol: form.symbol.trim(),
        name: form.name.trim(),
        paymentAssetSymbol: form.paymentAssetSymbol,
        category: form.category,
        init: {
          maxSupplyCapShares: form.init.maxSupplyCapShares.trim(),
          vaultMintAllowanceShares: form.init.vaultMintAllowanceShares.trim(),
          maxRedemptionPayment: form.init.maxRedemptionPayment.trim(),
          feedInitialAnswer: form.init.feedInitialAnswer.trim(),
          feedHealthyDiffSeconds: Number(form.init.feedHealthyDiffSeconds),
          feedMaxAnswer: form.init.feedMaxAnswer.trim(),
          feedMinAnswer: form.init.feedMinAnswer.trim(),
        },
      },
    ],
  }
}

export function deployParamsCommand(productId: string): string {
  return [
    `# save as packages/contracts/deploy-params/${productId}.json, then from packages/contracts:`,
    `# (commit first, or prepend ALLOW_DIRTY_GIWA_DEPLOY=I_UNDERSTAND_DIRTY_TREE_RISK if the tree is dirty)`,
    `GIWA_EXTRA_PRODUCTS=deploy-params/${productId}.json \\`,
    `CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \\`,
    `npm run deploy:giwa`,
  ].join("\n")
}

const ADD_VAULT_INIT_FIELDS: { key: keyof AddVaultFormState["init"]; label: string }[] = [
  { key: "maxSupplyCapShares", label: "Max supply cap (shares)" },
  { key: "vaultMintAllowanceShares", label: "Vault mint allowance (shares)" },
  { key: "maxRedemptionPayment", label: "Max redemption (payment units)" },
  { key: "feedInitialAnswer", label: "Baseline NAV answer (8 decimals)" },
  { key: "feedHealthyDiffSeconds", label: "Feed staleness window (seconds)" },
  { key: "feedMaxAnswer", label: "Feed max answer" },
  { key: "feedMinAnswer", label: "Feed min answer" },
]

// Exported for the render-harness verification.
export function AddVaultCard({ products }: { products: GiwaCatalogItem[] }) {
  const [form, setForm] = useState<AddVaultFormState>(ADD_VAULT_INITIAL_STATE)
  const [errors, setErrors] = useState<string[]>([])
  const [output, setOutput] = useState<{ json: string; command: string } | null>(null)

  function patch(next: Partial<AddVaultFormState>) {
    setForm((current) => ({ ...current, ...next }))
  }

  function generate() {
    setOutput(null)
    const params = buildDeployParams(form)
    // Reserved ids/symbols come from the live catalog (built-ins + already-registered
    // extras), so a collision is caught here with the same validator the harness runs.
    const result = validateDeployParams(
      params,
      products.map((product) => product.productId),
      products.map((product) => product.symbol),
    )
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors([])
    setOutput({
      json: `${JSON.stringify(params, null, 2)}\n`,
      command: deployParamsCommand(form.productId.trim()),
    })
  }

  function download() {
    if (!output) return
    const blob = new Blob([output.json], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${form.productId.trim()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Add vault (generate deploy plan)</h2>
        <span className="text-[11px] text-[var(--color-arco-muted)]">
          Produces a deploy-params file + command — deployment runs in the gated harness, never in the browser
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[var(--color-arco-muted)]">
          Product ID
          <input value={form.productId} onChange={(event) => patch({ productId: event.target.value })} placeholder="e.g. agold" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-sm" />
          <span className="mt-1 block text-[11px] text-[var(--color-arco-muted)]">
            internal id (lowercase); used in URLs/registry, cannot change after deploy
          </span>
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Symbol
          <input value={form.symbol} onChange={(event) => patch({ symbol: event.target.value })} placeholder="e.g. aGOLD" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Name
          <input value={form.name} onChange={(event) => patch({ name: event.target.value })} placeholder="e.g. Arco GOLD" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm" />
          <span className="mt-1 block text-[11px] text-[var(--color-arco-muted)]">
            on-chain ERC20 token name; the app shows the display name set later in Vault Config
          </span>
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Payment asset (existing test assets)
          <select value={form.paymentAssetSymbol} onChange={(event) => patch({ paymentAssetSymbol: event.target.value as AddVaultFormState["paymentAssetSymbol"] })} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-sm">
            {(["tUSDC", "tBTC", "tXRP", "tWETH"] as const).map((symbol) => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Category (fixed taxonomy)
          <select value={form.category} onChange={(event) => patch({ category: event.target.value as VaultCategory })} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-sm">
            {VAULT_CATEGORIES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="mt-4 text-xs text-[var(--color-arco-muted)]">Init parameters (defaults match the launch vaults; feed decimals are fixed at 8):</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ADD_VAULT_INIT_FIELDS.map(({ key, label }) => (
          <label key={key} className="text-xs text-[var(--color-arco-muted)]">
            {label}
            <input
              value={form.init[key]}
              onChange={(event) => patch({ init: { ...form.init, [key]: event.target.value } })}
              className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-sm"
            />
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={generate} className="inline-flex h-9 items-center rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)]">
          Generate deploy plan
        </button>
      </div>

      {errors.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3 text-xs text-[var(--color-arco-down)]">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <ul className="space-y-0.5">
            {errors.map((error) => (
              <li key={error} className="break-words">{error}</li>
            ))}
          </ul>
        </div>
      )}

      {output && (
        <div className="mt-4 space-y-3">
          <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface-muted)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--color-arco-ink)]">deploy-params/{form.productId.trim()}.json</span>
              <span className="flex gap-2">
                <button type="button" onClick={() => void navigator.clipboard.writeText(output.json)} className="rounded-md border border-[var(--color-arco-border)] px-2.5 py-1 text-xs text-[var(--color-arco-ink)]">
                  Copy JSON
                </button>
                <button type="button" onClick={download} className="rounded-md border border-[var(--color-arco-border)] px-2.5 py-1 text-xs text-[var(--color-arco-ink)]">
                  Download
                </button>
              </span>
            </div>
            <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-4 text-[var(--color-arco-ink)]">{output.json}</pre>
          </div>
          <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface-muted)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--color-arco-ink)]">Operator command (gated: clean tree · tests · CONFIRM broadcast)</span>
              <button type="button" onClick={() => void navigator.clipboard.writeText(output.command)} className="rounded-md border border-[var(--color-arco-border)] px-2.5 py-1 text-xs text-[var(--color-arco-ink)]">
                Copy command
              </button>
            </div>
            <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-4 text-[var(--color-arco-ink)]">{output.command}</pre>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-[var(--color-arco-text-soft)]">
            <li>Run the command above — only the new vault's 12 steps execute; the registry file is updated by the script.</li>
            <li>Paste the 4 deployed addresses into "Register deployed vault" below — the vault registers hidden.</li>
            <li>Verify/post the baseline NAV in the Prices tab.</li>
            <li>Set the display config here and un-hide when ready.</li>
          </ol>
        </div>
      )}
    </Card>
  )
}

/* ── 2c-1: Register deployed vault ──────────────────────────────────────────
   The deploy HARNESS deploys on-chain and writes the registry file (no browser-signed
   deployment, ever). This step brings a harness-deployed product into the served
   registry: the server cross-checks the pasted addresses against the file + the chain,
   then inserts the product row and a hidden VaultConfig. */

const REGISTER_SLOTS = [
  { key: "productToken", label: "Product token address" },
  { key: "depositVault", label: "Deposit vault address" },
  { key: "redemptionVault", label: "Redemption vault address" },
  { key: "priceFeed", label: "Price feed address" },
] as const

// Exported for the render-harness verification.
export function RegisterVaultCard({ operatorToken }: { operatorToken: string }) {
  const queryClient = useQueryClient()
  const [productId, setProductId] = useState("")
  const [addresses, setAddresses] = useState<Record<(typeof REGISTER_SLOTS)[number]["key"], string>>({
    productToken: "",
    depositVault: "",
    redemptionVault: "",
    priceFeed: "",
  })
  const [phase, setPhase] = useState<"idle" | "registering" | "done" | "failed">("idle")
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ symbol: string; unverified: string[]; proxyAdminOwner: string | null } | null>(null)

  const complete = productId.trim() && REGISTER_SLOTS.every(({ key }) => addresses[key].trim())

  async function register() {
    setPhase("registering")
    setError(null)
    setResult(null)
    try {
      const response = await giwaApi.admin.registerProduct(operatorToken, productId.trim(), {
        productToken: addresses.productToken.trim(),
        depositVault: addresses.depositVault.trim(),
        redemptionVault: addresses.redemptionVault.trim(),
        priceFeed: addresses.priceFeed.trim(),
      })
      await queryClient.invalidateQueries({ queryKey: ["giwa", "catalog"] })
      setResult({ symbol: response.symbol, unverified: response.unverified, proxyAdminOwner: response.proxyAdminOwner })
      setPhase("done")
    } catch (err) {
      setPhase("failed")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Register deployed vault</h2>
        <span className="text-[11px] text-[var(--color-arco-muted)]">
          Deploy on-chain with the harness script first — this step only registers the result
        </span>
      </div>
      <p className="mt-2 text-xs text-[var(--color-arco-muted)]">
        The product must already be in the registry file written by the deploy harness (same machine/commit). The
        pasted addresses are cross-checked against the file and validated on-chain; the new vault is registered
        hidden.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[var(--color-arco-muted)]">
          Product ID
          <input
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
            placeholder="e.g. anew"
            className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-sm"
          />
        </label>
        {REGISTER_SLOTS.map(({ key, label }) => (
          <label key={key} className="text-xs text-[var(--color-arco-muted)]">
            {label}
            <input
              value={addresses[key]}
              onChange={(event) => setAddresses((current) => ({ ...current, [key]: event.target.value }))}
              placeholder="0x…"
              className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-xs"
            />
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void register()}
          disabled={phase === "registering" || !complete}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
        >
          {phase === "registering" && <Loader2 className="size-3.5 animate-spin" />}
          Validate & register
        </button>
      </div>

      {phase === "failed" && error && (
        <div className="mt-4 flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3 text-xs text-[var(--color-arco-down)]">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}
      {phase === "done" && result && (
        <div className="mt-4 space-y-3">
          <div className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3 text-xs">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-arco-up)]" />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-[var(--color-arco-ink)]">
                {result.symbol} registered — hidden from the investor list
              </span>
              <span className="text-[var(--color-arco-text-soft)]">
                Add display profile/icon before un-hiding. Post its baseline NAV in the Prices tab.
              </span>
            </div>
          </div>
          {result.unverified.length > 0 && (
            <div className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-arco-border)] p-3 text-xs text-[var(--color-arco-down)]">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">
                  Not verified on-chain (trusted): {result.unverified.join(", ")}
                </span>
                <span className="text-[var(--color-arco-text-soft)]">
                  ProxyAdmin ownership & implementation bytecode MUST be verified before any mainnet use.
                  {result.proxyAdminOwner && (
                    <> ProxyAdmin owner read on-chain: <span className="font-mono">{result.proxyAdminOwner}</span></>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// Exported for the render-harness verification (page renders it per product).
// The single cross-vault ordering authority for the Savings selector. Renders the flat list of ALL
// saving accept-assets (icon + symbol + owning-vault tag) with ▲▼; Save assigns sortOrder = flat
// index via the atomic savings-order route, then refetches the catalog so the per-vault editors and
// the investor selector both reflect the new order. Seeded from `accounts` (kept fresh via the
// keyed remount at the call site).
function SavingsOrderCard({
  accounts,
  products,
  operatorToken,
}: {
  accounts: SavingsAccount[]
  products: GiwaCatalogItem[]
  operatorToken: string
}) {
  const queryClient = useQueryClient()
  const [rows, setRows] = useState(accounts)
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [error, setError] = useState<string | null>(null)

  function move(index: number, dir: -1 | 1) {
    setRows((current) => {
      const target = index + dir
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setPhase("idle")
  }

  function ownerName(vaultId: string) {
    const product = products.find((candidate) => candidate.productId === vaultId)
    return product ? vaultDisplayName(product) : vaultId
  }

  async function save() {
    setPhase("saving")
    setError(null)
    try {
      await giwaApi.admin.saveSavingsOrder(
        operatorToken,
        rows.map((row) => ({ productId: row.vaultId, symbol: row.symbol })),
      )
      // Refetch every catalog variant so the per-vault editors AND the investor Savings selector
      // pick up the new order immediately.
      await queryClient.invalidateQueries({ queryKey: ["giwa", "catalog"] })
      setPhase("saved")
    } catch (err) {
      setPhase("failed")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Savings account order</h2>
      <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">
        The order these accept-assets appear in the Savings selector, across all saving vaults. Reorder, then Save.
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((row, index) => (
          <div
            key={`${row.vaultId}:${row.symbol}`}
            className="flex items-center gap-2 rounded-md border border-[var(--color-arco-border)] p-2"
          >
            <div className="size-6 shrink-0">
              <BrandMark src={row.icon ?? undefined} label={row.symbol} size={24} />
            </div>
            <span className="text-sm font-medium text-[var(--color-arco-ink)]">{row.symbol}</span>
            {row.disabled && (
              <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2 py-0.5 text-[10px] text-[var(--color-arco-muted)]">
                coming soon
              </span>
            )}
            <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
              {ownerName(row.vaultId)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label="Move up"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-arco-border)] text-xs text-[var(--color-arco-ink)] disabled:opacity-40"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === rows.length - 1}
                aria-label="Move down"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-arco-border)] text-xs text-[var(--color-arco-ink)] disabled:opacity-40"
              >
                ↓
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={phase === "saving"}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
        >
          {phase === "saving" && <Loader2 className="size-3.5 animate-spin" />}
          Save order
        </button>
        {phase === "saved" && <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />}
        {phase === "failed" && error && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-arco-down)]">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Card>
  )
}

export function VaultConfigCard({ product, operatorToken }: { product: GiwaCatalogItem; operatorToken: string }) {
  const queryClient = useQueryClient()
  const saved = vaultConfigOf(product)

  // Collapsed by default (accordion). Form state below stays mounted while collapsed, so
  // typed-but-unsaved edits survive toggling.
  const [expanded, setExpanded] = useState(false)
  const [displayName, setDisplayName] = useState(saved.displayName ?? "")
  const [category, setCategory] = useState(saved.category ?? "")
  const [adminDepositAddress, setAdminDepositAddress] = useState(saved.adminDepositAddress ?? "")
  const [cards, setCards] = useState<Record<CardKey, boolean>>({
    cardSnapshot: saved.cardSnapshot,
    cardIndustry: saved.cardIndustry,
    cardExposure: saved.cardExposure,
  })
  const [pinned, setPinned] = useState(saved.pinned)
  const [hidden, setHidden] = useState(saved.hidden)
  // "product" (Products) or "saving" (Savings page only). Toggling to Saving removes the vault
  // from the investor Products list.
  const [kind, setKind] = useState(saved.kind)
  // Display profile (P1): text/number/URL fields; fees are edited as percent, stored bps.
  const [assetManagerName, setAssetManagerName] = useState(saved.assetManagerName ?? "")
  const [issuerName, setIssuerName] = useState(saved.issuerName ?? "")
  const [about, setAbout] = useState(saved.about ?? "")
  const [redemptionDays, setRedemptionDays] = useState(
    saved.redemptionTimelineDays == null ? "" : String(saved.redemptionTimelineDays),
  )
  const [feeInstantMinting, setFeeInstantMinting] = useState(bpsToPercentInput(saved.feeInstantMintingBps))
  const [feeInstantRedemption, setFeeInstantRedemption] = useState(bpsToPercentInput(saved.feeInstantRedemptionBps))
  const [feeManagement, setFeeManagement] = useState(bpsToPercentInput(saved.feeManagementBps))
  const [feePerformance, setFeePerformance] = useState(bpsToPercentInput(saved.feePerformanceBps))
  const [vaultImageUrl, setVaultImageUrl] = useState(saved.vaultImageUrl ?? "")
  const [assetManagerImageUrl, setAssetManagerImageUrl] = useState(saved.assetManagerImageUrl ?? "")
  const [issuerImageUrl, setIssuerImageUrl] = useState(saved.issuerImageUrl ?? "")
  // "More info" docs links: one URL + one show toggle per slot.
  const [docsUrl, setDocsUrl] = useState(saved.docsUrl ?? "")
  const [legalUrl, setLegalUrl] = useState(saved.legalUrl ?? "")
  const [risksUrl, setRisksUrl] = useState(saved.risksUrl ?? "")
  const [docsShown, setDocsShown] = useState(saved.docsShown)
  const [legalShown, setLegalShown] = useState(saved.legalShown)
  const [risksShown, setRisksShown] = useState(saved.risksShown)
  const [aum, setAum] = useState(saved.aum ?? "")
  // Portfolio slice editors (P3), one per view.
  const [portfolioRows, setPortfolioRows] = useState<Record<PortfolioKey, SliceRow[]>>({
    portfolioSnapshot: sliceRowsFrom(saved.portfolioSnapshot),
    portfolioIndustry: sliceRowsFrom(saved.portfolioIndustry),
    portfolioExposure: sliceRowsFrom(saved.portfolioExposure),
  })
  // Accept-asset editor rows (Savings): edited whenever kind==="saving"; a product vault's stored
  // accept-assets stay dormant (save omits the field, so the server never re-validates or clears them).
  const [acceptRows, setAcceptRows] = useState<AcceptRow[]>(acceptRowsFrom(saved.acceptAssets))
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [error, setError] = useState<string | null>(null)

  const enabledCount = Object.values(cards).filter(Boolean).length

  function toggleCard(key: CardKey) {
    setCards((current) => {
      // UI enforcement of the API rule: at least one portfolio card view stays on.
      if (current[key] && Object.values(current).filter(Boolean).length === 1) return current
      return { ...current, [key]: !current[key] }
    })
  }

  function updateSliceRow(key: PortfolioKey, index: number, field: keyof SliceRow, value: string) {
    setPortfolioRows((current) => ({
      ...current,
      [key]: current[key].map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    }))
  }
  function addSliceRow(key: PortfolioKey) {
    setPortfolioRows((current) => ({ ...current, [key]: [...current[key], { label: "", percent: "", valueUsd: "" }] }))
  }
  function removeSliceRow(key: PortfolioKey, index: number) {
    setPortfolioRows((current) => ({ ...current, [key]: current[key].filter((_, i) => i !== index) }))
  }

  function updateAcceptRow<K extends keyof AcceptRow>(index: number, field: K, value: AcceptRow[K]) {
    setAcceptRows((current) => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }
  function addAcceptRow() {
    setAcceptRows((current) => [...current, { symbol: "", icon: "", apy: "", isDummy: false, sortOrder: null }])
  }
  function removeAcceptRow(index: number) {
    setAcceptRows((current) => current.filter((_, i) => i !== index))
  }
  // Cross-vault selector order is owned by the page-level SavingsOrderCard (the single ordering
  // authority) — the per-vault editor no longer reorders (add/remove/edit only).

  async function save() {
    setError(null)
    // Convert the four percent inputs to basis points; abort on an out-of-range entry.
    const feeEntries: [keyof GiwaVaultConfig, string][] = [
      ["feeInstantMintingBps", feeInstantMinting],
      ["feeInstantRedemptionBps", feeInstantRedemption],
      ["feeManagementBps", feeManagement],
      ["feePerformanceBps", feePerformance],
    ]
    const fees: Partial<GiwaVaultConfig> = {}
    for (const [key, input] of feeEntries) {
      const bps = percentInputToBps(input)
      if (bps === "invalid") {
        setPhase("failed")
        setError(`${key} must be a percent between 0 and 100`)
        return
      }
      ;(fees as Record<string, number | null>)[key] = bps
    }
    let redemptionTimelineDays: number | null = null
    if (redemptionDays.trim() !== "") {
      const days = Number(redemptionDays)
      if (!Number.isInteger(days) || days < 0) {
        setPhase("failed")
        setError("Redemption timeline must be a non-negative whole number of days")
        return
      }
      redemptionTimelineDays = days
    }
    // Portfolio slices: build + validate each view (blank set → null); abort on error.
    const portfolio: Partial<GiwaVaultConfig> = {}
    for (const { key, label } of PORTFOLIO_EDITORS) {
      const built = buildSlicesForSave(portfolioRows[key])
      if ("error" in built) {
        setPhase("failed")
        setError(`${label} portfolio: ${built.error}`)
        return
      }
      ;(portfolio as Record<string, GiwaPortfolioSlice[] | null>)[key] = built.value
    }
    // Accept-assets (Savings): only for a saving vault. Build + validate; abort on error. For a
    // product vault leave this undefined so the save OMITS the field — the server then never touches
    // the stored accept-assets (dormant, reversible on a saving→product flip).
    let acceptAssets: GiwaAcceptAsset[] | null | undefined
    if (kind === "saving") {
      const built = buildAcceptAssetsForSave(acceptRows, product.productId)
      if ("error" in built) {
        setPhase("failed")
        setError(`Accept-assets: ${built.error}`)
        return
      }
      acceptAssets = built.value
    }
    setPhase("saving")
    try {
      // `description` is intentionally not sent — it renders on no surface (about does),
      // so its input was removed. Existing rows keep their stored value untouched.
      const patch: Partial<GiwaVaultConfig> = {
        displayName: displayName.trim() || null,
        category: category || null,
        adminDepositAddress: adminDepositAddress.trim() || null,
        ...cards,
        pinned,
        hidden,
        kind,
        assetManagerName: assetManagerName.trim() || null,
        issuerName: issuerName.trim() || null,
        about: about.trim() || null,
        aum: aum.trim() || null,
        redemptionTimelineDays,
        ...fees,
        vaultImageUrl: vaultImageUrl.trim() || null,
        assetManagerImageUrl: assetManagerImageUrl.trim() || null,
        issuerImageUrl: issuerImageUrl.trim() || null,
        docsUrl: docsUrl.trim() || null,
        legalUrl: legalUrl.trim() || null,
        risksUrl: risksUrl.trim() || null,
        docsShown,
        legalShown,
        risksShown,
        ...portfolio,
        // Only present for a saving vault; omitted for a product vault (leaves stored value dormant).
        ...(acceptAssets !== undefined ? { acceptAssets } : {}),
      }
      await giwaApi.admin.saveVaultConfig(operatorToken, product.productId, patch)
      // Prefix-matches every catalog variant (investor, detail, admin) so the public
      // list, product detail and this page all refresh with the new config.
      await queryClient.invalidateQueries({ queryKey: ["giwa", "catalog"] })
      setPhase("saved")
    } catch (err) {
      setPhase("failed")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card>
      {/* Accordion header (default collapsed): compact identity + badges + chevron. */}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">{product.symbol}</h2>
          <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
            {product.paymentAssetSymbol}
          </span>
          {pinned && (
            <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
              Pinned
            </span>
          )}
          {hidden && (
            <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--color-arco-muted)]">
              Hidden
            </span>
          )}
        </div>
        <ChevronDown className={`size-4 shrink-0 text-[var(--color-arco-muted)] transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <PillToggle active={pinned} onToggle={() => setPinned((value) => !value)} label="Pin to top" />
            <PillToggle active={!hidden} onToggle={() => setHidden((value) => !value)} label={hidden ? "Hidden" : "Visible"} />
            <span className="ml-1 text-[11px] text-[var(--color-arco-muted)]">Kind:</span>
            <PillToggle active={kind === "product"} onToggle={() => setKind("product")} label="Product" />
            <PillToggle active={kind === "saving"} onToggle={() => setKind("saving")} label="Saving" />
          </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[var(--color-arco-muted)]">
          Display name (blank = registry name)
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder={product.symbol}
            className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm"
          />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Category (fixed taxonomy)
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-sm"
          >
            <option value="">No override (inherit)</option>
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          AUM (fund AUM, e.g. $50B)
          <input
            value={aum}
            onChange={(event) => setAum(event.target.value)}
            maxLength={24}
            placeholder="blank = —"
            className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm"
          />
        </label>
        <div />
        <label className="text-xs text-[var(--color-arco-muted)] sm:col-span-2">
          Admin deposit address (withdraw destination default)
          <input
            value={adminDepositAddress}
            onChange={(event) => setAdminDepositAddress(event.target.value)}
            placeholder="0x… (blank = connected operator wallet)"
            className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-xs"
          />
        </label>
      </div>

      {/* Display profile (P1): overrides the product detail page; blank = legacy fallback. */}
      <p className="mt-5 text-xs font-semibold text-[var(--color-arco-ink)]">Display profile</p>
      <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">
        Blank fields fall back to the legacy content. Instant liquidity is always live from the redemption vault
        (not editable). Portfolio data + image uploads arrive in later phases.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[var(--color-arco-muted)]">
          Asset manager name
          <input value={assetManagerName} onChange={(event) => setAssetManagerName(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Issuer name
          <input value={issuerName} onChange={(event) => setIssuerName(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)] sm:col-span-2">
          About (one paragraph per blank line)
          <textarea value={about} onChange={(event) => setAbout(event.target.value)} rows={4} placeholder="Vault description shown on the product page" className="mt-1 w-full rounded-md border border-[var(--color-arco-border)] px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Redemption timeline (days)
          <input value={redemptionDays} onChange={(event) => setRedemptionDays(event.target.value)} inputMode="numeric" placeholder="e.g. 3" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 tabular-nums text-sm" />
        </label>
        <div />
        <label className="text-xs text-[var(--color-arco-muted)]">
          Instant minting fee (%)
          <input value={feeInstantMinting} onChange={(event) => setFeeInstantMinting(event.target.value)} inputMode="decimal" placeholder="0" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 tabular-nums text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Instant redemption fee (%)
          <input value={feeInstantRedemption} onChange={(event) => setFeeInstantRedemption(event.target.value)} inputMode="decimal" placeholder="0.5" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 tabular-nums text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Management fee (%)
          <input value={feeManagement} onChange={(event) => setFeeManagement(event.target.value)} inputMode="decimal" placeholder="1.25" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 tabular-nums text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Performance fee (%)
          <input value={feePerformance} onChange={(event) => setFeePerformance(event.target.value)} inputMode="decimal" placeholder="0" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 tabular-nums text-sm" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)] sm:col-span-2">
          Vault image URL
          <input value={vaultImageUrl} onChange={(event) => setVaultImageUrl(event.target.value)} placeholder="https://… or /logos/…" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-xs" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Asset manager image URL
          <input value={assetManagerImageUrl} onChange={(event) => setAssetManagerImageUrl(event.target.value)} placeholder="https://… or /logos/…" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-xs" />
        </label>
        <label className="text-xs text-[var(--color-arco-muted)]">
          Issuer image URL
          <input value={issuerImageUrl} onChange={(event) => setIssuerImageUrl(event.target.value)} placeholder="https://… or /logos/…" className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-xs" />
        </label>
      </div>

      {/* More info: read-only Smart Contracts (derived from the deploy) + editable docs links. */}
      <p className="mt-5 text-xs font-semibold text-[var(--color-arco-ink)]">More info</p>
      <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">
        Smart contracts are read-only — derived from the deploy, not stored. A docs link shows on the product page
        only when it is toggled Shown and has a URL.
      </p>

      <div className="mt-3 rounded-md border border-[var(--color-arco-border)] p-3">
        <p className="text-[11px] font-medium text-[var(--color-arco-text-soft)]">Smart Contracts (GIWA explorer)</p>
        <div className="mt-2 space-y-1.5">
          {[
            { label: "Product token", address: product.productTokenAddress },
            { label: "Deposit vault", address: product.depositVaultAddress },
            { label: "Redemption vault", address: product.redemptionVaultAddress },
            { label: "Price feed", address: product.priceFeedAddress },
          ].map(({ label, address }) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-xs text-[var(--color-arco-text-soft)]">{label}</span>
              {address ? (
                <a
                  href={explorerAddress(address)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-[var(--color-arco-ink)] underline"
                >
                  {shortAddr(address)}
                </a>
              ) : (
                <span className="font-mono text-xs text-[var(--color-arco-muted)]">—</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 grid gap-3">
        {(
          [
            { label: "Documentation", url: docsUrl, setUrl: setDocsUrl, shown: docsShown, setShown: setDocsShown },
            { label: "Legal Terms", url: legalUrl, setUrl: setLegalUrl, shown: legalShown, setShown: setLegalShown },
            { label: "Risks", url: risksUrl, setUrl: setRisksUrl, shown: risksShown, setShown: setRisksShown },
          ] as const
        ).map((row) => (
          <div key={row.label} className="flex items-end gap-2">
            <label className="flex-1 text-xs text-[var(--color-arco-muted)]">
              {row.label} URL
              <input
                value={row.url}
                onChange={(event) => row.setUrl(event.target.value)}
                placeholder="https://… or /path"
                className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 font-mono text-xs"
              />
            </label>
            <PillToggle active={row.shown} onToggle={() => row.setShown((value) => !value)} label={row.shown ? "Shown" : "Hidden"} />
          </div>
        ))}
      </div>

      {/* Portfolio breakdowns (P3): repeatable slices per view; blank set clears the override. */}
      <p className="mt-5 text-xs font-semibold text-[var(--color-arco-ink)]">Portfolio breakdowns</p>
      <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">
        Snapshot &amp; Industry render as pies; Exposure as a stacked bar. Percents must sum to ~100%. Leave a
        view empty to fall back (Industry/Exposure → sample data; Snapshot → an empty state).
      </p>
      {PORTFOLIO_EDITORS.map(({ key, label }) => {
        const rows = portfolioRows[key]
        const { sum, hasInvalid } = sliceRowsSummary(rows)
        const sumOk = !hasInvalid && Math.abs(sum - 100) <= 0.5
        return (
          <div key={key} className="mt-3 rounded-md border border-[var(--color-arco-border)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--color-arco-ink)]">{label}</span>
              {rows.length > 0 && (
                <span className={`text-[11px] ${sumOk ? "text-[var(--color-arco-up)]" : "text-[var(--color-arco-down)]"}`}>
                  Sum: {sum.toFixed(2)}%{" "}
                  {hasInvalid ? "(fix blank/invalid rows)" : sumOk ? "✓" : "(must be ~100%)"}
                </span>
              )}
            </div>
            {rows.length === 0 ? (
              <p className="mt-2 text-[11px] text-[var(--color-arco-muted)]">No slices — falls back.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {rows.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      value={row.label}
                      onChange={(event) => updateSliceRow(key, index, "label", event.target.value)}
                      placeholder="Label"
                      className="h-9 min-w-[160px] flex-1 rounded-md border border-[var(--color-arco-border)] px-2 text-sm"
                    />
                    <input
                      value={row.percent}
                      onChange={(event) => updateSliceRow(key, index, "percent", event.target.value)}
                      placeholder="%"
                      inputMode="decimal"
                      className="h-9 w-20 rounded-md border border-[var(--color-arco-border)] px-2 tabular-nums text-sm"
                    />
                    <input
                      value={row.valueUsd}
                      onChange={(event) => updateSliceRow(key, index, "valueUsd", event.target.value)}
                      placeholder="USD (optional)"
                      inputMode="decimal"
                      className="h-9 w-32 rounded-md border border-[var(--color-arco-border)] px-2 tabular-nums text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => removeSliceRow(key, index)}
                      className="inline-flex h-9 items-center rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs text-[var(--color-arco-ink)]"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => addSliceRow(key)}
              className="mt-2 inline-flex h-8 items-center rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs font-medium text-[var(--color-arco-ink)]"
            >
              + Add slice
            </button>
          </div>
        )
      })}

      {/* Accept-assets (Savings): the ordered selector list for a saving vault. A "Live" asset maps
          to this vault (its APY is read live on the Savings page); a "Coming soon" asset is display-
          only (its APY here is the shown rate, no vault map). Only shown for kind="saving". */}
      {kind === "saving" && (
        <div className="mt-5">
          <p className="text-xs font-semibold text-[var(--color-arco-ink)]">Savings accept-assets</p>
          <p className="mt-0.5 text-[11px] text-[var(--color-arco-muted)]">
            Shown on the Savings page in this order. A “Live” asset maps to this vault (APY read live);
            mark an asset “Coming soon” to show it disabled — set its APY here (no vault map).
          </p>
          <div className="mt-3 rounded-md border border-[var(--color-arco-border)] p-3">
            {acceptRows.length === 0 ? (
              <p className="text-[11px] text-[var(--color-arco-muted)]">No accept-assets yet.</p>
            ) : (
              <div className="space-y-2">
                {acceptRows.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      value={row.symbol}
                      onChange={(event) => updateAcceptRow(index, "symbol", event.target.value)}
                      placeholder="Symbol (e.g. USDC)"
                      className="h-9 w-36 rounded-md border border-[var(--color-arco-border)] px-2 text-sm"
                    />
                    <input
                      value={row.icon}
                      onChange={(event) => updateAcceptRow(index, "icon", event.target.value)}
                      placeholder="Icon URL or /path (optional)"
                      className="h-9 min-w-[180px] flex-1 rounded-md border border-[var(--color-arco-border)] px-2 text-sm"
                    />
                    {row.isDummy && (
                      <input
                        value={row.apy}
                        onChange={(event) => updateAcceptRow(index, "apy", event.target.value)}
                        placeholder="APY %"
                        inputMode="decimal"
                        className="h-9 w-20 rounded-md border border-[var(--color-arco-border)] px-2 tabular-nums text-sm"
                      />
                    )}
                    <PillToggle
                      active={row.isDummy}
                      onToggle={() => updateAcceptRow(index, "isDummy", !row.isDummy)}
                      label={row.isDummy ? "Coming soon" : "Live"}
                    />
                    <button
                      type="button"
                      onClick={() => removeAcceptRow(index)}
                      className="inline-flex h-9 items-center rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs text-[var(--color-arco-ink)]"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addAcceptRow}
              className="mt-2 inline-flex h-8 items-center rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs font-medium text-[var(--color-arco-ink)]"
            >
              + Add accept-asset
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--color-arco-muted)]">Portfolio card views (at least one on):</span>
        {CARD_TOGGLES.map(({ key, label }) => (
          <PillToggle
            key={key}
            active={cards[key]}
            onToggle={() => toggleCard(key)}
            label={label}
            disabled={cards[key] && enabledCount === 1}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={phase === "saving"}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
        >
          {phase === "saving" && <Loader2 className="size-3.5 animate-spin" />}
          Save
        </button>
        {phase === "saved" && <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />}
        {phase === "failed" && error && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-arco-down)]">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
        </div>
      )}
    </Card>
  )
}

function PillToggle({
  active,
  onToggle,
  label,
  disabled,
}: {
  active: boolean
  onToggle: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      disabled={disabled}
      className={`rounded-[var(--radius-pill)] px-3 py-1.5 text-xs transition-colors disabled:opacity-60 ${
        active
          ? "bg-[var(--color-arco-ink)] font-medium text-[var(--color-arco-on-dark)]"
          : "bg-[var(--color-arco-chip)] text-[var(--color-arco-text-soft)]"
      }`}
    >
      {label}
    </button>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      {children}
    </div>
  )
}
