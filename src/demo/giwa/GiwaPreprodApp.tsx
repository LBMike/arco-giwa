import { useRef } from "react"
import { Link, Outlet } from "react-router-dom"
import { GiwaHeader, useGiwaIsAdmin } from "./components"
import { Footer } from "../components/Footer"
import { GIWA_FOOTER_LINKS } from "./footer-links"
import { GiwaSidebarNav } from "./GiwaSidebarNav"
import { GIWA_PREPROD_ROUTE } from "./routes"

// Investor shell: persistent 224px sidebar from xl; below xl the top bar's menu opens a drawer with
// the same nav. Admin routes use the same shell (`admin` only hides the test-funds action).
export function GiwaPreprodApp({ admin = false }: { admin?: boolean }) {
  const isAdmin = useGiwaIsAdmin()
  const mainRef = useRef<HTMLElement>(null)
  return (
    <div className="arco-demo min-h-screen bg-[var(--color-arco-page)] text-foreground xl:grid xl:grid-cols-[224px_minmax(0,1fr)]">
      {/* First focusable element. A button (not an #anchor) because a hash router hosts this shell in preview. */}
      <button
        type="button"
        onClick={() => mainRef.current?.focus()}
        className="sr-only rounded-md bg-[var(--color-arco-ink)] text-sm font-medium text-[var(--color-arco-on-dark)] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:px-4 focus:py-2"
      >
        Skip to content
      </button>
      <aside className="hidden border-r border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] xl:block">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto px-3 pb-6">
          <div className="flex min-h-[76px] shrink-0 items-center px-3">
            <Link
              to={GIWA_PREPROD_ROUTE}
              aria-label="Arco home"
              className="flex items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
            >
              <img src="/arco-icon.svg" alt="Arco" className="h-[33px] w-[35px] shrink-0" />
            </Link>
          </div>
          <div className="pt-4">
            <GiwaSidebarNav isAdmin={isAdmin} />
          </div>
        </div>
      </aside>
      <div className="flex min-h-screen min-w-0 flex-col">
        <GiwaHeader admin={admin} />
        <main
          ref={mainRef}
          id="giwa-main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1512px] flex-1 scroll-mt-[77px] px-4 py-8 md:px-8 focus:outline-none"
        >
          <Outlet />
        </main>
        <Footer links={GIWA_FOOTER_LINKS} />
      </div>
    </div>
  )
}
