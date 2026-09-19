import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Info,
  Loader2,
  LogOut,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react"
import { formatUnits, parseUnits } from "viem"
import { GIWA_ADMIN_ADDRESSES_RAW, GIWA_CHAIN_ID, GIWA_FAUCET_URL } from "./config"
import { giwaApi, hasDeploymentAddresses } from "./api"
import {
  dripAllTestAssets,
  readTokenBalance,
  waitForSuccessfulReceipt,
} from "./contracts"
import { requiredPaymentInvariant } from "./operation-routing"
import { computeQuote } from "./price-policy"
import type {
  GiwaActivity,
  GiwaCatalogItem,
  GiwaFeaturedCard,
  GiwaPortfolio,
  GiwaRedemption,
  HexAddress,
  UiPhase,
} from "./types"
import { explorerTx, useGiwaWallet } from "./wallet"
import { vaultConfigOf, vaultDisplayName } from "./catalog"
import { formatPercentFromBps, parseAumToNumber } from "./display-profile"
import { compareNullLast } from "./sort"
import { buildActivityFeed, type ActivityRow } from "./activity-feed"
import { isVaultCategory, type VaultCategory } from "../../../shared/vault-taxonomy"
import { isAdminAddress, parseAdminAddresses } from "./admin-access"
import { GIWA_PREPROD_ROUTE, giwaProductPath } from "./routes"
import { GiwaHeaderMenu } from "./GiwaHeaderMenu"
import { BrandMark } from "../components/BrandMark"
import { ASSET_MANAGERS, ISSUERS, ISSUER_OPTIONS, aumLabel, apyLabel, productById } from "../data/products"
import { ACAPIX_INSTANT_FEES } from "../data/acapix-detail"
import { Input } from "@/components/ui/input"
import { GiwaMultiSelect } from "./GiwaMultiSelect"
import {
  AmountBlock,
  AmountField,
  INVEST_CTA,
  INVEST_CTA_BUSY,
  INVEST_CTA_READY,
  INVEST_NOTICE,
  INVEST_PANEL_CARD,
  INVEST_TAB,
  INVEST_TAB_ACTIVE,
  INVEST_TAB_INACTIVE,
  INVEST_TAB_TRACK,
  InfoRow,
} from "./invest-panel-ui"

// VISIBILITY gate only (not security): the admin nav link is shown solely to allowlisted
// wallets. Real enforcement is server requireOperator + on-chain FEED_ADMIN_ROLE.
const ADMIN_ALLOWLIST = parseAdminAddresses(GIWA_ADMIN_ADDRESSES_RAW)

// Canonical taxonomy lives in shared/vault-taxonomy.ts (single source across §2 config,
// the 2c-2 deploy-params schema, and the server validation drift test).
export type GiwaCategory = VaultCategory
export type GiwaFilters = {
  category: GiwaCategory[]
  denomination: string[]
  issuer: string[]
  network: string[]
  search: string
}

export const GIWA_EMPTY_FILTERS: GiwaFilters = {
  category: [],
  denomination: [],
  issuer: [],
  network: [],
  search: "",
}

const HEAD = "px-1.5 py-2.5 text-sm font-normal text-[var(--color-arco-text)]"
const PRODUCT_COLS =
  "grid-cols-[minmax(190px,1.55fr)_0.72fr_0.7fr_0.9fr_0.9fr_0.6fr]"
const HOLDING_COLS =
  "grid-cols-[minmax(180px,1.5fr)_0.8fr_1.05fr_0.9fr_0.65fr_0.6fr]"
const ACTIVITY_COLS =
  "grid-cols-[0.85fr_minmax(160px,1.3fr)_0.8fr_0.85fr_0.9fr_0.6fr]"

// Full category metadata (title/blurb/tag/bg) for ALL taxonomy values — single-sources
// categoryTitle for every category, including ones hidden from the investor Strategies section.
// `hidden` keeps a valid category (still selectable in admin) out of the investor cards + filter.
const STRATEGIES: Array<{
  category: GiwaCategory
  title: string
  blurb: string
  tag: string
  bg: string
  hidden?: boolean
}> = [
  {
    category: "U.S Treasuries",
    title: "U.S. Treasuries",
    blurb: "Money-market and Treasury-shaped products funded with the required GIWA test asset.",
    tag: "Low Risk Strategies",
    bg: "var(--color-strategy-treasuries)",
  },
  {
    category: "Prime Credit",
    title: "Prime Credit",
    blurb: "Alternative-credit exposure with deposit and redemption routed to split vaults.",
    tag: "High Yield Strategies",
    bg: "var(--color-strategy-credit)",
  },
  {
    // Valid everywhere (admin dropdown, taxonomy) but hidden from the investor Strategies
    // section; operators hide the Arco Saving vaults themselves.
    category: "Arco Saving",
    title: "Arco Saving",
    blurb: "Crypto-native test products mapped one-to-one to BTC, XRP, or WETH payment assets.",
    tag: "Crypto Native Asset",
    bg: "var(--color-strategy-saving)",
    hidden: true,
  },
  {
    category: "Equity Exposure",
    title: "Equity Exposure",
    blurb: "Tokenized equity offering diversified growth and dividend income exposure.",
    tag: "Equity Income Strategies",
    bg: "var(--color-strategy-equity)",
  },
]

// The Strategies section and the investor category filter both consult these — the visible
// categories (Arco Saving excluded), in canonical order.
const VISIBLE_STRATEGIES = STRATEGIES.filter((strategy) => !strategy.hidden)
const INVESTOR_CATEGORIES: GiwaCategory[] = VISIBLE_STRATEGIES.map((strategy) => strategy.category)

// Display label for a taxonomy category, single-sourced from the strategy cards
// (e.g. canonical "U.S Treasuries" → shown "U.S. Treasuries"). Unknown → as-is.
const CATEGORY_TITLE = new Map(STRATEGIES.map((strategy) => [strategy.category, strategy.title]))
function categoryTitle(category: string): string {
  return CATEGORY_TITLE.get(category as GiwaCategory) ?? category
}

const TOKEN_ICONS: Record<string, string> = {
  abtc: "/logos/abtc.png",
  aeth: "/logos/aeth.png",
  acapix: "/logos/aksia.svg",
  ibenji: "/logos/ibenji.svg",
  umint: "/logos/umint.svg",
}

function compactNumber(n: number, max = 2) {
  return Number(n.toFixed(max)).toLocaleString("en-US", { maximumFractionDigits: max })
}

// Trim an estimated quote/price to <=6 decimals, dropping trailing zeros (e.g. 1.000000 -> "1").
function quoteText(n: number): string {
  return n.toFixed(6).replace(/\.?0+$/, "")
}

function moneyLabel(n: number | null | undefined) {
  if (n === undefined || n === null || Number.isNaN(n)) return "--"
  if (n >= 1_000_000_000) return `$${compactNumber(n / 1_000_000_000)}B`
  if (n >= 1_000_000) return `$${compactNumber(n / 1_000_000)}M`
  if (n >= 1_000) return `$${compactNumber(n / 1_000)}K`
  return `$${compactNumber(n)}`
}

function tokenLabel(value: unknown, symbol: string) {
  if (typeof value === "string" && value.trim()) return `${value} ${symbol}`
  if (typeof value === "number") return `${compactNumber(value, 6)} ${symbol}`
  return `-- ${symbol}`
}

