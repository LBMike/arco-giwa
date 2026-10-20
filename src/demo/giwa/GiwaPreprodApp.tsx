import { useEffect, useRef, useState } from "react"
import { PanelLeftClose } from "lucide-react"
import { Link, Outlet } from "react-router-dom"
import { GiwaHeader, TestFundsButton, useGiwaIsAdmin } from "./components"
import { GetArcoUsdButton } from "./GetArcoUsd"
import { Footer } from "../components/Footer"
import { GIWA_FOOTER_LINKS } from "./footer-links"
import { GiwaSidebarNav } from "./GiwaSidebarNav"
import { GIWA_PREPROD_ROUTE } from "./routes"

const SIDEBAR_STORAGE_KEY = "giwa-investor-sidebar-collapsed"

function initialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false
  try { return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1" } catch { return false }
}

// Investor shell: the desktop sidebar switches between a full menu and an icon rail from xl.
// Below xl, the top bar's menu keeps its independent drawer. Admin uses the same shell.
export function GiwaPreprodApp({ admin = false }: { admin?: boolean }) {
  const isAdmin = useGiwaIsAdmin()
  const mainRef = useRef<HTMLElement>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed)

  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? "1" : "0") } catch { /* Storage is optional. */ }
  }, [sidebarCollapsed])

  return (
    <div
      data-sidebar-state={sidebarCollapsed ? "collapsed" : "expanded"}
      className={`arco-demo min-h-screen bg-[var(--color-arco-page)] text-foreground xl:grid motion-safe:xl:transition-[grid-template-columns] motion-safe:xl:duration-200 ${sidebarCollapsed ? "xl:grid-cols-[56px_minmax(0,1fr)]" : "xl:grid-cols-[224px_minmax(0,1fr)]"}`}
    >
      {/* First focusable element. A button (not an #anchor) because a hash router hosts this shell in preview. */}
      <button
        type="button"
        onClick={() => mainRef.current?.focus()}
        className="sr-only rounded-md bg-[var(--color-arco-ink)] text-sm font-medium text-[var(--color-arco-on-dark)] focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:px-4 focus:py-2"
      >
        Skip to content
      </button>
      <aside className="hidden border-r border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] xl:block">
        <div className={`sticky top-0 flex h-screen flex-col overflow-x-hidden overflow-y-auto pb-6 ${sidebarCollapsed ? "px-2" : "px-3"}`}>
          <div className={`flex min-h-[76px] shrink-0 items-center ${sidebarCollapsed ? "justify-center" : "justify-between px-3"}`}>
            {sidebarCollapsed ? (
              <button
                type="button"
                aria-label="Expand sidebar"
                aria-expanded="false"
                aria-controls="giwa-desktop-sidebar-nav"
                title="Expand sidebar"
                onClick={() => setSidebarCollapsed(false)}
                className="flex size-10 items-center justify-center rounded-[var(--radius-card)] hover:bg-[var(--color-row-hover-weak)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
              >
                <img src="/arco-icon.svg" alt="" className="h-[28px] w-[30px]" />
              </button>
            ) : (
              <>
                <Link
                  to={GIWA_PREPROD_ROUTE}
                  aria-label="Arco home"
                  className="flex items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
                >
                  <img src="/arco-icon.svg" alt="Arco" className="h-[33px] w-[35px] shrink-0" />
                </Link>
                <button
                  type="button"
                  aria-label="Collapse sidebar"
                  aria-expanded="true"
                  aria-controls="giwa-desktop-sidebar-nav"
                  title="Collapse sidebar"
                  onClick={() => setSidebarCollapsed(true)}
                  className="flex size-8 items-center justify-center rounded-[var(--radius-card)] text-[var(--color-arco-text-soft)] hover:bg-[var(--color-row-hover-weak)] hover:text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
                >
                  <PanelLeftClose aria-hidden="true" className="size-[18px]" />
                </button>
              </>
            )}
          </div>
          <div id="giwa-desktop-sidebar-nav" className={sidebarCollapsed ? "pt-2" : "pt-4"}>
            <GiwaSidebarNav isAdmin={isAdmin} compact={sidebarCollapsed} />
          </div>
          {/* Mint test assets at the sidebar's bottom (the drawer has it under its links); the icon rail leaves it out. */}
          {!admin && !sidebarCollapsed && (
            <div className="mt-auto border-t border-[var(--color-arco-border)] px-3 pt-4">
              <TestFundsButton inMenu />
            </div>
          )}
        </div>
      </aside>
      {/* A page may publish --giwa-dock-space for a fixed bottom bar of its own (the Stocks NVDA dock): the room is kept
          here, after the footer, because the bar covers the bottom of the viewport and padding inside <main> would leave
          the footer under it. Unset on every other page, so the shell is unchanged. */}
      <div className="flex min-h-screen min-w-0 flex-col pb-[var(--giwa-dock-space,0px)]">
        {/* Get ArcoUSD at the top right, where there are converters (the demo wallet's chain). */}
        <GiwaHeader admin={admin} action={admin ? undefined : <GetArcoUsdButton />} />
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
