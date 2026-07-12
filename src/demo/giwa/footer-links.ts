import type { FooterLink } from "../components/Footer"

// GIWA footer links — single source, reused by the desktop Footer (GiwaPreprodApp) AND the mobile
// header sheet (GiwaHeaderMenu). Leaf module (no giwa-component imports) so neither consumer forms
// an import cycle. hrefs are placeholders — drop the real URLs in here; nothing else changes.
export const GIWA_FOOTER_LINKS: readonly FooterLink[] = [
  { label: "Terms of Use", href: "#" },
  { label: "Documentation", href: "#" },
]
