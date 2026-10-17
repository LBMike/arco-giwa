// The Savings sections (Backing, Exposure, Simulation) as one accordion: one section open at a time. Closed sections
// sit together in one card with hairlines between them; the open one lifts into a card of its own. The rows stay one
// flat list (only their edges change), so the button that was pressed keeps focus.

import { useId, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"

export type SavingsSection = Readonly<{
  id: string
  title: string
  icon: ReactNode
  /** One line on the right of the closed row ("Backing assets: $1.2M"), or null. */
  summary: ReactNode | null
  content: ReactNode
}>

export function SavingsAccordion({ sections, initialOpen = null }: { sections: readonly SavingsSection[]; initialOpen?: string | null }) {
  const baseId = useId()
  const [openId, setOpenId] = useState<string | null>(initialOpen)
  const openIndex = sections.findIndex((section) => section.id === openId)
  const last = sections.length - 1

  return (
    <div className="w-full">
      {sections.map((section, index) => {
        const open = index === openIndex
        // Card edges: a card starts at the top, at the open section and right after it; it ends likewise.
        const starts = index === 0 || index === openIndex || index === openIndex + 1
        const ends = index === last || index === openIndex || index === openIndex - 1
        const buttonId = `${baseId}-${section.id}-button`
        const panelId = `${baseId}-${section.id}-panel`
        return (
          <div
            key={section.id}
            data-section={section.id}
            data-open={open ? "true" : "false"}
            className={`w-full border-x border-t border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] ${
              starts ? `rounded-t-[22px] ${index === 0 ? "" : "mt-3"}` : ""
            } ${ends ? "rounded-b-[22px] border-b" : ""}`}
          >
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpenId((current) => (current === section.id ? null : section.id))}
                className={`flex min-h-[60px] w-full items-center gap-3 px-5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] sm:min-h-[68px] sm:px-6 ${
                  starts ? "rounded-t-[22px]" : ""
                } ${ends && !open ? "rounded-b-[22px]" : ""}`}
              >
                <span aria-hidden="true" className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--color-arco-text-soft)]">
                  {section.icon}
                </span>
                <span className={`text-sm font-medium text-[var(--color-arco-ink)] ${open ? "underline decoration-1 underline-offset-4" : ""}`}>
                  {section.title}
                </span>
                <span className="ml-auto flex min-w-0 items-center gap-3">
                  {!open && section.summary !== null && (
                    <span className="hidden truncate text-[13px] text-[var(--color-arco-text-soft)] sm:inline">{section.summary}</span>
                  )}
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 text-[var(--color-arco-text-soft)] transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                  />
                </span>
              </button>
            </h3>
            <div id={panelId} role="region" aria-labelledby={buttonId} hidden={!open} className="px-5 pb-6 sm:px-6">
              {open && section.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}
