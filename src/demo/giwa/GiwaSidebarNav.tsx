import { Link, useLocation } from "react-router-dom"
import { ChartCandlestick, ChartPie, ChevronDown, ChevronRight, House, Layers, PiggyBank, Send, ShieldCheck, type LucideIcon } from "lucide-react"
import { SAVINGS_CATEGORIES, savingsCategoryFromSearch, savingsCategoryPath } from "./savings-category"
import { investorNavSections, isNavItemActive, type InvestorNavItemId } from "./investor-nav"

// Investor shell navigation (desktop sidebar from xl, mobile drawer below). Routes are real links
// with aria-current; Send has no route and renders as a disabled, non-focusable row.
const ICONS: Record<InvestorNavItemId, LucideIcon> = {
  home: House,
  savings: PiggyBank,
  funds: Layers,
  stocks: ChartCandlestick,
  portfolio: ChartPie,
  send: Send,
  admin: ShieldCheck,
}

const ROW = "flex min-h-11 items-center gap-3 rounded-[var(--radius-card)] px-3 text-[15px]"
const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

export function GiwaSidebarNav({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  const { pathname, search } = useLocation()
  const savingsCategory = savingsCategoryFromSearch(new URLSearchParams(search))
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {investorNavSections(isAdmin).map((section) => (
        <div key={section.id} className="space-y-1">
          {section.label && (
            <p aria-hidden="true" className="px-3 text-xs uppercase tracking-wide text-[var(--color-arco-chip-ink)]">
              {section.label}
            </p>
          )}
          <ul aria-label={section.label ?? "Home"} className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = ICONS[item.id]
              if (item.disabled || item.to === null) {
                return (
                  <li key={item.id}>
                    <span aria-disabled="true" className={`${ROW} text-[var(--color-arco-muted)]`}>
                      <Icon aria-hidden="true" size={18} className="shrink-0" />
                      <span>{item.label}</span>
                      {item.note && (
                        <span className="ml-auto rounded-full bg-[var(--color-arco-chip)] px-2 text-[11px] text-[var(--color-arco-chip-ink)]">
                          {item.note}
                        </span>
                      )}
                    </span>
                  </li>
                )
              }
              const active = isNavItemActive(item, pathname)
              return (
                <li key={item.id}>
                  <Link
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={`${ROW} ${FOCUS} ${
                      active
                        ? "bg-[var(--color-arco-chip)] font-medium text-[var(--color-arco-ink)]"
                        : "text-[var(--color-arco-text-soft)] hover:bg-[var(--color-row-hover-weak)] hover:text-[var(--color-arco-ink)]"
                    }`}
                  >
                    <Icon aria-hidden="true" size={18} className="shrink-0" />
                    <span>{item.label}</span>
                    {item.id === "savings" && (active ? <ChevronDown aria-hidden="true" className="ml-auto size-4" /> : <ChevronRight aria-hidden="true" className="ml-auto size-4" />)}
                  </Link>
                  {item.id === "savings" && active && <ul aria-label="Savings categories" className="ml-5 mt-1 space-y-1 border-l border-[var(--color-arco-border)] pl-3">
                    {SAVINGS_CATEGORIES.map(category => <li key={category.id}>
                      <Link to={savingsCategoryPath(category.id)} onClick={onNavigate} aria-current={savingsCategory === category.id ? "location" : undefined}
                        className={`flex min-h-10 items-center rounded-lg px-3 text-sm ${FOCUS} ${savingsCategory === category.id ? "bg-[var(--color-arco-chip)] font-medium text-[var(--color-arco-ink)]" : "text-[var(--color-arco-text-soft)] hover:bg-[var(--color-row-hover-weak)]"}`}>
                        {category.label}
                      </Link>
                    </li>)}
                  </ul>}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
