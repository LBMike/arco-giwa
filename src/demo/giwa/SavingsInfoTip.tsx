// The small (i) next to a Savings label: a short explanation on hover or keyboard focus. It stays open while the
// pointer is over it, Escape hides it, and the button's hit area is 24px around a 16px mark.

import { useId, useState } from "react"
import { Info } from "lucide-react"

export function SavingsInfoTip({
  label,
  text,
  tone = "light",
  align = "start",
  side = "bottom",
}: {
  /** What the tip explains, for screen readers: "About APY". */
  label: string
  text: string
  /** "dark" on the dark Savings card. */
  tone?: "light" | "dark"
  align?: "start" | "end"
  /** Open above the (i) where the space below is clipped (the bottom of the Savings card). */
  side?: "bottom" | "top"
}) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  return (
    <span className="group/tip relative -m-1 inline-flex" onMouseLeave={() => setDismissed(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        onBlur={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !dismissed) {
            event.stopPropagation()
            setDismissed(true)
          }
        }}
        className={`inline-flex size-6 items-center justify-center rounded-[var(--radius-pill)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 ${
          tone === "dark"
            ? "text-[var(--color-savings-on-hero-muted)] hover:text-[var(--color-arco-on-dark)] focus-visible:outline-[var(--color-arco-on-dark)]"
            : "text-[var(--color-arco-muted)] hover:text-[var(--color-arco-ink)] focus-visible:outline-[var(--color-arco-ink)]"
        }`}
      >
        <Info aria-hidden="true" className="size-3" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={`invisible absolute z-30 w-max max-w-[240px] rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] px-2.5 py-2 text-left text-xs font-normal normal-case leading-[18px] tracking-normal text-[var(--color-arco-on-dark)] opacity-0 transition-[opacity,visibility] duration-150 motion-reduce:transition-none ${
          dismissed ? "" : "group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100"
        } ${side === "top" ? "bottom-full mb-0.5" : "top-full mt-0.5"} ${align === "end" ? "right-0" : "left-0"}`}
      >
        {text}
      </span>
    </span>
  )
}
