import { useEffect, useRef, useState } from 'react'

// Sticky in-page section nav for the product-detail page. Sits directly under
// the global header (z-40, 76px) at z-30. Active tab is driven by an
// IntersectionObserver over the four sections; clicks smooth-scroll and lock the
// active state briefly so the observer doesn't flicker mid-scroll.

type Tab = { id: string; label: string }

const TABS: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Performance' },
  { id: 'transparency', label: 'Transparency' },
  { id: 'more-info', label: 'More Info' },
]

export function SectionNav() {
  const [active, setActive] = useState<string>('overview')
  // while a programmatic smooth-scroll is in flight, ignore observer updates
  const lockRef = useRef(false)
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const sections = TABS.map((t) => document.getElementById(t.id)).filter(
      (el): el is HTMLElement => !!el,
    )
    if (!sections.length) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (lockRef.current) return
        // pick the top-most intersecting section
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive(visible[0].target.id)
      },
      { rootMargin: '-140px 0px -55% 0px', threshold: 0 },
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
  }, [])

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault()
    const el = document.getElementById(id)
    if (!el) return
    setActive(id)
    lockRef.current = true
    if (lockTimer.current) clearTimeout(lockTimer.current)
    lockTimer.current = setTimeout(() => {
      lockRef.current = false
    }, 700)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="mt-6 w-full sticky top-[76px] z-30 -mx-8 px-8 bg-[var(--color-arco-page-80)] backdrop-blur border-b border-[var(--color-arco-border)]">
      <nav
        aria-label="Sections"
        className="flex items-center gap-6 overflow-x-auto"
      >
        {TABS.map((t) => {
          const isActive = active === t.id
          return (
            <a
              key={t.id}
              href={`#${t.id}`}
              onClick={(e) => onClick(e, t.id)}
              aria-current={isActive ? 'true' : undefined}
              className={`relative shrink-0 whitespace-nowrap py-3 text-sm ${
                isActive
                  ? 'font-semibold text-[var(--color-arco-ink)]'
                  : 'text-[var(--color-arco-text)]'
              }`}
            >
              {t.label}
              {isActive && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-arco-ink)]" />
              )}
            </a>
          )
        })}
      </nav>
    </div>
  )
}
