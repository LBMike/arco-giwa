import { Hourglass } from "lucide-react"

export function GiwaAdminComingSoon({ title, phase, items }: { title: string; phase: string; items: string[] }) {
  return (
    <section className="w-full rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">{title}</h2>
        <span className="rounded-full bg-[var(--color-arco-chip)] px-3 py-1 text-xs text-[var(--color-arco-text-soft)]">
          Coming soon · {phase}
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm text-[var(--color-arco-muted)]">
            <Hourglass className="mt-0.5 size-3.5 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}
