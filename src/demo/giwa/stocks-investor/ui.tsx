// Shared presentation primitives. GIWA tokens only (src/demo/theme.css); no raw colors.
// Text uses ink or text-soft (≥ 4.5:1 on white). The muted token is kept for placeholders only.

import { createContext, useContext, useEffect, useSyncExternalStore, type MutableRefObject, type ReactNode, type RefObject } from "react"

import type { ChipTone } from "./status"

export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"

export const PANEL = "w-full rounded-[var(--radius-strategy)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 md:p-6"

export const TEXT_SECONDARY = "text-[var(--color-arco-text-soft)]"

export const BUTTON_PRIMARY = `inline-flex min-h-11 items-center justify-center rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] px-4 text-sm font-medium text-[var(--color-arco-on-dark)] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`

export const BUTTON_SECONDARY = `inline-flex min-h-11 items-center justify-center rounded-[var(--radius-card)] border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-4 text-sm font-medium text-[var(--color-arco-ink)] hover:bg-[var(--color-row-hover-weak)] disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`

export type NoticeTone = "info" | "action" | "warning" | "error" | "success"

const TONE: Record<NoticeTone, string> = {
  info: "border-[var(--color-arco-border)] bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-text-soft)]",
  action: "border-[var(--color-arco-ink)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]",
  warning: "border-[var(--color-arco-ink-40)] bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-ink)]",
  error: "border-[var(--color-arco-down)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]",
  success: "border-[var(--color-arco-up)] bg-[var(--color-arco-surface)] text-[var(--color-arco-ink)]",
}

/**
 * A static notice by default. Only messages that appear as the result of the user's own action
 * pass `announce`; static panels are not live regions, so they are not re-announced on every render.
 */
export function Notice({ tone, title, children, announce }: { tone: NoticeTone; title?: string; children?: ReactNode; announce?: "polite" | "assertive" }) {
  const live = announce === undefined ? {} : { role: announce === "assertive" ? "alert" : "status", "aria-live": announce }
  return (
    <div {...live} className={`w-full rounded-[var(--radius-card)] border px-4 py-3 text-sm leading-6 ${TONE[tone]}`}>
      {title ? <p className="font-medium text-[var(--color-arco-ink)]">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : undefined}>{children}</div> : null}
    </div>
  )
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: ChipTone }) {
  const toneClass =
    tone === "strong"
      ? "bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]"
      : tone === "positive"
        ? "border border-[var(--color-arco-up)] text-[var(--color-arco-ink)]"
        : tone === "attention"
          ? "border border-[var(--color-arco-ink-40)] bg-[var(--color-arco-surface-muted)] text-[var(--color-arco-ink)]"
          : "bg-[var(--color-arco-chip)] text-[var(--color-arco-text-soft)]"
  return <span className={`inline-flex items-center rounded-[var(--radius-pill)] px-2.5 py-1 text-xs font-medium ${toneClass}`}>{children}</span>
}

/** A label/value row that stacks on narrow screens and never truncates the value. */
export function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--color-arco-border)] py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="text-sm text-[var(--color-arco-text-soft)]">{label}</dt>
      <dd className={`min-w-0 break-words text-sm text-[var(--color-arco-ink)] sm:text-right ${mono ? "font-mono [overflow-wrap:anywhere]" : "tabular-nums"}`}>{children}</dd>
    </div>
  )
}

export function Heading({ children, level = 2, id, headingRef }: { children: ReactNode; level?: 2 | 3; id?: string; headingRef?: RefObject<HTMLHeadingElement> }) {
  const Tag = level === 2 ? "h2" : "h3"
  return (
    <Tag
      id={id}
      ref={headingRef}
      tabIndex={headingRef ? -1 : undefined}
      className={`${level === 2 ? "text-lg" : "text-base"} font-medium text-[var(--color-arco-ink)] ${headingRef ? `scroll-mt-24 ${FOCUS_RING}` : ""}`}
    >
      {children}
    </Tag>
  )
}

/** Set by the feature root once the user has clicked or pressed a key inside it. */
export const UserInteractionContext = createContext<MutableRefObject<boolean> | null>(null)

/**
 * When the control the user activated has been removed by a view change, focus falls back to
 * <body>. Move it to the new view's heading instead. Nothing happens before the user has interacted
 * with the feature (no focus stealing on page load), and focus that is still somewhere meaningful
 * is never taken away.
 */
export function useRescueFocus(target: RefObject<HTMLElement>, key: unknown): void {
  const interacted = useContext(UserInteractionContext)
  useEffect(() => {
    if (typeof document === "undefined" || !interacted?.current) return
    const active = document.activeElement
    if (active === null || active === document.body) target.current?.focus()
  }, [target, key, interacted])
}

/** The app's lg breakpoint (Tailwind `lg`): the trade panel is inline at or above it, in a bottom sheet below it. */
export const DESKTOP_QUERY = "(min-width: 1024px)"

function desktopQuery(): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" ? null : window.matchMedia(DESKTOP_QUERY)
}

function subscribeDesktop(onChange: () => void): () => void {
  const query = desktopQuery()
  if (query === null) return () => undefined
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** No matchMedia (server render, jsdom): desktop, so exactly the inline trade panel is rendered. */
const readDesktop = () => desktopQuery()?.matches ?? true
const serverDesktop = () => true

/**
 * Whether the viewport is at or above lg. Chooses WHICH single trade panel instance is mounted (inline or in the sheet);
 * layout that only restyles stays in CSS.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, readDesktop, serverDesktop)
}
