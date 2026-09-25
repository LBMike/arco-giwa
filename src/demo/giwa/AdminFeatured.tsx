import { useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react"
import { giwaApi, hasDeploymentAddresses } from "./api"
import type { AdminAuth } from "./api"
import { vaultConfigOf, vaultDisplayName, vaultImageFor } from "./catalog"
import { GiwaBrandMark } from "./components"
import { AdminWriteGroup, useGiwaAdmin } from "./admin-context"
import type { GiwaCatalogItem, GiwaFeaturedCard } from "./types"

// Products-page hero carousel manager. A small ordered collection (max 3) of DEPLOYED,
// listed (non-hidden) vaults to feature. Identity (name + logo) is resolved config-first
// from the vault (vaultDisplayName / vaultImageFor) — never re-entered; only the card
// intro (`about`, ≤140), show/hide state and order are edited here. A new card starts hidden.
const FEATURED_MAX = 3
const ABOUT_MAX = 140

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default function GiwaAdminFeaturedPage() {
  const { auth } = useGiwaAdmin()
  // The catalog carries every vault (incl. hidden) so a featured card's identity still
  // resolves in this list even if its vault was later hidden from the investor products list.
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog", "admin"], queryFn: giwaApi.catalog })
  const featuredQuery = useQuery({
    queryKey: ["giwa", "featured", "admin"],
    queryFn: () => giwaApi.admin.featured(auth),
    enabled: auth.ready,
  })
  const products = catalogQuery.data ?? []
  const cards = featuredQuery.data ?? []
  const productById = new Map(products.map((product) => [product.productId, product]))

  return (
    <div className="w-full space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--color-arco-muted)]">Admin · Featured cards</p>
          <h1 className="mt-1 text-3xl font-semibold text-[var(--color-arco-ink)]">Featured cards</h1>
        </div>
        <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-3 py-1 text-sm tabular-nums text-[var(--color-arco-text-soft)]">
          {cards.length}/{FEATURED_MAX}
        </span>
      </section>

      {!auth.ready ? (
        <Card>
          <p className="text-sm text-[var(--color-arco-muted)]">Enter the operator token above to manage featured cards.</p>
        </Card>
      ) : (
        <>
          <AdminWriteGroup>
            <AddFeaturedCard products={products} cards={cards} auth={auth} />
          </AdminWriteGroup>

          {featuredQuery.isLoading ? (
            <Card>
              <p className="text-sm text-[var(--color-arco-muted)]">
                <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
                Loading featured cards…
              </p>
            </Card>
          ) : featuredQuery.isError ? (
            <Card>
              <p className="text-sm text-[var(--color-arco-down)]">Could not load featured cards: {errorText(featuredQuery.error)}</p>
            </Card>
          ) : cards.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--color-arco-muted)]">
                No featured cards yet. Add up to {FEATURED_MAX} deployed vaults above — each starts hidden until you register it.
              </p>
            </Card>
          ) : (
            cards.map((card, index) => (
              <AdminWriteGroup key={card.id}>
                <FeaturedCardRow
                  card={card}
                  product={productById.get(card.productId)}
                  auth={auth}
                  neighborAbove={cards[index - 1]}
                  neighborBelow={cards[index + 1]}
                />
              </AdminWriteGroup>
            ))
          )}
        </>
      )}
    </div>
  )
}

