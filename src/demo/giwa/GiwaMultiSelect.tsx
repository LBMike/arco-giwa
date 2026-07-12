import { useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Search } from "lucide-react"
import { BrandMark } from "../components/BrandMark"

export type GiwaMultiSelectOption = { value: string; label: string; icon?: string }

// Searchable, multi-select checkbox dropdown (custom — no shadcn/portal, no new deps). The panel
// is absolutely positioned under the trigger and lives inside the arco-demo tree, so tokens resolve
// without the portal re-scoping the shadcn Select needed. Tokens only.
export function GiwaMultiSelect({
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
}: {
  label: string
  options: GiwaMultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const count = selected.length
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter((option) => option.label.toLowerCase().includes(q)) : options

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value])
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-11 min-w-[150px] items-center justify-between gap-2 rounded-[5px] border-0 bg-[var(--color-arco-surface)] px-3 text-sm text-[var(--color-arco-muted)] shadow-[0_0_0_0.5px_var(--color-arco-border)]"
      >
        <span className={count > 0 ? "text-[var(--color-arco-ink)]" : ""}>
          {label}
          {count > 0 ? ` · ${count}` : ""}
        </span>
        <ChevronDown className="size-4 shrink-0" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-[calc(100%+6px)] z-40 w-[240px] rounded-[10px] bg-[var(--color-arco-surface)] p-2 ring-[0.5px] ring-[var(--color-arco-border)]"
          style={{ boxShadow: "var(--shadow-table)" }}
        >
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
                className="h-9 w-full rounded-[5px] border-0 bg-[var(--color-arco-surface)] pl-8 pr-2 text-sm text-[var(--color-arco-ink)] shadow-[0_0_0_0.5px_var(--color-arco-border)] placeholder:text-[var(--color-arco-muted)]"
              />
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-arco-muted)]" />
            </div>
            <button
              type="button"
              onClick={() => onChange([])}
              className="shrink-0 px-1 text-xs text-[var(--color-arco-muted)] hover:text-[var(--color-arco-ink)]"
            >
              Clear
            </button>
          </div>

          <div className="mt-2 max-h-[220px] space-y-0.5 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-[var(--color-arco-muted)]">No matches</p>
            ) : (
              visible.map((option) => {
                const checked = selected.includes(option.value)
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggle(option.value)}
                    className="flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-sm text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)]"
                  >
                    <span
                      className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${
                        checked
                          ? "border-[var(--color-arco-ink)] bg-[var(--color-arco-ink)]"
                          : "border-[var(--color-arco-border)]"
                      }`}
                    >
                      {checked && <Check className="size-3 text-[var(--color-arco-on-dark)]" />}
                    </span>
                    {option.icon !== undefined && <BrandMark src={option.icon} label={option.label} size={18} />}
                    <span className="truncate">{option.label}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
