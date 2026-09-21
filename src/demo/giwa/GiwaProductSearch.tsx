import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Search, X } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { giwaApi } from "./api"
import { GIWA_CHAIN_ID } from "./config"
import { buildSearchProducts, filterSearchProducts, SEARCH_CATEGORIES, type SearchCategory, type SearchProduct } from "./product-search"
import { createMarketClient } from "./stocks-market/client"
import { StocksPageEnvironment, usePageApiBase } from "./stocks-market/environment"
import { useOwnedRead } from "./stocks-market/useOwnedRead"

/** The header owns the width; the popup follows the 448px reference and stays inside narrow viewports. */
export function GiwaProductSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<SearchCategory>("All")
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const location = useLocation()
  const id = useId()
  const close = useCallback((restore = false) => {
    setOpen(false)
    if (restore) (window.matchMedia("(min-width: 640px)").matches ? input.current : trigger.current)?.focus()
  }, [])
  useEffect(() => { setOpen(false); setQuery(""); setCategory("All") }, [location.pathname, location.search])
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) {
        event.preventDefault(); setOpen(true); input.current?.focus()
      }
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  }, [])
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [open, close])
  return <div ref={root} className="relative w-full" onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true) } }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close() }}>
    <button ref={trigger} type="button" aria-label="Search products" aria-expanded={open} aria-controls={`${id}-results`} onClick={() => setOpen(value => !value)} className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] sm:hidden"><Search size={18} /></button>
    <div className={`${open ? "fixed left-3 right-3 top-[68px] block" : "hidden"} sm:relative sm:inset-auto sm:block`}>
      <div className="flex h-9 w-full items-center gap-2 rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-3 focus-within:border-[var(--color-arco-muted)]">
        <button type="button" aria-label="Show product search results" onClick={() => { setOpen(true); input.current?.focus() }} className="shrink-0 text-[var(--color-arco-muted)]"><Search size={16} /></button>
        <input ref={input} aria-label="Search savings, funds, and stocks" aria-expanded={open} aria-controls={`${id}-results`} autoComplete="off" value={query} placeholder="Search savings, funds, stocks…" onClick={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true) }} onKeyDown={event => { if (!open && (event.key === "Enter" || event.key === "ArrowDown")) { event.preventDefault(); setOpen(true) } }} className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-arco-ink)] outline-none placeholder:text-[var(--color-arco-muted)]" />
        {open ? <button type="button" aria-label={query ? "Clear search" : "Close search"} onClick={() => { if (query) { setQuery(""); input.current?.focus() } else close(true) }} className="text-[var(--color-arco-muted)]"><X size={14} /></button> : <kbd className="rounded border border-[var(--color-arco-border)] px-1 text-[11px] text-[var(--color-arco-muted)]">/</kbd>}
      </div>
      {open && <SearchResults id={`${id}-results`} query={query} category={category} onCategory={setCategory} input={input} close={() => close()} />}
    </div>
  </div>
}