// Add-card control: the picker offers DEPLOYED, listed (non-hidden) vaults not already
// featured; the whole control is disabled at the max-3 cap. New cards are created hidden.
function AddFeaturedCard({
  products,
  cards,
  auth,
}: {
  products: GiwaCatalogItem[]
  cards: GiwaFeaturedCard[]
  auth: AdminAuth
}) {
  const queryClient = useQueryClient()
  const featuredIds = new Set(cards.map((card) => card.productId))
  const options = products.filter(
    (product) => hasDeploymentAddresses(product) && !vaultConfigOf(product).hidden && !featuredIds.has(product.productId),
  )
  const [productId, setProductId] = useState("")
  const [phase, setPhase] = useState<"idle" | "saving" | "failed">("idle")
  const [error, setError] = useState<string | null>(null)
  const atMax = cards.length >= FEATURED_MAX

  async function add() {
    if (!productId) return
    setError(null)
    setPhase("saving")
    try {
      await giwaApi.admin.addFeatured(auth, { productId, shown: false })
      await queryClient.invalidateQueries({ queryKey: ["giwa", "featured"] })
      setProductId("")
      setPhase("idle")
    } catch (err) {
      setPhase("failed")
      setError(errorText(err))
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Add a featured card</h2>
        <span className="text-[11px] text-[var(--color-arco-muted)]">Deployed, listed vaults only · a new card starts hidden</span>
      </div>

      {atMax ? (
        <p className="mt-3 text-xs text-[var(--color-arco-muted)]">
          Maximum of {FEATURED_MAX} featured cards reached — remove one to add another.
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-xs text-[var(--color-arco-muted)]">
              Vault
              <select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                disabled={options.length === 0}
                className="mt-1 h-10 min-w-[260px] rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 text-sm disabled:opacity-50"
              >
                <option value="">Select a deployed vault…</option>
                {options.map((product) => (
                  <option key={product.productId} value={product.productId}>
                    {vaultDisplayName(product)} · {product.symbol}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void add()}
              disabled={!productId || phase === "saving"}
              className="inline-flex h-10 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
            >
              {phase === "saving" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add card
            </button>
          </div>
          {options.length === 0 && (
            <p className="mt-2 text-[11px] text-[var(--color-arco-muted)]">
              No eligible vaults — every deployed, listed vault is already featured.
            </p>
          )}
        </>
      )}

      {phase === "failed" && error && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--color-arco-down)]">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </Card>
  )
}

// One featured card: config-first read-only identity + editable intro (≤140, live counter) +
// Register/Hide/Remove + ▲/▼ reorder. A vault that was de-registered still renders (by id) so
// its stale card can be hidden or removed.
function FeaturedCardRow({
  card,
  product,
  auth,
  neighborAbove,
  neighborBelow,
}: {
  card: GiwaFeaturedCard
  product: GiwaCatalogItem | undefined
  auth: AdminAuth
  neighborAbove?: GiwaFeaturedCard
  neighborBelow?: GiwaFeaturedCard
}) {
  const queryClient = useQueryClient()
  const [about, setAbout] = useState(card.about ?? "")
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  const [error, setError] = useState<string | null>(null)

  const name = product ? vaultDisplayName(product) : card.productId
  const logo = product ? vaultImageFor(product) : undefined
  const overLimit = about.length > ABOUT_MAX

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setPhase("saving")
    try {
      await action()
      await queryClient.invalidateQueries({ queryKey: ["giwa", "featured"] })
      setPhase("saved")
    } catch (err) {
      setPhase("failed")
      setError(errorText(err))
    }
  }

  // Reorder by swapping the two adjacent cards' `position` values (positions stay a
  // permutation of 0…n-1). Two PUTs, then one invalidation.
  async function swapWith(neighbor: GiwaFeaturedCard | undefined) {
    if (!neighbor) return
    await run(async () => {
      await giwaApi.admin.saveFeatured(auth, card.id, { position: neighbor.position })
      await giwaApi.admin.saveFeatured(auth, neighbor.id, { position: card.position })
    })
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <GiwaBrandMark src={logo} label={product?.symbol ?? card.productId} size={40} />
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-base font-medium text-[var(--color-arco-ink)]">{name}</span>
              {card.shown ? (
                <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[11px] text-[var(--color-arco-text-soft)]">
                  Shown
                </span>
              ) : (
                <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--color-arco-muted)]">
                  Hidden
                </span>
              )}
            </div>
            {product ? (
              <span className="font-mono text-[11px] text-[var(--color-arco-muted)]">{product.symbol}</span>
            ) : (
              <span className="text-[11px] text-[var(--color-arco-down)]">Vault no longer in the registry — hide or remove this card.</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Move up"
            onClick={() => void swapWith(neighborAbove)}
            disabled={!neighborAbove || phase === "saving"}
            className="inline-flex size-8 items-center justify-center rounded-md border border-[var(--color-arco-border)] text-[var(--color-arco-ink)] disabled:opacity-40"
          >
            <ChevronUp className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Move down"
            onClick={() => void swapWith(neighborBelow)}
            disabled={!neighborBelow || phase === "saving"}
            className="inline-flex size-8 items-center justify-center rounded-md border border-[var(--color-arco-border)] text-[var(--color-arco-ink)] disabled:opacity-40"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </div>

      <label className="mt-4 block text-xs text-[var(--color-arco-muted)]">
        <span className="flex items-center justify-between">
          About (shown under the vault name on the card)
          <span className={overLimit ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-muted)]"}>
            {about.length}/{ABOUT_MAX}
          </span>
        </span>
        <textarea
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          rows={3}
          maxLength={ABOUT_MAX}
          placeholder="A short intro for this vault on the products hero carousel."
          className="mt-1 w-full rounded-md border border-[var(--color-arco-border)] px-3 py-2 text-sm"
        />
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run(() => giwaApi.admin.saveFeatured(auth, card.id, { about: about.trim() || null }))}
          disabled={phase === "saving" || overLimit}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
        >
          {phase === "saving" && <Loader2 className="size-3.5 animate-spin" />}
          Save intro
        </button>

        {card.shown ? (
          <button
            type="button"
            onClick={() => void run(() => giwaApi.admin.saveFeatured(auth, card.id, { shown: false }))}
            disabled={phase === "saving"}
            className="inline-flex h-9 items-center rounded-md bg-[var(--color-arco-chip)] px-4 text-xs font-medium text-[var(--color-arco-text-soft)] disabled:opacity-50"
          >
            Hide
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void run(() => giwaApi.admin.saveFeatured(auth, card.id, { shown: true }))}
            disabled={phase === "saving"}
            className="inline-flex h-9 items-center rounded-md bg-[var(--color-arco-ink)] px-4 text-xs font-medium text-[var(--color-arco-on-dark)] disabled:opacity-50"
          >
            Register
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Remove the featured card for ${name}?`)) void run(() => giwaApi.admin.removeFeatured(auth, card.id))
          }}
          disabled={phase === "saving"}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--color-arco-border)] px-3 text-xs font-medium text-[var(--color-arco-down)] disabled:opacity-50"
        >
          <Trash2 className="size-3.5" />
          Remove
        </button>

        {phase === "saved" && <CheckCircle2 className="size-4 text-[var(--color-arco-up)]" />}
        {phase === "failed" && error && (
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-arco-down)]">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </span>
        )}
      </div>
    </Card>
  )
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5" style={{ boxShadow: "var(--shadow-control)" }}>
      {children}
    </div>
  )
}
