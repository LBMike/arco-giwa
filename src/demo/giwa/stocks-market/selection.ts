// /stocks list ↔ detail selection. React state is the source: a click sets it synchronously (so the page renders the detail
// in the same commit) and mirrors it to ?symbol= with a push that keeps the other params. Back/Forward and navigations made
// elsewhere (links, typed URLs) flow back into the state; our own pushes are recognised and never applied twice.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigationType, useSearchParams } from "react-router-dom"
import { symbol as parseSymbol } from "./validate"

/** A focus move the list or detail performs once its target has rendered; `tick` identifies the request. */
export type FocusRequest = { tick: number; target: "heading" | "row" | null; symbol: string | null }
export type StocksSelection = {
  /** The open detail's symbol (valid syntax, not necessarily in the catalog), or null for the list. */
  symbol: string | null
  focus: FocusRequest
  /** "row" moves focus to the detail heading; "investor" (the order panel's View NVDA) leaves focus to that panel. */
  openDetail(symbol: string, source: "row" | "investor"): void
  /** Back to the list; the list then scrolls to and focuses the row that was open. */
  closeDetail(): void
  /** True once per request, so StrictMode's repeated effects or a remounted view never move focus twice. */
  claimFocus(tick: number): boolean
}

/** Same syntax as the market contract; anything else never reaches the client (whose path builder throws on it). */
export function validSymbol(value: string | null): string | null {
  if (value === null) return null
  try { return parseSymbol(value) } catch { return null }
}

const OWN = "giwaStocksSelection"
const own = (state: unknown) => typeof state === "object" && state !== null && (state as Record<string, unknown>)[OWN] === true

export function useStocksSelection(): StocksSelection {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigationType = useNavigationType()
  const fromUrl = validSymbol(params.get("symbol"))
  // A ?symbol deep link on first load is entered like a row: the detail heading takes focus.
  const [state, setState] = useState<{ symbol: string | null; focus: FocusRequest }>(() => ({ symbol: fromUrl, focus: { tick: 0, target: fromUrl ? "heading" : null, symbol: fromUrl } }))
  const current = useRef(state.symbol)
  const claimed = useRef(-1)
  const apply = useCallback((symbol: string | null, target: FocusRequest["target"], focusSymbol: string | null) => {
    current.current = symbol
    setState(previous => ({ symbol, focus: { tick: previous.focus.tick + 1, target, symbol: focusSymbol } }))
  }, [])
  const seen = useRef(location.key)
  useEffect(() => {
    if (seen.current === location.key) return
    seen.current = location.key
    // Our own push was applied inside the click. Back/Forward (POP) and anyone else's navigation are applied here, without
    // moving focus; a URL that already matches the state is a no-op.
    if (navigationType !== "POP" && own(location.state)) return
    if (fromUrl === current.current) return
    apply(fromUrl, null, null)
  }, [location.key, location.state, navigationType, fromUrl, apply])
  const mirror = useCallback((symbol: string | null) => {
    setParams(previous => { const next = new URLSearchParams(previous); if (symbol === null) next.delete("symbol"); else next.set("symbol", symbol); return next }, { preventScrollReset: true, state: { [OWN]: true } })
  }, [setParams])
  const openDetail = useCallback((symbol: string, source: "row" | "investor") => {
    if (current.current === symbol) return
    apply(symbol, source === "row" ? "heading" : null, symbol)
    mirror(symbol)
  }, [apply, mirror])
  const closeDetail = useCallback(() => {
    const previous = current.current
    if (previous === null) return
    apply(null, "row", previous)
    mirror(null)
  }, [apply, mirror])
  const claimFocus = useCallback((tick: number) => { if (claimed.current >= tick) return false; claimed.current = tick; return true }, [])
  return useMemo(() => ({ symbol: state.symbol, focus: state.focus, openDetail, closeDetail, claimFocus }), [state, openDetail, closeDetail, claimFocus])
}