function SearchResults({ id, query, category, onCategory, input, close }: {
  id: string; query: string; category: SearchCategory; onCategory: (value: SearchCategory) => void
  input: React.RefObject<HTMLInputElement>; close: () => void
}) {
  const catalog = useQuery({ queryKey: ["giwa", "catalog"], queryFn: giwaApi.catalog })
  const market = useQuery({ queryKey: ["giwa", "market", GIWA_CHAIN_ID], queryFn: () => giwaApi.market(GIWA_CHAIN_ID) })
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const client = useMemo(() => apiBase ? createMarketClient(apiBase, environment.fetch) : null, [apiBase, environment.fetch])
  const loadCatalog = useCallback((signal: AbortSignal) => client ? client.catalog(signal) : Promise.resolve(null), [client])
  const stocks = useOwnedRead(apiBase ?? "disabled", loadCatalog)
  const securities = stocks.phase === "ready" ? stocks.value?.data?.securities : undefined
  const loadQuotes = useCallback((signal: AbortSignal) => client && securities?.length ? client.quotes(securities.map(stock => stock.symbol), signal) : Promise.resolve(null), [client, securities])
  const quotes = useOwnedRead(apiBase ?? "disabled", loadQuotes)
  const products = useMemo(() => buildSearchProducts(catalog.data ?? [], market.data ?? [], securities ?? [], quotes.phase === "ready" ? quotes.value?.data ?? [] : []), [catalog.data, market.data, securities, quotes])
  const results = filterSearchProducts(products, query, category)
  const [active, setActive] = useState(-1)
  const list = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  useEffect(() => { setActive(-1); if (list.current) list.current.scrollTop = 0 }, [query, category])
  useEffect(() => {
    const field = input.current
    function key(event: KeyboardEvent) {
      if (event.isComposing) return
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
        event.preventDefault(); setActive(value => (value + (event.key === "ArrowDown" ? 1 : value < 0 ? 0 : -1) + results.length) % results.length)
      } else if (event.key === "Enter" && results.length) {
        event.preventDefault(); navigate(results[active >= 0 && active < results.length ? active : 0].href); close()
      }
    }
    field?.addEventListener("keydown", key)
    return () => field?.removeEventListener("keydown", key)
  }, [input, results, active, navigate, close])
  useEffect(() => {
    const field = input.current
    field?.setAttribute("role", "combobox"); field?.setAttribute("aria-autocomplete", "list")
    if (active >= 0 && results[active]) {
      field?.setAttribute("aria-activedescendant", `${id}-${active}`)
      document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" })
    } else field?.removeAttribute("aria-activedescendant")
    return () => { field?.removeAttribute("aria-activedescendant"); field?.removeAttribute("role"); field?.removeAttribute("aria-autocomplete") }
  }, [active, results.length, input, id])
  const grouped = category === "All" && !query.trim()
  const loading = catalog.isLoading || stocks.phase === "loading"
  const stockError = stocks.phase === "error" || (stocks.phase === "ready" && !stocks.value?.data)
  const row = (product: SearchProduct, compact = false) => {
    const index = results.indexOf(product)
    return <Link id={`${id}-${index}`} key={product.id} role="option" aria-selected={index === active} to={product.href} onClick={close} onMouseEnter={() => setActive(index)} title={compact ? product.name : undefined} className={`flex items-center rounded-lg px-2 py-1 text-left outline-none ${compact ? "min-h-8 gap-1.5 bg-[var(--color-arco-page)]" : "min-h-11 gap-2.5"} hover:bg-[var(--color-arco-chip)] focus-visible:bg-[var(--color-arco-chip)] ${index === active ? "bg-[var(--color-arco-chip)]" : ""}`}>
      <span aria-hidden="true"><BrandMark src={product.image} label={product.symbol} size={compact ? 18 : 24} /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium leading-5 text-[var(--color-arco-ink)]">{product.symbol}</span>{!compact && <span className="block truncate text-[11px] leading-[17px] text-[var(--color-arco-muted)]">{product.name}</span>}</span>
      <span className="shrink-0 text-right tabular-nums">{(!compact || product.category !== "Stocks") && <span className={`${compact ? "text-[11px] text-[var(--color-arco-muted)]" : "block text-[13px] text-[var(--color-arco-ink)]"}`}>{product.value}</span>}{product.change && <span className={`block text-[11px] ${product.negative ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-up)]"}`}>{product.change}</span>}</span>
    </Link>
  }
  return <section aria-label="Product search" className="absolute left-0 top-11 w-full overflow-hidden rounded-lg border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] shadow-xl">
    <div aria-label="Product categories" className="flex gap-5 border-b border-[var(--color-arco-border)] px-3 pt-2">{SEARCH_CATEGORIES.map(tab => <button key={tab} type="button" aria-pressed={category === tab} onClick={() => onCategory(tab)} className={`border-b-2 pb-2.5 pt-1 text-[13px] font-medium ${category === tab ? "border-[var(--color-arco-ink)] text-[var(--color-arco-ink)]" : "border-transparent text-[var(--color-arco-muted)]"}`}>{tab}</button>)}</div>
    <div ref={list} id={id} role="listbox" aria-label="Listed products" className="max-h-[min(620px,calc(100dvh-204px))] sm:max-h-[min(620px,calc(100dvh-158px))] overflow-y-auto overscroll-contain p-3">
      {grouped ? SEARCH_CATEGORIES.filter(tab => tab !== "All").map(tab => {
        const entries = results.filter(product => product.category === tab)
        return entries.length ? <div key={tab} role="group" aria-label={tab} className="mb-5 last:mb-0"><div className="mb-2 flex items-center gap-2 px-2 text-xs font-medium text-[var(--color-arco-muted)]">{tab}<span className="text-[10px]">{entries.length}</span></div><div className="flex flex-wrap gap-2">{entries.map(product => row(product, true))}</div></div> : null
      }) : <div className="grid gap-0.5">{results.map(product => row(product))}</div>}
      {!results.length && !loading && <div className="px-4 py-8 text-center text-sm text-[var(--color-arco-muted)]">{query.trim() ? `No products found for “${query.trim()}”` : "No products listed."}</div>}
    </div>
    {(loading || catalog.isError || stockError) && <p role="status" className="border-t border-[var(--color-arco-border)] px-4 py-2 text-xs text-[var(--color-arco-muted)]">{loading ? "Loading products…" : [catalog.isError ? "Savings and Funds are temporarily unavailable." : "", stockError ? "Stocks are temporarily unavailable." : ""].filter(Boolean).join(" ")}</p>}
  </section>
}