function shortAddr(address: string | null | undefined) {
  if (!address) return "--"
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function tokenIcon(productId: string) {
  return TOKEN_ICONS[productId.toLowerCase()]
}

// Config-first product-token / vault image: admin vaultImageUrl → legacy token icon →
// (undefined → BrandMark letter fallback). Single source shared by the list row and the
// swap panel so the product-token logo always agrees; built-ins (null config) → legacy icon.
function vaultImageFor(product: Pick<GiwaCatalogItem, "productId" | "vaultConfig">): string | undefined {
  return vaultConfigOf(product).vaultImageUrl ?? tokenIcon(product.productId)
}

function paymentAssetIcon(symbol: string) {
  if (symbol === "tUSDC") return "/logos/usdc.svg"
  if (symbol === "tBTC") return "/logos/abtc.png"
  if (symbol === "tWETH") return "/logos/aeth.png"
  if (symbol === "tXRP") return "/logos/XRP.png"
  return undefined
}

function productCategory(
  product: Pick<GiwaCatalogItem, "productId" | "symbol" | "paymentAssetSymbol" | "vaultConfig">,
): GiwaCategory {
  // Operator override first (server-validated against this same taxonomy), then the
  // built-in derivation.
  const override = vaultConfigOf(product).category
  if (isVaultCategory(override)) return override
  const id = product.productId.toLowerCase()
  if (id === "acapix") return "Prime Credit"
  if (product.paymentAssetSymbol === "tBTC" || product.paymentAssetSymbol === "tXRP" || product.paymentAssetSymbol === "tWETH") {
    return "Arco Saving"
  }
  return "U.S Treasuries"
}

function productType(product: Pick<GiwaCatalogItem, "productId" | "paymentAssetSymbol">) {
  const id = product.productId.toLowerCase()
  if (id === "acapix") return "Private Credit"
  if (product.paymentAssetSymbol === "tBTC" || product.paymentAssetSymbol === "tXRP" || product.paymentAssetSymbol === "tWETH") return "Arco Saving"
  return "Money Market Fund"
}

function productBlurb(product: GiwaCatalogItem) {
  return `${product.name} on GIWA Sepolia, accepting ${product.paymentAssetSymbol} only through the registry-bound vaults.`
}

function networkLabel(chainId?: number | null) {
  if (!chainId) return "Not connected"
  return chainId === GIWA_CHAIN_ID ? "GIWA Sepolia" : `Wrong network ${chainId}`
}

function positionProductId(position: unknown) {
  return typeof position === "object" && position !== null && "productId" in position
    ? String((position as { productId?: unknown }).productId)
    : ""
}

function positionValue(position: unknown, key: string) {
  return typeof position === "object" && position !== null && key in position
    ? (position as Record<string, unknown>)[key]
    : undefined
}

function statusTone(phase: UiPhase) {
  const good = phase === "ready" || phase === "success" || phase === "claimable"
  const bad = phase === "failed" || phase === "wrong-network" || phase === "missing-gas" || phase === "missing-payment-token"
  return { good, bad }
}

function SortChevrons({ active }: { active?: "asc" | "desc" }) {
  return (
    <span className="flex flex-col">
      <ChevronUp className={`size-3 text-[var(--color-arco-text)] ${active === "asc" ? "opacity-100" : "opacity-30"}`} />
      <ChevronDown className={`-mt-1 size-3 text-[var(--color-arco-text)] ${active === "desc" ? "opacity-100" : "opacity-30"}`} />
    </span>
  )
}

export function uniquePaymentAssets(products: GiwaCatalogItem[]) {
  const seen = new Set<string>()
  const assets: Array<{
    symbol: string
    name: string
    decimals: number
    address: HexAddress
    faucet: HexAddress | null
  }> = []
  for (const product of products) {
    if (!product.paymentAssetAddress || seen.has(product.paymentAssetAddress.toLowerCase())) continue
    seen.add(product.paymentAssetAddress.toLowerCase())
    assets.push({
      symbol: product.paymentAssetSymbol,
      name: product.paymentAsset?.name ?? product.paymentAssetSymbol,
      decimals: product.paymentAsset?.decimals ?? 18,
      address: product.paymentAssetAddress,
      faucet: (product.paymentAsset?.faucetAddress ?? product.paymentAsset?.faucet ?? null) as HexAddress | null,
    })
  }
  return assets
}

export function applyGiwaFilters(products: GiwaCatalogItem[], filters: GiwaFilters) {
  const query = filters.search.trim().toLowerCase()
  return products.filter((product) => {
    if (filters.category.length && !filters.category.includes(productCategory(product))) return false
    if (filters.denomination.length && !filters.denomination.includes(denominationOf(product))) return false
    if (filters.issuer.length && !filters.issuer.includes(legacyProfile(product).issuer ?? "")) return false
    if (filters.network.length && !networksOf(product).some((network) => filters.network.includes(network))) return false
    if (!query) return true
    return [
      product.productId,
      product.symbol,
      product.name,
      product.paymentAssetSymbol,
      product.paymentAssetAddress,
      product.productTokenAddress,
      product.depositVaultAddress,
      product.redemptionVaultAddress,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query)
  })
}

export function StatusPill({ phase }: { phase: UiPhase }) {
  const tone = statusTone(phase)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
        tone.good
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
          : tone.bad
            ? "bg-red-50 text-red-700 ring-red-200"
            : "bg-[var(--color-arco-chip)] text-[var(--color-arco-text-soft)] ring-[var(--color-arco-border)]"
      }`}
    >
      {tone.good ? <CheckCircle2 className="size-3" /> : tone.bad ? <AlertCircle className="size-3" /> : <Loader2 className="size-3" />}
      {phase.replace(/-/g, " ")}
    </span>
  )
}

export function GiwaBrandMark({
  src,
  label,
  size = 20,
  shape = "round",
  className = "",
}: {
  src?: string
  label: string
  size?: number
  shape?: "round" | "rounded"
  className?: string
}) {
  const [broken, setBroken] = useState(false)
  const radius = shape === "round" ? "9999px" : "6px"
  const initial = (label.trim().charAt(0) || "?").toUpperCase()

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={label}
        title={label}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 object-contain ${className}`}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    )
  }

  return (
    <span
      aria-hidden
      title={label}
      className={`inline-flex shrink-0 items-center justify-center font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: "var(--color-arco-chip)",
        color: "var(--color-arco-chip-ink)",
        fontSize: size * 0.46,
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  )
}

export function GiwaNetworkIcon({ size = 20 }: { size?: number }) {
  return (
    <span title="GIWA Sepolia" className="inline-flex shrink-0" style={{ width: size, height: size }}>
      <img src="/logos/giwa.png" alt="GIWA" width={size} height={size} className="rounded-full object-contain" />
    </span>
  )
}

export function GiwaWalletButton() {
  const wallet = useGiwaWallet()

  if (wallet.connected && wallet.address) {
    return (
      <div className="inline-flex h-8 items-center gap-2 rounded-full bg-[var(--color-arco-surface)] py-1 pl-1 pr-2 shadow-[var(--shadow-control)]">
        <span className="rounded-full bg-[var(--color-arco-chip)] px-2 py-0.5 text-xs text-[var(--color-arco-text-soft)]">
          {wallet.chainId === GIWA_CHAIN_ID ? "GIWA" : "Wrong network"}
        </span>
        <span className="font-mono text-xs text-[var(--color-arco-muted)]">{shortAddr(wallet.address)}</span>
        <button
          type="button"
          aria-label="Disconnect wallet"
          className="inline-flex size-6 items-center justify-center rounded-full text-[var(--color-arco-muted)] hover:bg-[var(--color-arco-chip)]"
          onClick={wallet.disconnect}
        >
          <LogOut className="size-3.5" />
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-2 rounded-md bg-[var(--color-arco-ink)] px-3 text-sm font-medium text-[var(--color-arco-cream)] lg:h-12 lg:px-6 lg:text-base"
      onClick={() => void wallet.connect()}
    >
      <Wallet className="size-4" />
      Connect Wallet
    </button>
  )
}

const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000
const FAUCET_LAST_MINT_PREFIX = "arco.giwa.faucetLastMint."

function faucetLastMintKey(address: string) {
  return `${FAUCET_LAST_MINT_PREFIX}${address.toLowerCase()}`
}

function readFaucetLastMint(address: string): number | null {
  try {
    const raw = window.localStorage.getItem(faucetLastMintKey(address))
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function writeFaucetLastMint(address: string, at: number) {
  try {
    window.localStorage.setItem(faucetLastMintKey(address), String(at))
  } catch {
    /* ignore storage failures */
  }
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function TestFundsButton({ admin = false }: { admin?: boolean }) {
  const wallet = useGiwaWallet()
  const queryClient = useQueryClient()
  const catalogQuery = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog, enabled: !admin })
  const assets = useMemo(() => uniquePaymentAssets(catalogQuery.data ?? []), [catalogQuery.data])
  const faucet = assets.find((asset) => asset.faucet)?.faucet ?? null
  const [phase, setPhase] = useState<UiPhase>("ready")
  const [message, setMessage] = useState<string | null>(null)
  const [cooldownNotice, setCooldownNotice] = useState<string | null>(null)
  const [balances, setBalances] = useState<Array<[string, string]>>([])

  // Auto-dismiss the cooldown notice after 5 seconds.
  useEffect(() => {
    if (!cooldownNotice) return
    const timer = setTimeout(() => setCooldownNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [cooldownNotice])

  if (admin) return null

  async function mintFunds() {
    setMessage(null)
    setBalances([])
    try {
      if (!wallet.address) {
        await wallet.connect()
        return
      }
      if (wallet.chainId !== GIWA_CHAIN_ID) {
        await wallet.switchToGiwa()
        return
      }
      if (!faucet) throw new Error("Faucet address is missing from the registry")
      // Pre-empt the 24h faucet cooldown on the client so we don't spend gas on a
      // tx the contract will revert. Show a transient notice instead.
      const lastMint = readFaucetLastMint(wallet.address)
      if (lastMint !== null) {
        const elapsed = Date.now() - lastMint
        if (elapsed < FAUCET_COOLDOWN_MS) {
          const remaining = FAUCET_COOLDOWN_MS - elapsed
          setCooldownNotice(
            `Today's minting is done. Please wait ${formatRemaining(remaining)} before minting test assets again.`,
          )
          return
        }
      }
      const tokens = assets.map((asset) => asset.address)
      setPhase("submitting")
      const result = await dripAllTestAssets({ account: wallet.address, faucet, tokens })
      setPhase("confirming")
      for (const hash of result.hashes) {
        await waitForSuccessfulReceipt(hash)
      }
      const nextBalances = await Promise.all(
        assets.map(async (asset) => [
          asset.symbol,
          await readTokenBalance(asset.address, wallet.address!, asset.decimals),
        ] as [string, string]),
      )
      setBalances(nextBalances)
      await queryClient.invalidateQueries({ queryKey: ["giwa", "payment-balances", wallet.address] })
      await wallet.refreshBalance()
      writeFaucetLastMint(wallet.address, Date.now())
      setPhase("success")
      setMessage(
        result.mode === "dripAll"
          ? "Minted all configured test assets in one transaction."
          : `dripAll is not active on this faucet yet; used per-asset fallback. ${result.fallbackReason}`,
      )
    } catch (err) {
      setPhase("failed")
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const busy = phase === "submitting" || phase === "confirming"
  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy || catalogQuery.isLoading}
        onClick={() => void mintFunds()}
        className="inline-flex h-12 items-center gap-2 rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-4 text-sm font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)] disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowDown className="size-4" />}
        {phase === "confirming" ? "Confirming" : "Mint test assets"}
      </button>
      {(cooldownNotice || message || balances.length > 0) && (
        <div className="absolute inset-x-0 top-[calc(100%+8px)] z-50 rounded-[var(--radius-card)] lg:left-auto lg:w-[280px] bg-[var(--color-arco-surface)] p-3 text-xs shadow-[var(--shadow-table)]">
          {cooldownNotice && <p className="text-[var(--color-arco-ink)]">{cooldownNotice}</p>}
          {message && <p className={phase === "failed" ? "text-red-700" : "text-[var(--color-arco-text-soft)]"}>{message}</p>}
          {balances.length > 0 && (
            <dl className="mt-2 space-y-1">
              {balances.map(([symbol, balance]) => (
                <div key={symbol} className="flex items-center justify-between">
                  <dt className="text-[var(--color-arco-muted)]">{symbol}</dt>
                  <dd className="tabular-nums text-[var(--color-arco-ink)]">{balance}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}

// VISIBILITY only (see ADMIN_ALLOWLIST): shows the Admin nav item to allowlisted wallets.
export function useGiwaIsAdmin(): boolean {
  const { address } = useGiwaWallet()
  return isAdminAddress(address, ADMIN_ALLOWLIST)
}

// Top bar of the investor shell. Below xl it carries the menu trigger + logo (the sidebar is hidden);
// the nav itself lives in GiwaSidebarNav. Height stays 76px at every width: SectionNav (top-[76px])
// and the invest panel (top-[104px]) stick beneath it.
export function GiwaHeader({ admin = false }: { admin?: boolean }) {
  const isAdmin = useGiwaIsAdmin()
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-arco-border)] bg-[var(--color-arco-page-80)] backdrop-blur">
      <div className="mx-auto flex min-h-[76px] w-full max-w-[1512px] items-center justify-between gap-3 px-4 md:px-8">
        <div className="flex items-center gap-2 xl:hidden">
          <GiwaHeaderMenu isAdmin={isAdmin} testFunds={admin ? undefined : <TestFundsButton admin={admin} />} />
          <Link
            to={GIWA_PREPROD_ROUTE}
            aria-label="Arco home"
            className="flex items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
          >
            <img src="/arco-icon.svg" alt="Arco" className="h-[33px] w-[35px] shrink-0" />
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <GiwaWalletButton />
          {/* Mint test assets: top bar from lg; below lg it lives in the menu drawer. */}
          {!admin && (
            <div className="hidden lg:block">
              <TestFundsButton admin={admin} />
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

export function GiwaFeaturedCarousel({ cards, catalog }: { cards: GiwaFeaturedCard[]; catalog: GiwaCatalogItem[] }) {
  const navigate = useNavigate()
  const byId = new Map(catalog.map((product) => [product.productId, product]))
  // `cards` arrive shown-only + position-ordered from the server. Join each to its vault and
  // DROP any whose vault is absent from the (non-hidden) catalog — a de-registered or
  // now-hidden vault must never surface in the carousel. Cap at 3.
  const items = cards
    .map((card) => ({ card, product: byId.get(card.productId) }))
    .filter((entry): entry is { card: GiwaFeaturedCard; product: GiwaCatalogItem } => Boolean(entry.product))
    .slice(0, 3)
  const [index, setIndex] = useState(0)
  const active = items[index] ?? items[0]

  if (!active) return null

  const { card, product } = active

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => navigate(giwaProductPath(product.productId))}
        className="relative flex h-[189px] w-full items-center overflow-hidden rounded-[8px] bg-[var(--color-arco-hero)] px-12 text-left"
      >
        <img
          src="/carousel-bg.png"
          alt=""
          className="pointer-events-none absolute right-0 top-0 h-full w-[300px] object-cover"
          style={{
            WebkitMaskImage: "linear-gradient(to left, #000 55%, transparent 100%)",
            maskImage: "linear-gradient(to left, #000 55%, transparent 100%)",
          }}
        />
        <div className="relative z-10 flex items-center gap-7">
          <GiwaBrandMark
            src={vaultImageFor(product)}
            label={product.symbol}
            size={90}
            className="bg-[var(--color-arco-hero-deco-2)]"
          />
          <div className="max-w-[460px]">
            <h2 className="text-2xl font-bold leading-tight text-[var(--color-arco-cream)]">{vaultDisplayName(product)}</h2>
            <p className="mt-2 text-sm leading-5 text-[var(--color-arco-cream)]">{card.about?.trim() || productBlurb(product)}</p>
          </div>
        </div>
      </button>
      {items.length > 1 && (
        <div className="flex justify-center gap-2">
          {items.map(({ product: item }, itemIndex) => (
            <button
              key={item.productId}
              type="button"
              aria-label={`Show ${vaultDisplayName(item)}`}
              aria-current={itemIndex === index}
              onClick={() => setIndex(itemIndex)}
              className="grid h-8 place-items-center px-1"
            >
              <span
                className="size-2 rounded-full transition-colors"
                style={{
                  background: itemIndex === index ? "var(--color-arco-dot-active)" : "var(--color-arco-dot-inactive)",
                }}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

export function GiwaStrategyCards({
  products,
  active,
  onToggle,
}: {
  products: GiwaCatalogItem[]
  active: GiwaCategory[]
  onToggle: (category: GiwaCategory) => void
}) {
  return (
    <section className="space-y-3">
      <h2 className="pl-1 text-lg font-medium text-[var(--color-arco-ink)]">Strategies</h2>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {VISIBLE_STRATEGIES.map((strategy) => {
          const selected = active.includes(strategy.category)
          const count = products.filter((product) => productCategory(product) === strategy.category).length
          return (
            <button
              key={strategy.category}
              type="button"
              aria-pressed={selected}
              onClick={() => onToggle(strategy.category)}
              className={`flex min-w-[240px] flex-1 flex-col items-start justify-between rounded-[12px] p-4 text-left transition-[box-shadow,transform] duration-150 ${
                selected ? "ring-2 ring-[var(--color-arco-cream-70)] ring-offset-2 ring-offset-[var(--color-arco-page)]" : "hover:brightness-110"
              }`}
              style={{ background: strategy.bg, height: 136 }}
            >
              <div className="space-y-1">
                <h3 className="text-lg font-medium leading-6 text-[var(--color-arco-cream)]">{strategy.title}</h3>
                <p className="line-clamp-2 h-10 max-w-[280px] text-sm leading-5 text-[var(--color-arco-cream)] opacity-80">
                  {strategy.blurb}
                </p>
              </div>
              <span className="rounded-[4px] bg-[var(--color-arco-overlay)] px-1 py-0.5 text-xs font-medium text-[var(--color-arco-cream)]">
                {strategy.tag} · {count}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

// Canonical denomination order for the filter dropdown (derived from the base asset).
const GIWA_DENOMINATIONS = ["USD", "BTC", "ETH", "XRP"]

// Network filter options (ordered) + their brand logos. "Giwa" is the actual chain; Ethereum/XRPL
// come from the mapped legacy product. Ethereum reuses the ETH diamond mark already used for ETH.
const NETWORK_ORDER = ["Ethereum", "XRPL", "Giwa"]
const NETWORK_LOGOS: Record<string, string> = {
  Ethereum: "/logos/ethereum.svg",
  XRPL: "/logos/XRP.png",
  Giwa: "/logos/giwa.png",
}

// Multi-select filter bar: Category · Denomination · Issuer · Network + name/address search.
// Options are DERIVED from the current rows' unique mapped values (ordered by the canonical lists),
// so every option actually filters and no row is left unfilterable. Issuer rows carry a logo.
export function GiwaFilterBar({
  products,
  filters,
  onChange,
}: {
  products: GiwaCatalogItem[]
  filters: GiwaFilters
  onChange: (patch: Partial<GiwaFilters>) => void
}) {
  const categoryPresent = new Set(products.map(productCategory))
  const denomPresent = new Set(products.map(denominationOf))
  const issuerPresent = new Set(products.map((product) => legacyProfile(product).issuer).filter(Boolean) as string[])
  const networkPresent = new Set(products.flatMap(networksOf))

  // Investor-visible categories only (Arco Saving excluded, matching the hidden Strategies card),
  // and only those actually present in the visible vaults — so no empty/unfilterable option.
  const categoryOptions = INVESTOR_CATEGORIES.filter((category) => categoryPresent.has(category)).map((category) => ({ value: category, label: category }))
  const denominationOptions = GIWA_DENOMINATIONS.filter((denom) => denomPresent.has(denom)).map((denom) => ({ value: denom, label: denom }))
  const issuerOptions = ISSUER_OPTIONS.filter((issuer) => issuerPresent.has(issuer.key)).map((issuer) => ({
    value: issuer.key,
    label: issuer.label,
    icon: ISSUERS[issuer.key]?.logo,
  }))
  const networkOptions = NETWORK_ORDER.filter((network) => networkPresent.has(network)).map((network) => ({ value: network, label: network, icon: NETWORK_LOGOS[network] }))

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <GiwaMultiSelect
          label="Category"
          options={categoryOptions}
          selected={filters.category}
          onChange={(next) => onChange({ category: next as GiwaCategory[] })}
        />
        <GiwaMultiSelect
          label="Denomination"
          options={denominationOptions}
          selected={filters.denomination}
          onChange={(next) => onChange({ denomination: next })}
        />
        <GiwaMultiSelect
          label="Issuer"
          options={issuerOptions}
          selected={filters.issuer}
          onChange={(next) => onChange({ issuer: next })}
        />
        <GiwaMultiSelect
          label="Network"
          options={networkOptions}
          selected={filters.network}
          onChange={(next) => onChange({ network: next })}
        />
      </div>
      <div className="relative min-w-[200px] flex-1">
        <Input
          value={filters.search}
          onChange={(event) => onChange({ search: event.target.value })}
          placeholder="Search name or address"
          className="h-11 rounded-[5px] border-0 bg-[var(--color-arco-surface)] pr-10 text-sm shadow-[0_0_0_0.5px_var(--color-arco-border)] placeholder:text-[var(--color-arco-muted)]"
        />
        <Search className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-[var(--color-arco-muted)]" />
      </div>
    </div>
  )
}

export function ProductCatalogList({
  products,
  selectedProductId,
  onSelect,
}: {
  products: GiwaCatalogItem[]
  selectedProductId: string
  onSelect: (productId: string) => void
}) {
  return (
    <GiwaProductsTable
      rows={products}
      selectedProductId={selectedProductId}
      sortDir="desc"
      onSelect={onSelect}
    />
  )
}

export function GiwaProductsTable({
  rows,
  selectedProductId,
  sortDir,
  onToggleSort,
  onSelect,
}: {
  rows: GiwaCatalogItem[]
  selectedProductId: string
  sortDir: "asc" | "desc"
  onToggleSort?: () => void
  onSelect: (productId: string) => void
}) {
  const sorted = useMemo(() => {
    const next = [...rows]
    next.sort((a, b) => {
      const left = productCategory(a).localeCompare(productCategory(b)) || a.symbol.localeCompare(b.symbol)
      return sortDir === "desc" ? left : -left
    })
    return next
  }, [rows, sortDir])

  return (
    <div
      className="overflow-x-auto rounded-[var(--radius-card)] bg-[var(--color-arco-surface-30)] p-5"
      style={{ boxShadow: "var(--shadow-table)" }}
      data-testid="giwa-catalog"
    >
      <div className={`grid min-w-[900px] ${PRODUCT_COLS} items-center px-1.5 pb-2`}>
        <span className={HEAD}>Product</span>
        <span className={`${HEAD} text-center`}>Payment</span>
        <span className={`${HEAD} text-center`}>Decimals</span>
        <button
          type="button"
          onClick={onToggleSort}
          className={`${HEAD} flex items-center justify-end gap-1 text-right hover:text-[var(--color-arco-ink)]`}
        >
          Registry
          <SortChevrons active={sortDir} />
        </button>
        <span className={`${HEAD} text-center`}>Vault route</span>
        <span className={`${HEAD} text-center`}>Network</span>
      </div>

      {sorted.length === 0 ? (
        <div className="flex min-w-[900px] flex-col items-center gap-3 rounded-[var(--radius-row)] bg-[var(--color-arco-surface)] px-6 py-14 text-center">
          <p className="text-sm text-[var(--color-arco-muted)]">No products match your filters.</p>
        </div>
      ) : (
        <div className="flex min-w-[900px] flex-col gap-2.5">
          {sorted.map((product) => (
            <GiwaProductRow
              key={product.productId}
              product={product}
              selected={product.productId === selectedProductId}
              onSelect={() => onSelect(product.productId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GiwaProductRow({
  product,
  selected,
  onSelect,
}: {
  product: GiwaCatalogItem
  selected: boolean
  onSelect: () => void
}) {
  const rowBg = productCategory(product) === "Arco Saving" ? "bg-[var(--color-row-saving)]" : "bg-[var(--color-arco-surface)]"
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect()}
      className={`group relative grid h-[59px] cursor-pointer ${PRODUCT_COLS} items-center rounded-[var(--radius-row)] px-1.5 outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-[var(--color-arco-ink-40)] ${
        selected ? "ring-2 ring-[var(--color-arco-ink-40)]" : ""
      } ${rowBg}`}
    >
      <span className="pointer-events-none absolute inset-0 rounded-[var(--radius-row)] bg-transparent backdrop-blur-0 transition-all duration-150 group-hover:bg-[var(--color-row-hover-weak)] group-hover:backdrop-blur-[1px]" />
      <div className="relative z-10 flex items-center gap-2.5 pl-1">
        <GiwaBrandMark src={tokenIcon(product.productId)} label={product.symbol} size={35} />
        <div className="flex flex-col">
          <span className="text-base font-medium leading-5 text-[var(--color-arco-ink)]">{product.symbol}</span>
          <span className="mt-1 w-fit rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
            {productType(product)}
          </span>
        </div>
      </div>
      <div className="relative z-10 flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]">
          <GiwaBrandMark src={paymentAssetIcon(product.paymentAssetSymbol)} label={product.paymentAssetSymbol} size={18} />
          {product.paymentAssetSymbol}
        </span>
      </div>
      <div className="relative z-10 text-center tabular-nums text-sm text-[var(--color-arco-ink)]">{product.paymentAsset?.decimals ?? "--"}</div>
      <div className="relative z-10 text-right text-xs text-[var(--color-arco-text-soft)]">
        <span className="block font-medium text-[var(--color-arco-ink)]">
          {hasDeploymentAddresses(product) ? "Loaded" : "Awaiting"}
        </span>
        <span>{requiredPaymentInvariant(product)}</span>
      </div>
      <div className="relative z-10 text-center font-mono text-[11px] text-[var(--color-arco-text-soft)]">
        <span title={product.depositVaultAddress ?? ""}>{shortAddr(product.depositVaultAddress)}</span>
        <span className="mx-1 text-[var(--color-arco-muted)]">/</span>
        <span title={product.redemptionVaultAddress ?? ""}>{shortAddr(product.redemptionVaultAddress)}</span>
      </div>
      <div className="relative z-10 flex justify-center">
        <GiwaNetworkIcon size={20} />
      </div>
    </div>
  )
}

// ── Investor catalog table (legacy-style columns) ──────────────────────────────
// Public products list at the root route. Mirrors the legacy ProductsTable column
// set (Product | Base Asset | Asset Manager | Issuer | AUM | APY | Network) over REAL
// GIWA registry rows. Kept SEPARATE from GiwaProductsTable so Admin's ProductCatalogList
// (operational columns: decimals / registry load-state / vault route) stays unchanged.
const CATALOG_COLS =
  "grid-cols-[minmax(190px,1.5fr)_0.85fr_1.15fr_0.9fr_1fr_0.9fr_0.55fr]"

// Base/settlement asset symbol without the testnet "t" prefix: tUSDC→USDC, tBTC→BTC,
// tWETH→ETH, tXRP→XRP.
function baseAssetSymbol(paymentSymbol: string): string {
  const base = paymentSymbol.replace(/^t/, "")
  return base === "WETH" ? "ETH" : base
}

// Denomination derived from the base/settlement asset for the filter bar: USDC settles USD;
// BTC/ETH/XRP keep their symbol. Mirrors the legacy Denomination filter, plus XRP for aXRP.
function denominationOf(product: GiwaCatalogItem): string {
  const base = baseAssetSymbol(product.paymentAssetSymbol)
  return base === "USDC" ? "USD" : base
}

// Networks for the Network filter. Every GIWA row is on GIWA Sepolia, so "Giwa" is always present
// (selecting it matches all rows, consistent with the Network column's GIWA logo); the mapped legacy
// product's Ethereum/XRPL are added for parity. aXRP has no legacy entry → ["Ethereum"] like its
// Arco Saving siblings.
function networksOf(product: GiwaCatalogItem): string[] {
  const legacy = productById(product.productId.toLowerCase())?.networks ?? ["Ethereum"]
  return ["Giwa", ...legacy]
}

// Legacy product profile for a GIWA row: Asset Manager / Issuer / AUM / APY come from
// products.ts. aXRP has no legacy entry — as an Arco Saving product it inherits Arco/Arco
// brand marks (like aBTC/aETH); AUM/APY stay null and render as "—".
function legacyProfile(product: GiwaCatalogItem): {
  assetManager: string | null
  issuer: string | null
  aum: number | null
  apy: number | null
} {
  const legacy = productById(product.productId.toLowerCase())
  if (legacy) {
    return { assetManager: legacy.assetManager, issuer: legacy.issuer, aum: legacy.aum, apy: legacy.apy }
  }
  const arcoSaving = productCategory(product) === "Arco Saving"
  return { assetManager: arcoSaving ? "arco" : null, issuer: arcoSaving ? "arco" : null, aum: null, apy: null }
}

export function GiwaCatalogTable({
  rows,
  selectedProductId,
  sortKey,
  sortDir,
  onSort,
  onSelect,
  apyByProductId,
  impliedApyByProductId,
}: {
  rows: GiwaCatalogItem[]
  selectedProductId: string
  sortKey: "aum" | "apy"
  sortDir: "asc" | "desc"
  onSort?: (key: "aum" | "apy") => void
  onSelect: (productId: string) => void
  apyByProductId?: Record<string, number | null>
  impliedApyByProductId?: Record<string, number | null>
}) {
  const sorted = useMemo(() => {
    // Config-first numeric AUM (matches the displayed value), and the resolved list APY;
    // null/"—" always sorts last (compareNullLast), in both directions.
    const aumKey = (p: GiwaCatalogItem) => parseAumToNumber(vaultConfigOf(p).aum) ?? legacyProfile(p).aum ?? null
    const apyKey = (p: GiwaCatalogItem) => {
      const id = p.productId.toLowerCase()
      return apyByProductId?.[id] ?? legacyProfile(p).apy ?? impliedApyByProductId?.[id] ?? null
    }
    const key = sortKey === "aum" ? aumKey : apyKey
    return [...rows].sort((a, b) => {
      // Operator-pinned vaults stay on top regardless of the sort.
      const pinned = Number(vaultConfigOf(b).pinned) - Number(vaultConfigOf(a).pinned)
      if (pinned !== 0) return pinned
      return compareNullLast(key(a), key(b), sortDir) || a.symbol.localeCompare(b.symbol)
    })
  }, [rows, sortKey, sortDir, apyByProductId, impliedApyByProductId])

  return (
    <div
      className="overflow-x-auto rounded-[var(--radius-card)] bg-[var(--color-arco-surface-30)] p-5"
      style={{ boxShadow: "var(--shadow-table)" }}
      data-testid="giwa-catalog"
    >
      <div className={`grid min-w-[1000px] ${CATALOG_COLS} items-center px-1.5 pb-2`}>
        <span className={HEAD}>Product</span>
        <span className={`${HEAD} text-center`}>Base Asset</span>
        <span className={`${HEAD} text-center`}>Asset Manager</span>
        <span className={`${HEAD} text-center`}>Issuer</span>
        <button
          type="button"
          onClick={() => onSort?.("aum")}
          className={`${HEAD} flex items-center justify-center gap-1 text-center hover:text-[var(--color-arco-ink)]`}
        >
          AUM
          <SortChevrons active={sortKey === "aum" ? sortDir : undefined} />
        </button>
        <button
          type="button"
          onClick={() => onSort?.("apy")}
          className={`${HEAD} flex items-center justify-center gap-1 text-center hover:text-[var(--color-arco-ink)]`}
        >
          APY
          <SortChevrons active={sortKey === "apy" ? sortDir : undefined} />
        </button>
        <span className={`${HEAD} text-center`}>Network</span>
      </div>

      {sorted.length === 0 ? (
        <div className="flex min-w-[1000px] flex-col items-center gap-3 rounded-[var(--radius-row)] bg-[var(--color-arco-surface)] px-6 py-14 text-center">
          <p className="text-sm text-[var(--color-arco-muted)]">No products match your filters.</p>
        </div>
      ) : (
        <div className="flex min-w-[1000px] flex-col gap-2.5">
          {sorted.map((product) => (
            <GiwaCatalogRow
              key={product.productId}
              product={product}
              apy={apyByProductId?.[product.productId.toLowerCase()] ?? null}
              impliedApy={impliedApyByProductId?.[product.productId.toLowerCase()] ?? null}
              selected={product.productId === selectedProductId}
              onSelect={() => onSelect(product.productId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GiwaCatalogRow({
  product,
  apy,
  impliedApy,
  selected,
  onSelect,
}: {
  product: GiwaCatalogItem
  apy: number | null
  impliedApy: number | null
  selected: boolean
  onSelect: () => void
}) {
  const profile = legacyProfile(product)
  const am = profile.assetManager ? ASSET_MANAGERS[profile.assetManager] : undefined
  const iss = profile.issuer ? ISSUERS[profile.issuer] : undefined
  const config = vaultConfigOf(product)
  // Config-first identity (mirrors the detail page): config value → legacy → letter/— fallback.
  // Built-ins have null config, so they resolve to the same legacy values as before.
  const vaultImage = vaultImageFor(product)
  const subtitle = config.category ? categoryTitle(config.category) : productType(product)
  const managerLabel = config.assetManagerName ?? am?.label ?? null
  const managerLogo = config.assetManagerImageUrl ?? am?.logo
  const issuerLabel = config.issuerName ?? iss?.label ?? null
  const issuerLogo = config.issuerImageUrl ?? iss?.logo
  const rowBg =
    config.pinned || productCategory(product) === "Arco Saving"
      ? "bg-[var(--color-row-saving)]"
      : "bg-[var(--color-arco-surface)]"
  const baseSymbol = baseAssetSymbol(product.paymentAssetSymbol)
  // Published rate wins, then the legacy profile (built-ins stay byte-identical); implied
  // APY only fills the gap for vaults with neither (e.g. newly-registered ones).
  const apyText =
    apy != null
      ? apyLabel(apy)
      : profile.apy != null
        ? apyLabel(profile.apy)
        : impliedApy != null
          ? apyLabel(impliedApy)
          : "—"
  // Config-first (matches the detail AUM stat): admin free-text AUM → legacy numeric → —.
  const aumText = config.aum ?? (profile.aum != null ? aumLabel(profile.aum) : "—")

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect()}
      className={`group relative grid h-[59px] cursor-pointer ${CATALOG_COLS} items-center rounded-[var(--radius-row)] px-1.5 outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-[var(--color-arco-ink-40)] ${
        selected ? "ring-2 ring-[var(--color-arco-ink-40)]" : ""
      } ${rowBg}`}
    >
      <span className="pointer-events-none absolute inset-0 rounded-[var(--radius-row)] bg-transparent backdrop-blur-0 transition-all duration-150 group-hover:bg-[var(--color-row-hover-weak)] group-hover:backdrop-blur-[1px]" />

      <div className="relative z-10 flex items-center gap-2.5 pl-1">
        <GiwaBrandMark src={vaultImage} label={product.symbol} size={35} />
        <div className="flex flex-col">
          <span className="text-base font-medium leading-5 text-[var(--color-arco-ink)]">
            {vaultDisplayName(product)}
          </span>
          <span className="mt-1 w-fit rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
            {subtitle}
          </span>
        </div>
      </div>

      <div className="relative z-10 flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]">
          <GiwaBrandMark src={paymentAssetIcon(product.paymentAssetSymbol)} label={baseSymbol} size={18} />
          {baseSymbol}
        </span>
      </div>

      <div className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 px-1">
        {managerLabel ? (
          <>
            <BrandMark src={managerLogo} label={managerLabel} size={20} />
            <span className="truncate text-xs text-[var(--color-arco-text-soft)]">{managerLabel}</span>
          </>
        ) : (
          <span className="text-xs text-[var(--color-arco-muted)]">—</span>
        )}
      </div>

      <div className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 px-1">
        {issuerLabel ? (
          <>
            <BrandMark src={issuerLogo} label={issuerLabel} size={20} />
            <span className="truncate text-xs text-[var(--color-arco-text-soft)]">{issuerLabel}</span>
          </>
        ) : (
          <span className="text-xs text-[var(--color-arco-muted)]">—</span>
        )}
      </div>

      <div className="relative z-10 text-center tabular-nums text-sm text-[var(--color-arco-ink)]">{aumText}</div>
      <div className="relative z-10 text-center tabular-nums text-sm text-[var(--color-arco-ink)]">{apyText}</div>
      <div className="relative z-10 flex justify-center">
        <GiwaNetworkIcon size={20} />
      </div>
    </div>
  )
}

// Expandable Transaction Fees content (Instant Fees). Config-first per fee: a set bps
// overrides the aCAPIX fallback; each is formatted with the shared percent rule.
function GiwaFeeBreakdown({ mintingBps, redemptionBps }: { mintingBps: number | null; redemptionBps: number | null }) {
  const fallbackMinting = ACAPIX_INSTANT_FEES.find((fee) => /mint/i.test(fee.label))?.pct ?? 0
  const fallbackRedemption = ACAPIX_INSTANT_FEES.find((fee) => /redem/i.test(fee.label))?.pct ?? 0
  const rows = [
    { label: "Instant Minting", value: mintingBps != null ? formatPercentFromBps(mintingBps) : apyLabel(fallbackMinting) },
    {
      label: "Instant Redemption",
      value: redemptionBps != null ? formatPercentFromBps(redemptionBps) : apyLabel(fallbackRedemption),
    },
  ]
  return (
    <div>
      <div className="flex items-center gap-1 text-xs text-[var(--color-arco-muted)]">
        Instant Fees
        <Info className="size-3" />
      </div>
      <div className="mt-1">
        {rows.map((fee) => (
          <div
            key={fee.label}
            className="flex items-center justify-between border-t border-[var(--color-arco-border)] py-2 pl-3 text-sm"
          >
            <span className="text-[var(--color-arco-text-soft)]">{fee.label}</span>
            <span className="tabular-nums text-[var(--color-arco-ink)]">{fee.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Vault shares are 18-dec (same constant the activity feed uses to humanise share amounts).
const PRODUCT_TOKEN_DECIMALS = 18

// Parse a human decimal string into base units at `decimals`. null when it isn't a plain
// non-negative number — the "--" balance placeholder, a blank field, or a half-typed "1.".
function toBaseUnits(value: string, decimals: number): bigint | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  try {
    return parseUnits(trimmed, decimals)
  } catch {
    return null
  }
}

// The amount being PAID exceeds the wallet balance the panel already shows. Compared in base
// units at the paying token's decimals, so a MAX-filled amount is exactly equal (never "over")
// and digits beyond the token's precision can't manufacture a false positive.
function exceedsBalance(amount: string, balance: string, decimals: number): boolean {
  const wanted = toBaseUnits(amount, decimals)
  const held = toBaseUnits(balance, decimals)
  if (wanted == null || held == null) return false
  return wanted > 0n && wanted > held
}

// Phases where the shown balance isn't actionable (unknown or the button has its own
// prerequisite label), so "Insufficient Balance" must not pre-empt them.
const BALANCE_BLIND_PHASES = ["disconnected", "wrong-network", "missing-gas", "missing-payment-token"]

function primaryActionLabel(
  phase: UiPhase,
  allowanceRequired: boolean,
  operationLabel: string,
  insufficientBalance = false,
) {
  if (phase === "disconnected") return "Connect Wallet"
  if (phase === "wrong-network") return "Switch GIWA"
  if (phase === "missing-gas") return "Get GIWA ETH"
  if (phase === "missing-payment-token") return "Payment token missing"
  // Can't act without the balance. Outranks the operation label AND the redeem
  // request-redemption fallback (both arrive via operationLabel), and also Approve — the button
  // is disabled here, so its label has to say why rather than offer a pointless approval.
  if (insufficientBalance) return "Insufficient Balance"
  if (allowanceRequired) return "Approve"
  return operationLabel
}

export function GiwaInvestPanel({
  product,
  price,
  operation,
  amount,
  paymentBalance,
  productBalance,
  allowanceRequired,
  phase,
  pausedNotice,
  error,
  txHashes,
  successLabel,
  pendingRedemptions,
  instantLiquidityUsd,
  baseUsd,
  savings,
  variant = "sidebar",
  onOperationChange,
  onAmountChange,
  onApprove,
  onSubmit,
  onRequestRedeem,
  onConnect,
  onSwitchNetwork,
}: {
  product: GiwaCatalogItem
  price?: number | null
  operation: "deposit" | "requestDeposit" | "redeemInstant" | "requestRedeem" | "claimRedeem"
  amount: string
  requestId: string
  paymentBalance: string
  productBalance: string
  allowance: string
  allowanceRequired: boolean
  greenlistEnforced: boolean
  activeVault: string | null
  phase: UiPhase
  // Per-vault function pause (catalog pauseState): when set, the primary action is
  // disabled and this reason renders with the panel's standard notice styling.
  pausedNotice?: string | null
  error: string | null
  txHashes: string[]
  successLabel?: string | null
  pendingRedemptions: GiwaRedemption[]
  // Live redemption-vault liquidity in USD (display profile); null => "—".
  instantLiquidityUsd?: number | null
  // USD rate for the payment asset (market.baseUsd); lets us compare the redeem payout
  // (payment-asset units) against instantLiquidityUsd (USD) in the SAME unit. null => "—".
  baseUsd?: number | null
  // Savings-only footer (SavingsDetail). When present, the footer shows APY / Est. Annual Yield /
  // Redemption Timeline instead of Instant liquidity / Transaction Fees. Absent on the product
  // detail (and everywhere else) => footer renders byte-identical.
  savings?: { apyText: string; apyPercent: number | null; acceptAssetIcon: string | null }
  // Container adaptation only (no logic/tab change): "sidebar" (default) keeps the desktop
  // aside styling byte-identical (sticky). "sheet" and "flow" drop the sticky offset so the
  // panel flows with the page — "sheet" inside the mobile bottom sheet, "flow" in a
  // single-column layout (e.g. Savings) where a sticky panel would block scroll to the footer.
  variant?: "sidebar" | "sheet" | "flow"
  onOperationChange: (operation: "deposit" | "requestDeposit" | "redeemInstant" | "requestRedeem" | "claimRedeem") => void
  onAmountChange: (amount: string) => void
  onRequestIdChange: (requestId: string) => void
  onApprove: () => void
  onSubmit: () => void
  // Redeem fallback: submit a redemption REQUEST (requestRedeem) when instant liquidity
  // can't cover the payout — the panel auto-routes here instead of hitting the revert.
  onRequestRedeem: () => void
  onClaim: (requestId: string) => void
  onConnect: () => void
  onSwitchNetwork: () => void
}) {
  const tab = operation === "deposit" || operation === "requestDeposit" ? "invest" : operation === "claimRedeem" ? "pending" : "redeem"
  const cfg = vaultConfigOf(product)
  const busy = ["approving", "simulating", "submitting", "confirming"].includes(phase)
  const paySymbol = tab === "redeem" ? product.symbol : product.paymentAssetSymbol
  const receiveSymbol = tab === "redeem" ? product.paymentAssetSymbol : product.symbol
  const side: "invest" | "redeem" = tab === "redeem" ? "redeem" : "invest"
  const quote = typeof price === "number" ? computeQuote({ payAmount: Number(amount), price, side }) : null
  // "~$" assumes a USD-pegged payment asset (tUSDC). For tBTC/tWETH/tXRP we show the value in the
  // payment-asset symbol instead — a real USD figure would need an FX oracle (out of scope).
  const isUsd = product.paymentAssetSymbol === "tUSDC"
  const topBalance = tab === "redeem" ? productBalance : paymentBalance
  const receiveBalance = tab === "redeem" ? paymentBalance : productBalance
  const canMax = topBalance !== "--" && Number.isFinite(Number(topBalance)) && Number(topBalance) > 0
  const tradeValue = side === "invest" ? Number(amount) : (quote ?? Number.NaN)
  const subValueText = Number.isFinite(tradeValue) && tradeValue > 0
    ? (isUsd ? `~$${tradeValue.toFixed(2)}` : `~${quoteText(tradeValue)} ${product.paymentAssetSymbol}`)
    : (isUsd ? "~$0.00" : `~0 ${product.paymentAssetSymbol}`)

  // Savings footer only: annualized yield = amount × APY, using the top-field amount (payment
  // asset on invest, product shares on redeem — the accept-asset logo is shown either way). "—"
  // when the amount is empty/invalid or the APY is unknown.
  const savingsYield =
    savings && savings.apyPercent != null && Number.isFinite(Number(amount)) && Number(amount) > 0
      ? Number(amount) * (savings.apyPercent / 100)
      : null

  // Redeem fallback decision: compare the requested payout to instant liquidity in the SAME
  // unit. `quote` (redeem side) is the payout in payment-asset units; instantLiquidityUsd is
  // USD, so scale the payout by baseUsd. When it exceeds available liquidity the primary
  // action becomes a redemption REQUEST (requestRedeem) instead of reverting with
  // "ARV: liquidity". Unknown liquidity/price/rate (null) keeps the instant path — no false
  // fallback, and the whole amount goes out as ONE request (no instant/request split).
  const payoutUsd = tab === "redeem" && quote != null && baseUsd != null ? quote * baseUsd : null
  const liquidityShort = payoutUsd != null && instantLiquidityUsd != null && payoutUsd > instantLiquidityUsd
  // Instant liquidity restated in payment-asset units for the notice (baseUsd cancels the USD
  // scaling above); falls back to the USD figure only if baseUsd is unavailable.
  const liquidityInPaymentAsset =
    instantLiquidityUsd != null && baseUsd != null && baseUsd > 0 ? instantLiquidityUsd / baseUsd : instantLiquidityUsd
  const redeemPrimaryLabel = liquidityShort ? "Request redemption" : "Redeem instant"
  // The paying token is the payment asset on invest, the product token (shares) on redeem —
  // exactly the balance shown above the field and behind MAX.
  const payDecimals = side === "redeem" ? PRODUCT_TOKEN_DECIMALS : (product.paymentAsset?.decimals ?? 18)
  const insufficientBalance =
    tab !== "pending" && !BALANCE_BLIND_PHASES.includes(phase) && exceedsBalance(amount, topBalance, payDecimals)
  const actionLabel = primaryActionLabel(
    phase,
    allowanceRequired,
    operation === "deposit"
      ? "Invest"
      : operation === "requestDeposit"
        ? "Request deposit"
        : operation === "redeemInstant"
          ? redeemPrimaryLabel
          : operation === "requestRedeem"
            ? "Request redemption"
            : "Claim redemption",
    insufficientBalance,
  )

  function runPrimary() {
    if (phase === "disconnected") return onConnect()
    if (phase === "wrong-network") return onSwitchNetwork()
    if (phase === "missing-gas") {
      window.open(GIWA_FAUCET_URL, "_blank", "noreferrer")
      return
    }
    // Defensive: the button is already disabled, but never let an over-balance amount reach the
    // vault (it would revert with "ERC20: transfer amount exceeds balance").
    if (insufficientBalance) return
    if (allowanceRequired) return onApprove()
    if (liquidityShort) return onRequestRedeem()
    return onSubmit()
  }

  return (
    <div className={`${variant === "sidebar" ? "sticky top-[104px]" : ""} ${INVEST_PANEL_CARD}`}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2.5 py-1 text-xs text-[var(--color-arco-text-soft)]"
        >
          <GiwaNetworkIcon size={14} />
          GIWA Sepolia
          <ChevronDown className="size-3 text-[var(--color-arco-muted)]" />
        </button>
      </div>

      <div className={`mt-3 grid grid-cols-3 ${INVEST_TAB_TRACK}`}>
        {(["invest", "redeem", "pending"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onOperationChange(item === "invest" ? "deposit" : item === "redeem" ? "redeemInstant" : "claimRedeem")}
            className={`${INVEST_TAB} capitalize ${tab === item ? INVEST_TAB_ACTIVE : INVEST_TAB_INACTIVE}`}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "pending" ? (
          <PendingRedemptionList rows={pendingRedemptions} product={product} price={price} />
        ) : (
          <>
            <AmountBlock>
              <AmountField
                caption={tab === "redeem" ? "Amount to redeem" : "You pay"}
                symbol={paySymbol}
                icon={
                  tab === "redeem"
                    ? <GiwaBrandMark src={vaultImageFor(product)} label={product.symbol} size={18} />
                    : <GiwaBrandMark src={paymentAssetIcon(product.paymentAssetSymbol)} label={product.paymentAssetSymbol} size={18} />
                }
                value={amount}
                onChange={onAmountChange}
                balance={topBalance}
                onMax={canMax ? () => onAmountChange(topBalance) : undefined}
                subValue={subValueText}
              />
              <AmountField
                caption="You receive"
                symbol={receiveSymbol}
                icon={
                  tab === "redeem"
                    ? <GiwaBrandMark src={paymentAssetIcon(product.paymentAssetSymbol)} label={product.paymentAssetSymbol} size={18} />
                    : <GiwaBrandMark src={vaultImageFor(product)} label={product.symbol} size={18} />
                }
                value={Number(amount) > 0 ? (quote !== null ? quoteText(quote) : "Onchain quote") : "0"}
                readOnly
                balance={receiveBalance}
                subValue={subValueText}
              />
            </AmountBlock>
            <div className="mt-3">
              {savings ? (
                <>
                  {/* Savings footer (SavingsDetail): APY / Est. Annual Yield / Redemption Timeline.
                      Instant liquidity + Transaction Fees are hidden here. */}
                  <InfoRow label="APY" value={savings.apyText} />
                  <InfoRow
                    label="Est. Annual Yield"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        {savingsYield != null ? compactNumber(savingsYield) : "—"}
                        {savings.acceptAssetIcon && (
                          <GiwaBrandMark src={savings.acceptAssetIcon} label="" size={16} />
                        )}
                      </span>
                    }
                  />
                  <InfoRow
                    label="Redemption Timeline"
                    value={cfg.redemptionTimelineDays != null ? `${cfg.redemptionTimelineDays} Days` : "30-90 Business Days"}
                  />
                </>
              ) : (
                <>
                  {tab === "invest" && (
                    <InfoRow
                      label="Instant liquidity"
                      value={instantLiquidityUsd != null ? aumLabel(instantLiquidityUsd) : "—"}
                    />
                  )}
                  {/* Redeem tab: same redemption-vault liquidity, shown in the payment asset to match
                      the request-fallback notice ("Instant liquidity is <X> tUSDC"). */}
                  {tab === "redeem" && (
                    <InfoRow
                      label="Instant liquidity"
                      value={
                        liquidityInPaymentAsset != null
                          ? `${compactNumber(liquidityInPaymentAsset)} ${product.paymentAssetSymbol}`
                          : "—"
                      }
                    />
                  )}
                  <InfoRow
                    label="Redemption Timeline"
                    value={cfg.redemptionTimelineDays != null ? `${cfg.redemptionTimelineDays} Days` : "30-90 Business Days"}
                  />
                  {/* Copy: "Transaction Fees" (approved rename from "Fee Structure"). */}
                  <InfoRow label="Transaction Fees" expandable>
                    <GiwaFeeBreakdown
                      mintingBps={cfg.feeInstantMintingBps}
                      redemptionBps={cfg.feeInstantRedemptionBps}
                    />
                  </InfoRow>
                </>
              )}
            </div>
            {liquidityShort && !pausedNotice && !insufficientBalance && (
              <div className={`${INVEST_NOTICE} text-[var(--color-arco-text-soft)]`}>
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">
                  {`Instant liquidity is ${compactNumber(liquidityInPaymentAsset ?? 0)} ${product.paymentAssetSymbol}. This is processed as a redemption request — your ${product.symbol} is redeemed now and the ${product.paymentAssetSymbol} payout follows after processing.`}
                </span>
              </div>
            )}
            <button
              type="button"
              disabled={busy || phase === "missing-payment-token" || Boolean(pausedNotice) || insufficientBalance}
              onClick={runPrimary}
              className={`${INVEST_CTA} ${busy ? INVEST_CTA_BUSY : INVEST_CTA_READY}`}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Processing the transaction" : actionLabel}
            </button>
          </>
        )}
      </div>

      {pausedNotice && (
        <div className={`${INVEST_NOTICE} text-[var(--color-arco-text-soft)]`}>
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{pausedNotice}</span>
        </div>
      )}
      {(error || phase === "failed") && (
        <div className={`${INVEST_NOTICE} text-[var(--color-arco-down)]`}>
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="break-words">{error ?? "Transaction failed"}</span>
        </div>
      )}
      {(phase === "success" || phase === "pending-redemption") && (
        <div className={INVEST_NOTICE}>
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-arco-up)]" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-[var(--color-arco-ink)]">{successLabel ?? "Transaction confirmed"}</span>
            {txHashes[0] && (
              <a href={explorerTx(txHashes[0])} target="_blank" rel="noreferrer" className="font-mono text-[var(--color-arco-up)] underline">
                View on GIWA explorer
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Redemption payouts are executed by the admin via a DIRECT transfer — there is no user Claim
// step, so the Pending tab is a read-only status list (legacy PendingList card layout).
function toBigIntSafe(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? "0")
  } catch {
    return 0n
  }
}

function redemptionDate(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// REQUESTED → Pending; FULFILLED/CLAIMED (legacy claim model) and SETTLED/COMPLETED (Part B
// direct-transfer model) → Completed; unknown statuses render raw.
function redemptionBadge(status: string): { label: string; tone: string } {
  const normalized = status.toUpperCase()
  // SETTLING = admin payout in flight; to the investor that is still "Pending".
  if (normalized === "REQUESTED" || normalized === "SETTLING") {
    return { label: "Pending", tone: "text-[var(--color-arco-text-soft)]" }
  }
  if (["FULFILLED", "CLAIMED", "SETTLED", "COMPLETED"].includes(normalized)) {
    return { label: "Completed", tone: "text-[var(--color-arco-up)]" }
  }
  if (normalized === "FAILED") return { label: "Failed", tone: "text-[var(--color-arco-down)]" }
  return { label: status, tone: "text-[var(--color-arco-text-soft)]" }
}

function PendingRedemptionList({
  rows,
  product,
  price,
}: {
  rows: GiwaRedemption[]
  product: GiwaCatalogItem
  price?: number | null
}) {
  if (!rows.length) {
    return <p className="py-8 text-center text-sm text-[var(--color-arco-muted)]">No pending redemptions.</p>
  }

  const paymentDecimals = product.paymentAsset?.decimals ?? 18
  const baseSymbol = baseAssetSymbol(product.paymentAssetSymbol)
  const isUsd = baseSymbol === "USDC"
  const pendingTimelineDays = vaultConfigOf(product).redemptionTimelineDays

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const badge = redemptionBadge(row.status)
        const completed = badge.label === "Completed"
        const sharesRaw = toBigIntSafe(row.sharesIn)
        const shares = Number(formatUnits(sharesRaw, 18))
        const lockedRaw = toBigIntSafe(row.lockedAssetsOut)
        // Payout preview: the locked amount recorded at request time; else shares × NAV/share.
        // Always convert to HUMAN units before multiplying — never math on the raw base units.
        const expected =
          lockedRaw > 0n
            ? Number(formatUnits(lockedRaw, paymentDecimals))
            : typeof price === "number"
              ? shares * price
              : null
        const expectedText =
          expected === null ? "—" : isUsd ? moneyLabel(expected) : `${quoteText(expected)} ${baseSymbol}`
        // Part B (direct transfer) writes settledAt; fulfilledAt is the legacy-claim fallback only.
        // The pending estimate is config-first (same override as the Redemption Timeline row).
        const settlementText = completed
          ? redemptionDate(row.settledAt ?? row.fulfilledAt)
          : pendingTimelineDays != null
            ? `${pendingTimelineDays} Days`
            : "30-90 Business Days"

        return (
          <li key={row.requestId} className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface-muted)] p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[var(--color-arco-ink)]">ARCO-{row.requestId}</span>
              <span className={`rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 ${badge.tone}`}>
                {badge.label}
              </span>
            </div>
            <dl className="mt-2 space-y-1">
              <KeyValue label="Redeem amount" value={`${quoteText(shares)} ${product.symbol}`} />
              <KeyValue label={`Expected ${baseSymbol}`} value={expectedText} />
              <KeyValue label="Requested At" value={redemptionDate(row.createdAt)} />
              <KeyValue label="Est. Settlement" value={settlementText} />
            </dl>
          </li>
        )
      })}
    </ul>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-[var(--color-arco-muted)]">{label}</dt>
      <dd className="tabular-nums text-[var(--color-arco-text-soft)]">{value}</dd>
    </div>
  )
}

export function WalletSummary() {
  const wallet = useGiwaWallet()
  return (
    <section className="grid gap-3 md:grid-cols-3">
      <InfoTile label="Network" value={networkLabel(wallet.chainId)} />
      <InfoTile label="Native ETH" value={wallet.nativeBalance ? Number(wallet.nativeBalance).toFixed(5) : "--"} />
      <a
        href={GIWA_FAUCET_URL}
        target="_blank"
        rel="noreferrer"
        className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]"
      >
        <span className="text-xs text-[var(--color-arco-muted)]">Official faucet</span>
        <span className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--color-arco-ink)]">
          Open GIWA faucet <ExternalLink className="size-3" />
        </span>
      </a>
    </section>
  )
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
      <p className="text-xs text-[var(--color-arco-muted)]">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-[var(--color-arco-ink)]">{value}</p>
    </div>
  )
}

export function GiwaTokenBalances({
  balances,
}: {
  balances: Array<{ symbol: string; balance: string; decimals: number }>
}) {
  return (
    <section className="grid gap-3 md:grid-cols-4">
      {balances.map((asset) => (
        <div key={asset.symbol} className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-4 shadow-[var(--shadow-control)]">
          <div className="flex items-center gap-2">
            <GiwaBrandMark src={paymentAssetIcon(asset.symbol)} label={asset.symbol} size={22} />
            <p className="text-xs text-[var(--color-arco-muted)]">{asset.symbol}</p>
          </div>
          <p className="mt-2 tabular-nums text-lg font-medium text-[var(--color-arco-ink)]">{asset.balance}</p>
          <p className="mt-1 text-[11px] text-[var(--color-arco-muted)]">{asset.decimals} decimals</p>
        </div>
      ))}
    </section>
  )
}

export function GiwaPortfolioCard({ portfolio }: { portfolio: GiwaPortfolio | undefined }) {
  const positionCount = Array.isArray(portfolio?.positions) ? portfolio.positions.length : 0
  const redemptionCount = portfolio?.redemptions?.length ?? 0
  return (
    <div className="flex items-start justify-between gap-6 rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-6 shadow-[var(--shadow-control)]">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-[var(--color-arco-muted)]">Net Worth</span>
        <span className="tabular-nums text-4xl font-medium tracking-tight text-[var(--color-arco-ink)]">{moneyLabel(null)}</span>
        <span className="text-xs text-[var(--color-arco-muted)]">Indexed from backend portfolio service</span>
      </div>
      <div className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface-muted)] px-5 py-3 shadow-[var(--shadow-control)]">
        <span className="text-xs text-[var(--color-arco-muted)]">Wallet state</span>
        <div className="mt-1 flex items-center gap-4">
          <span className="tabular-nums text-2xl font-medium text-[var(--color-arco-ink)]">{positionCount}</span>
          <span className="rounded-[var(--radius-control)] bg-[var(--color-arco-chip)] px-2 py-1 text-xs text-[var(--color-arco-text-soft)]">
            {redemptionCount} redemptions
          </span>
        </div>
      </div>
    </div>
  )
}

// One holdings-row Price/24hΔ cell: the current NAV/share plus its signed 24h change. `null`
// (vault has no price history) renders "—".
export type HoldingPriceCell = { price: string; deltaText: string; up: boolean } | null

export function GiwaHoldingsTable({
  portfolio,
  products,
  depositUsd,
  apyValues,
  priceCells,
  sortKey,
  sortDir,
  onSort,
}: {
  portfolio: GiwaPortfolio | undefined
  products: GiwaCatalogItem[]
  depositUsd?: (string | null)[]
  apyValues?: (string | null)[]
  priceCells?: HoldingPriceCell[]
  sortKey?: "balance" | "delta" | "deposit" | "apy"
  sortDir?: "asc" | "desc"
  onSort?: (key: "balance" | "delta" | "deposit" | "apy") => void
}) {
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : []
  return (
    <div
      className="overflow-x-auto rounded-[var(--radius-card)] bg-[var(--color-arco-surface-30)] p-5"
      style={{ boxShadow: "var(--shadow-table)" }}
    >
      <div className={`grid min-w-[860px] ${HOLDING_COLS} items-center px-1.5 pb-2`}>
        <span className={HEAD}>Product</span>
        <button
          type="button"
          onClick={() => onSort?.("balance")}
          className={`${HEAD} flex items-center justify-end gap-1 hover:text-[var(--color-arco-ink)]`}
        >
          Balance <SortChevrons active={sortKey === "balance" ? sortDir : undefined} />
        </button>
        <button
          type="button"
          onClick={() => onSort?.("delta")}
          className={`${HEAD} flex items-center justify-end gap-1 hover:text-[var(--color-arco-ink)]`}
        >
          Price/24hΔ <SortChevrons active={sortKey === "delta" ? sortDir : undefined} />
        </button>
        <button
          type="button"
          onClick={() => onSort?.("deposit")}
          className={`${HEAD} flex items-center justify-end gap-1 hover:text-[var(--color-arco-ink)]`}
        >
          Your Deposit <SortChevrons active={sortKey === "deposit" ? sortDir : undefined} />
        </button>
        <button
          type="button"
          onClick={() => onSort?.("apy")}
          className={`${HEAD} flex items-center justify-end gap-1 hover:text-[var(--color-arco-ink)]`}
        >
          APY <SortChevrons active={sortKey === "apy" ? sortDir : undefined} />
        </button>
        <span className={`${HEAD} text-center`}>Network</span>
      </div>
      <div className="flex min-w-[860px] flex-col gap-2.5">
        {positions.length ? (
          positions.map((position, index) => {
            const product = products.find((item) => item.productId === positionProductId(position))
            const symbol = product?.symbol ?? String(positionValue(position, "symbol") ?? "Product")
            // Config-first identity — same resolvers as the products vault list (GiwaCatalogRow).
            const config = product ? vaultConfigOf(product) : undefined
            const priceCell = priceCells?.[index] ?? null
            return (
              <div key={`${symbol}-${index}`} className={`relative grid h-[59px] ${HOLDING_COLS} items-center rounded-[var(--radius-row)] bg-[var(--color-arco-surface)] px-1.5`}>
                <div className="flex items-center gap-2.5 pl-1">
                  <GiwaBrandMark src={product ? vaultImageFor(product) : undefined} label={symbol} size={35} />
                  <div className="flex flex-col">
                    <span className="text-base font-medium leading-5 text-[var(--color-arco-ink)]">{config?.displayName ?? symbol}</span>
                    <span className="mt-1 w-fit rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
                      {product ? (config?.category ? categoryTitle(config.category) : productType(product)) : "Position"}
                    </span>
                  </div>
                </div>
                <div className="px-1.5 text-right text-sm tabular-nums text-[var(--color-arco-ink)]">{tokenLabel(positionValue(position, "balance"), symbol)}</div>
                <div className="px-1.5 text-right text-sm tabular-nums text-[var(--color-arco-ink)]">
                  {priceCell ? (
                    <>
                      {priceCell.price}{" "}
                      <span className={priceCell.up ? "text-[var(--color-arco-delta-up)]" : "text-[var(--color-arco-delta-down)]"}>
                        ({priceCell.deltaText})
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </div>
                <div className="px-1.5 text-right text-sm tabular-nums text-[var(--color-arco-ink)]">{depositUsd?.[index] ?? "—"}</div>
                <div className="px-1.5 text-right text-sm tabular-nums text-[var(--color-arco-ink)]">{apyValues?.[index] ?? "—"}</div>
                <div className="flex justify-center"><GiwaNetworkIcon size={20} /></div>
              </div>
            )
          })
        ) : (
          <div className="rounded-[var(--radius-row)] bg-[var(--color-arco-surface)] px-6 py-10 text-center text-sm text-[var(--color-arco-muted)]">
            No indexed holdings yet.
          </div>
        )}
      </div>
    </div>
  )
}

// Renders the ALREADY-BUILT feed (buildActivityFeed output) — never raw indexed events. Every
// cell is a resolved ActivityRow field: human datetime, config-first vault identity, human type
// label + amount. Non-deposit/redeem events (FaucetDrip, PriceUpdated, …) are filtered upstream.
export function GiwaActivityTable({ rows }: { rows: ActivityRow[] }) {
  const rowClass = `relative grid h-[59px] ${ACTIVITY_COLS} items-center rounded-[var(--radius-row)] bg-[var(--color-arco-surface)] px-1.5`
  return (
    <div
      className="overflow-x-auto rounded-[var(--radius-card)] bg-[var(--color-arco-surface-30)] p-5"
      style={{ boxShadow: "var(--shadow-table)" }}
    >
      <div className={`grid min-w-[850px] ${ACTIVITY_COLS} items-center px-1.5 pb-2`}>
        <span className={HEAD}>Date</span>
        <span className={HEAD}>Product</span>
        <span className={HEAD}>Type</span>
        <span className={`${HEAD} flex items-center gap-1`}>Amount <SortChevrons /></span>
        <span className={`${HEAD} flex items-center gap-1`}>TxID <SortChevrons /></span>
        <span className={`${HEAD} text-center`}>Network</span>
      </div>
      <div className="flex min-w-[850px] flex-col gap-2.5">
        {rows.length ? (
          rows.slice(0, 12).map((row) => {
            const cells = (
              <>
                <div className="font-mono text-sm tabular-nums text-[var(--color-arco-ink)]">{row.date}</div>
                <div className="flex items-center gap-2.5 pl-1">
                  <GiwaBrandMark src={row.product.imageUrl} label={row.product.symbol} size={35} />
                  <div className="flex flex-col">
                    <span className="text-base font-medium leading-5 text-[var(--color-arco-ink)]">{row.product.name}</span>
                    {row.product.category && (
                      <span className="mt-1 w-fit rounded-full bg-[var(--color-arco-chip)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--color-arco-ink)] ring-[0.5px] ring-[var(--color-arco-border)]">
                        {row.product.category}
                      </span>
                    )}
                  </div>
                </div>
                <div className={`text-sm ${row.typeTone}`}>{row.typeLabel}</div>
                <div className="tabular-nums text-sm text-[var(--color-arco-ink)]">{row.amount}</div>
                <div className="font-mono text-sm text-[var(--color-arco-ink)]">{row.txHash ? shortAddr(row.txHash) : "—"}</div>
                <div className="flex justify-center"><GiwaNetworkIcon size={20} /></div>
              </>
            )
            // A row without a tx hash (shouldn't happen for indexed rows) stays unlinked.
            return row.txHash ? (
              <a key={row.key} href={explorerTx(row.txHash)} target="_blank" rel="noreferrer" className={rowClass}>
                {cells}
              </a>
            ) : (
              <div key={row.key} className={rowClass}>
                {cells}
              </div>
            )
          })
        ) : (
          <div className="rounded-[var(--radius-row)] bg-[var(--color-arco-surface)] px-6 py-10 text-center text-sm text-[var(--color-arco-muted)]">
            No indexed activity yet.
          </div>
        )}
      </div>
    </div>
  )
}

export function GiwaRedemptionsPanel({ redemptions }: { redemptions: GiwaRedemption[] }) {
  return (
    <div className="rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">Redemptions</h3>
        <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-xs text-[var(--color-arco-text-soft)]">
          {redemptions.length} indexed
        </span>
      </div>
      <ul className="mt-4 space-y-3">
        {redemptions.length ? (
          redemptions.slice(0, 6).map((redemption) => (
            <li key={redemption.requestId} className="rounded-[var(--radius-card)] bg-[var(--color-arco-surface-muted)] p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[var(--color-arco-ink)]">Request {redemption.requestId}</span>
                <span className="rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2 py-0.5 text-[var(--color-arco-text-soft)]">
                  {redemption.status}
                </span>
              </div>
              <dl className="mt-2 space-y-1">
                <KeyValue label="Shares" value={redemption.sharesIn} />
                <KeyValue label="Locked assets" value={redemption.lockedAssetsOut} />
              </dl>
            </li>
          ))
        ) : (
          <li className="py-8 text-center text-sm text-[var(--color-arco-muted)]">No redemption requests yet.</li>
        )}
      </ul>
    </div>
  )
}

export function ActivityPanel({
  activity,
  redemptions,
  products = [],
}: {
  activity: GiwaActivity[]
  redemptions: GiwaRedemption[]
  products?: GiwaCatalogItem[]
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <GiwaActivityTable rows={buildActivityFeed(activity, redemptions, products)} />
      <GiwaRedemptionsPanel redemptions={redemptions} />
    </section>
  )
}

export function AdminNotice() {
  return (
    <div className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="size-4" />
        Tier 2 only
      </div>
      <p className="mt-1">
        This screen requests unsigned operational transactions only. Upgrade, ProxyAdmin, defaultAdmin, and role-granting
        Tier 1 actions are intentionally absent.
      </p>
    </div>
  )
}
