import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react"
import { giwaApi } from "./api"
import type { AdminAuth } from "./api"
import { livePauseStateOf } from "./catalog"
import { afterConfirmedReceipt, sendPreparedTransaction } from "./contracts"
import { ActivityPanel } from "./components"
import { AdminWriteGroup, useGiwaAdmin } from "./admin-context"
import { useOnchainRole } from "./admin-roles"
import { VaultOperationsPanel } from "./VaultAdmin"
import type { GiwaCatalogItem, GiwaPauseState, HexAddress, UiPhase, UnsignedAdminTransaction } from "./types"
import { explorerTx } from "./wallet"

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

export default function GiwaAdminOperationsPage() {
  const { auth, wallet } = useGiwaAdmin()
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog", "admin"], queryFn: giwaApi.catalog })
  const registryQuery = useQuery({ queryKey: ["giwa", "registry"], queryFn: giwaApi.registry })
  const readinessQuery = useQuery({
    queryKey: ["giwa", "ready"],
    queryFn: async () => {
      const response = await fetch(`${viteEnv.VITE_ARCO_API_BASE || "http://localhost:8080"}/ready`)
      return response.json()
    },
    retry: 0,
  })
  const redemptionsQuery = useQuery({
    queryKey: ["giwa", "admin-redemptions", wallet.address],
    queryFn: () => giwaApi.redemptions(wallet.address!),
    enabled: Boolean(wallet.address),
  })
  const activityQuery = useQuery({
    queryKey: ["giwa", "admin-activity", wallet.address],
    queryFn: () => giwaApi.activity(wallet.address!),
    enabled: Boolean(wallet.address),
  })

  const [selectedId, setSelectedId] = useState("acapix")
  const [targetWallet, setTargetWallet] = useState("")
  const [requestId, setRequestId] = useState("1")
  const [vaultTarget, setVaultTarget] = useState<"depositVault" | "redemptionVault" | "allVaults">("allVaults")
  const [prepared, setPrepared] = useState<UnsignedAdminTransaction[]>([])
  const [txHashes, setTxHashes] = useState<string[]>([])
  const [adminPhase, setAdminPhase] = useState<UiPhase>("ready")
  const [error, setError] = useState<string | null>(null)

  const products = catalogQuery.data ?? []
  const selected = products.find((product) => product.productId === selectedId) ?? products[0]
  const indexerLag = readinessQuery.data?.checks?.indexer?.detail?.lagBlocks

  const currentState = useMemo(
    () => [
      ["Registry", registryQuery.data?.activationFlags?.deployed ? "deployed" : "dry-run"],
      ["Indexer lag", typeof indexerLag === "number" ? `${indexerLag} blocks` : "unknown"],
      ["Pause state", "read-only after deployment"],
      ["Greenlist state", "prepared by unsigned tx"],
      ["Liquidity", "provided to redemption vault"],
    ],
    [indexerLag, registryQuery.data?.activationFlags?.deployed],
  )

  async function refreshSharedReads() {
    await Promise.all([
      redemptionsQuery.refetch(),
      activityQuery.refetch(),
      readinessQuery.refetch(),
      registryQuery.refetch(),
      catalogQuery.refetch(),
    ])
  }

  async function requestUnsigned(kind: "greenlist" | "pause" | "unpause" | "fulfill") {
    setError(null)
    setTxHashes([])
    setAdminPhase("ready")
    try {
      if (!auth.ready) throw new Error("Operator token must be entered at runtime")
      if (!selected) throw new Error("Select a product")
      const result =
        kind === "greenlist"
          ? await giwaApi.admin.greenlist(auth, targetWallet)
          : kind === "pause"
            ? await giwaApi.admin.pause(auth, selected.productId, vaultTarget)
            : kind === "unpause"
              ? await giwaApi.admin.unpause(auth, selected.productId, vaultTarget)
              : { transactions: [await giwaApi.admin.fulfill(auth, selected.productId, requestId).then((r) => r.transaction)] }
      setPrepared(result.transactions)
    } catch (err) {
      setPrepared([])
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function signPrepared() {
    setError(null)
    setTxHashes([])
    try {
      if (!wallet.address) throw new Error("Connect the Tier 2 operator wallet first")
      const hashes: HexAddress[] = []
      setAdminPhase("submitting")
      for (const tx of prepared) {
        const hash = await sendPreparedTransaction(wallet.address, tx)
        hashes.push(hash)
        setTxHashes([...hashes])
      }
      setAdminPhase("confirming")
      for (const hash of hashes) {
        await afterConfirmedReceipt(hash, async () => undefined)
      }
      await refreshSharedReads()
      setAdminPhase("success")
    } catch (err) {
      setAdminPhase("failed")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="w-full space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--color-arco-muted)]">Admin · Vault Operations</p>
          <h1 className="mt-1 text-3xl font-semibold text-[var(--color-arco-ink)]">Vault operations</h1>
        </div>
        <span className="rounded-full bg-[var(--color-arco-chip)] px-3 py-1 text-xs text-[var(--color-arco-text-soft)]">
          No server signing · no Tier 1 actions
        </span>
      </section>

      <section className="grid gap-3 md:grid-cols-5">
        {currentState.map(([label, value]) => (
          <div key={label} className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
            <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
            <p className="mt-1 text-sm font-semibold text-[var(--color-arco-ink)]">{value}</p>
          </div>
        ))}
      </section>

      <VaultOperationsPanel />

      <AdminWriteGroup>
        <VaultPauseSection products={products} auth={auth} walletAddress={wallet.address} />
      </AdminWriteGroup>

      <section className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
          <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Tier 2 transaction console</h2>
          <p className="mt-1 text-xs text-[var(--color-arco-muted)]">Prepare unsigned transactions</p>
          <AdminWriteGroup>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-[var(--color-arco-muted)]">
              Product
              <select value={selected?.productId ?? selectedId} onChange={(event) => setSelectedId(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-sm">
                {products.map((product) => (
                  <option key={product.productId} value={product.productId}>
                    {product.symbol}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--color-arco-muted)]">
              Pause target
              <select value={vaultTarget} onChange={(event) => setVaultTarget(event.target.value as typeof vaultTarget)} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-sm">
                <option value="allVaults">Both vaults</option>
                <option value="depositVault">Deposit vault</option>
                <option value="redemptionVault">Redemption vault</option>
              </select>
            </label>
            <label className="text-xs text-[var(--color-arco-muted)]">
              Wallet to greenlist
              <input value={targetWallet} onChange={(event) => setTargetWallet(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm" />
            </label>
            <label className="text-xs text-[var(--color-arco-muted)]">
              Fulfill request ID (selected product)
              <input value={requestId} onChange={(event) => setRequestId(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-[var(--color-arco-border)] px-3 text-sm" />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <ActionButton onClick={() => void requestUnsigned("greenlist")}>Greenlist</ActionButton>
            <ActionButton onClick={() => void requestUnsigned("pause")}>Pause</ActionButton>
            <ActionButton onClick={() => void requestUnsigned("unpause")}>Unpause</ActionButton>
            <ActionButton onClick={() => void requestUnsigned("fulfill")}>Fulfill</ActionButton>
          </div>
          </AdminWriteGroup>
          <p className="mt-3 text-xs text-[var(--color-arco-muted)]">
            Price and staleness updates use the Prices section. Redemption-vault funding uses the vault cards above.
          </p>
          {error && (
            <div className="mt-4 rounded-md border border-[var(--color-arco-border)] p-3 text-sm text-[var(--color-arco-down)]">
              <AlertCircle className="mr-2 inline size-4" />
              {error}
            </div>
          )}
        </div>

        <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
          <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Unsigned txs</h2>
          <div className="mt-3 space-y-2">
            {prepared.length ? (
              prepared.map((tx, index) => (
                <div key={`${tx.to}-${index}`} className="rounded-md bg-[var(--color-arco-surface-muted)] p-3 text-xs">
                  <p className="font-semibold text-[var(--color-arco-ink)]">{tx.description}</p>
                  <p className="mt-1 break-all font-mono text-[var(--color-arco-muted)]">to {tx.to}</p>
                  <p className="mt-1">Simulation: {tx.simulation?.status ?? "not-run"}</p>
                </div>
              ))
            ) : (
              <p className="text-sm text-[var(--color-arco-muted)]">No transaction prepared.</p>
            )}
          </div>
          <button
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[var(--color-arco-ink)] px-3 py-2 text-sm text-[var(--color-arco-on-dark)] disabled:opacity-50"
            disabled={!prepared.length || !wallet.address}
            onClick={() => void signPrepared()}
          >
            <Send className="size-4" />
            Sign with connected wallet
          </button>
          {adminPhase !== "ready" && (
            <div className="mt-3 flex items-center gap-2 rounded-md bg-[var(--color-arco-surface-muted)] p-3 text-sm">
              {adminPhase === "failed" ? (
                <AlertCircle className="size-4 text-[var(--color-arco-down)]" />
              ) : adminPhase === "success" ? (
                <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />
              ) : (
                <Loader2 className="size-4" />
              )}
              <span className="font-semibold capitalize">{adminPhase.replace(/-/g, " ")}</span>
            </div>
          )}
          <div className="mt-3 space-y-1">
            {txHashes.map((hash) => (
              <a key={hash} href={explorerTx(hash)} target="_blank" rel="noreferrer" className="block font-mono text-xs text-[var(--color-arco-ink)]">
                {hash.slice(0, 12)}...
              </a>
            ))}
          </div>
        </div>
      </section>

      <ActivityPanel activity={activityQuery.data ?? []} redemptions={redemptionsQuery.data ?? []} products={products} />
    </div>
  )
}

/* ── Vault partial-pause (§3d): per-vault Pause Deposits / Pause Withdrawals ───── */

type PauseKind = "deposit" | "withdraw"
type PauseActionPhase = "idle" | "preparing" | "signing" | "confirming" | "done" | "failed"

// Exported for the render-harness verification.
export function VaultPauseSection({
  products,
  auth,
  walletAddress,
}: {
  products: GiwaCatalogItem[]
  auth: AdminAuth
  walletAddress: HexAddress | null
}) {
  const queryClient = useQueryClient()
  const [armed, setArmed] = useState<string | null>(null)
  const [phases, setPhases] = useState<Record<string, PauseActionPhase>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Live, uncached on-chain read. The catalog pauseState is cached ~30s server-side, too stale
  // to drive a pause/unpause decision; it remains the fallback while this loads or fails.
  const liveQuery = useQuery({
    queryKey: ["giwa", "admin", "pause-state"],
    queryFn: () => giwaApi.admin.pauseState(auth),
    enabled: auth.ready,
    refetchInterval: 30_000,
    retry: 0,
  })
  const live = liveQuery.data?.pauseState ?? null

  // mode "fn": pauseFn/unpauseFn on the kind's entry paths. mode "vault": whole-contract
  // unpause() of the kind's vault (the only way to lift a whole-vault pause).
  async function run(product: GiwaCatalogItem, kind: PauseKind, paused: boolean, mode: "fn" | "vault" = "fn") {
    const key = `${product.productId}:${kind}`
    setArmed(null)
    setErrors((current) => ({ ...current, [key]: "" }))
    try {
      if (!auth.ready) throw new Error("Operator token must be entered at runtime")
      if (!walletAddress) throw new Error("Connect the PAUSER operator wallet first")
      setPhases((current) => ({ ...current, [key]: "preparing" }))
      const { transactions } =
        mode === "vault"
          ? await giwaApi.admin.unpause(auth, product.productId, kind === "deposit" ? "depositVault" : "redemptionVault")
          : await giwaApi.admin.functionPause(auth, product.productId, kind, paused)
      for (const transaction of transactions) {
        setPhases((current) => ({ ...current, [key]: "signing" }))
        const hash = await sendPreparedTransaction(walletAddress, transaction)
        setPhases((current) => ({ ...current, [key]: "confirming" }))
        await afterConfirmedReceipt(hash, async () => undefined)
      }
      // Re-read live state — a half-completed sequence (2nd tx rejected) surfaces as
      // "Partially paused — retry" on the row, and the retry signs only the missing selector.
      await Promise.all([
        liveQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["giwa", "catalog"] }),
      ])
      setPhases((current) => ({ ...current, [key]: "done" }))
    } catch (error) {
      setPhases((current) => ({ ...current, [key]: "failed" }))
      setErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }))
    }
  }

  return (
    <section className="w-full rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Vault pause</h2>
        <span className="text-[11px] text-[var(--color-arco-muted)]">
          {live ? "Live on-chain read" : "Catalog snapshot (may lag ~30s)"} · pausing one side signs one wallet transaction per entry path
        </span>
      </div>
      {products.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-arco-muted)]">No products in the catalog yet.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="text-[var(--color-arco-muted)]">
                <th className="py-1.5 pr-3 font-normal">Product</th>
                <th className="py-1.5 pr-3 font-normal">Deposits</th>
                <th className="py-1.5 font-normal">Withdrawals</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.productId} className="border-t border-[var(--color-arco-border)]">
                  <td className="py-2 pr-3">
                    <span className="font-semibold text-[var(--color-arco-ink)]">{product.symbol}</span>
                    <span className="ml-2 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
                      {product.paymentAssetSymbol}
                    </span>
                  </td>
                  {(["deposit", "withdraw"] as const).map((kind) => (
                    <PauseKindCell
                      key={kind}
                      product={product}
                      state={livePauseStateOf(product, live)}
                      kind={kind}
                      walletAddress={walletAddress}
                      phase={phases[`${product.productId}:${kind}`] ?? "idle"}
                      error={errors[`${product.productId}:${kind}`] ?? ""}
                      armed={armed === `${product.productId}:${kind}`}
                      onArm={() => setArmed(`${product.productId}:${kind}`)}
                      onRun={(paused) => void run(product, kind, paused)}
                      onUnpauseVault={() => void run(product, kind, false, "vault")}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PauseKindCell({
  product,
  state,
  kind,
  walletAddress,
  phase,
  error,
  armed,
  onArm,
  onRun,
  onUnpauseVault,
}: {
  product: GiwaCatalogItem
  state: GiwaPauseState
  kind: PauseKind
  walletAddress: HexAddress | null
  phase: PauseActionPhase
  error: string
  armed: boolean
  onArm: () => void
  onRun: (paused: boolean) => void
  onUnpauseVault: () => void
}) {
  const paused = kind === "deposit" ? state.depositPaused : state.withdrawPaused
  const partial = kind === "deposit" ? state.depositPartial : state.withdrawPartial
  // Whole-contract pause: blocks every function of the vault and unpauseFn cannot lift it.
  const vaultPaused = kind === "deposit" ? state.depositVaultPaused : state.withdrawVaultPaused
  const vaultLabel = kind === "deposit" ? "deposit vault" : "redemption vault"
  const label = kind === "deposit" ? "deposits" : "withdrawals"
  const busy = phase === "preparing" || phase === "signing" || phase === "confirming"
  // The vault checks PAUSER_ROLE on the signing wallet; say so before a signature is requested.
  const role = useOnchainRole(
    kind === "deposit" ? product.depositVaultAddress : product.redemptionVaultAddress,
    "PAUSER_ROLE",
    kind === "deposit" ? "deposit vault" : "redemption vault",
    walletAddress,
  )
  const blocked = busy || role.status === "missing"

  return (
    <td className="py-2 pr-3">
      <div className="flex flex-wrap items-center gap-2">
        {vaultPaused ? (
          <span
            title={`pause() is set on the ${vaultLabel}: every function is blocked, not only ${label}`}
            className="rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--color-arco-down)]"
          >
            Vault paused
          </span>
        ) : partial ? (
          <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--color-arco-down)]">
            Partially paused — retry
          </span>
        ) : (
          <span
            className={`rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2.5 py-1 text-xs font-medium ${
              paused ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up)]"
            }`}
          >
            {paused ? "Paused" : "Active"}
          </span>
        )}
        {vaultPaused ? (
          <button
            type="button"
            disabled={blocked}
            onClick={onUnpauseVault}
            title={`unpause() on the ${vaultLabel} — re-enables every function; entry-path pauses stay as they are`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs font-medium text-[var(--color-arco-ink)] disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? phaseLabel(phase) : "Unpause vault"}
          </button>
        ) : paused && !partial ? (
          <button
            type="button"
            disabled={blocked}
            onClick={() => onRun(false)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs font-medium text-[var(--color-arco-ink)] disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? phaseLabel(phase) : `Unpause ${label}`}
          </button>
        ) : armed ? (
          <button
            type="button"
            disabled={blocked}
            onClick={() => onRun(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-2.5 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? phaseLabel(phase) : "Confirm pause"}
          </button>
        ) : (
          <button
            type="button"
            disabled={blocked}
            onClick={onArm}
            title="Signs two wallet transactions (one per entry path)"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-arco-border)] px-2.5 text-xs font-medium text-[var(--color-arco-ink)] disabled:opacity-50"
          >
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy ? phaseLabel(phase) : partial ? `Retry pause ${label}` : `Pause ${label}`}
          </button>
        )}
        {phase === "done" && <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />}
      </div>
      {phase === "failed" && error && (
        <p className="mt-1 max-w-[260px] break-words text-[10px] text-[var(--color-arco-down)]">{error}</p>
      )}
      {role.status === "missing" && (
        <p className="mt-1 max-w-[260px] break-words text-[10px] text-[var(--color-arco-down)]">{role.message}</p>
      )}
    </td>
  )
}

function phaseLabel(phase: PauseActionPhase) {
  return phase === "preparing" ? "Preparing" : phase === "signing" ? "Signing" : "Confirming"
}

function ActionButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" className="rounded-md border border-[var(--color-arco-border)] px-3 py-2 text-sm hover:bg-[var(--color-arco-surface-muted)]" onClick={onClick}>
      {children}
    </button>
  )
}
