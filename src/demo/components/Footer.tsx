// Launch App footer — Arco brand mark + name on the left, social links on the
// right, separated from the page by a top hairline. Layout mirrors the Ethena
// footer reference; styling uses the light Arco tokens (no dark surface).
// Brand glyphs are inline SVG (lucide dropped brand icons) using currentColor so
// the colour follows the surrounding token.

function XIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function LinkedInIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 0 1 2.064-2.065 2.064 2.064 0 0 1 2.063 2.065 2.064 2.064 0 0 1-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  )
}

// Social links — Twitter (X) and LinkedIn only. hrefs are placeholders until the
// real Arco handles are supplied.
const SOCIALS = [
  { label: 'Arco on X', href: '#', Icon: XIcon },
  { label: 'Arco on LinkedIn', href: '#', Icon: LinkedInIcon },
]

// Optional centered text links, passed per surface (GIWA supplies Terms of Use /
// Documentation). Omitted => the footer renders exactly as before, so the legacy
// /app footer is unchanged.
export type FooterLink = { label: string; href: string }

export function Footer({ links }: { links?: readonly FooterLink[] }) {
  /* Reuse the shipped brand icon; no missing wordmark asset request. */
  const brand = (
    <span
      role="img"
      aria-label="Arco"
      className="flex h-6 w-[72px] shrink-0 items-center gap-1 text-[var(--color-arco-ink)]"
    >
      <img src="/arco-icon.svg" alt="" aria-hidden className="size-5" />
      <span aria-hidden className="text-lg font-semibold tracking-tight">Arco</span>
    </span>
  )

  /* social links */
  const socials = (
    <div className="flex items-center gap-1">
      {SOCIALS.map(({ label, href, Icon }) => (
        <a
          key={label}
          href={href}
          aria-label={label}
          className="flex size-9 items-center justify-center rounded-full text-[var(--color-arco-muted)] transition-colors hover:bg-[var(--color-arco-chip)] hover:text-[var(--color-arco-ink)]"
        >
          <Icon className="size-4" />
        </a>
      ))}
    </div>
  )

  return (
    <footer className="w-full border-t border-[var(--color-arco-border)]">
      {links?.length ? (
        // 1fr_auto_1fr keeps the link group centred on the container, not merely
        // between the brand and the socials (whose widths differ).
        <div className="mx-auto grid w-full max-w-[1512px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-6 md:px-8">
          {brand}
          <nav className="flex items-center justify-center gap-6">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-[var(--color-arco-muted)] transition-colors hover:text-[var(--color-arco-ink)]"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex justify-end">{socials}</div>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-[1512px] items-center justify-between px-4 py-6 md:px-8">
          {brand}
          {socials}
        </div>
      )}
    </footer>
  )
}
