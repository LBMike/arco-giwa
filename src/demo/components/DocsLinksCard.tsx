import { ExternalLink } from 'lucide-react'
import type { DocLink } from '../data/acapix-detail'

// Docs / Links card: external links (Documentation / Legal Terms / Risks).
export function DocsLinksCard({ docs }: { docs: DocLink[] }) {
  return (
    <div className="rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
      <h3 className="text-sm font-semibold text-[var(--color-arco-ink)]">
        Docs / Links
      </h3>
      <ul className="mt-3">
        {docs.map((d) => (
          <li
            key={d.label}
            className="border-t border-[var(--color-arco-border)] first:border-t-0"
          >
            <a
              href={d.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center justify-between gap-3 py-3 text-sm text-[var(--color-arco-text-soft)] hover:text-[var(--color-arco-ink)]"
            >
              {d.label}
              <ExternalLink className="size-3.5 text-[var(--color-arco-muted)]" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
