// Shared numeric sort helpers for the GIWA list tables (products vault list + personal
// portfolio holdings). One consistent rule: null/undefined ALWAYS ranks last, in both
// directions — never floated to the top by a -Infinity sentinel.

export type SortDir = "asc" | "desc"

// Compare two numeric keys; null/undefined always ranks last regardless of direction.
export function compareNullLast(a: number | null | undefined, b: number | null | undefined, dir: SortDir): number {
  const av = a ?? null
  const bv = b ?? null
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  return dir === "desc" ? bv - av : av - bv
}

// Header-click transition: clicking the active column toggles its direction; clicking a new
// column selects it at `defaultDir` (numeric columns start DESC).
export function nextSort<K extends string>(
  current: { key: K; dir: SortDir },
  key: K,
  defaultDir: SortDir = "desc",
): { key: K; dir: SortDir } {
  if (current.key === key) return { key, dir: current.dir === "desc" ? "asc" : "desc" }
  return { key, dir: defaultDir }
}

// Sort a copy of `items` by a numeric key (null-last) with an optional stable string tiebreak.
export function sortByNumericKey<T>(
  items: T[],
  keyFn: (item: T) => number | null | undefined,
  dir: SortDir,
  tiebreak?: (item: T) => string,
): T[] {
  return [...items].sort(
    (a, b) => compareNullLast(keyFn(a), keyFn(b), dir) || (tiebreak ? tiebreak(a).localeCompare(tiebreak(b)) : 0),
  )
}
