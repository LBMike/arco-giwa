// About card — renders the verbatim Figma copy as stacked paragraphs.

export function AboutCard({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="rounded-[var(--radius-strategy)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]">
      <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-arco-ink)]">
        About
      </h3>
      <div className="mt-3 space-y-3">
        {paragraphs.map((p, i) => (
          <p
            key={i}
            className="text-sm leading-6 text-[var(--color-arco-text-soft)]"
          >
            {p}
          </p>
        ))}
      </div>
    </div>
  )
}
