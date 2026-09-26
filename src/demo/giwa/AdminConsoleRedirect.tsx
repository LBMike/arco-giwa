import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { adminConsoleTarget } from "./admin-console-url"

function replaceLocation(url: string) {
  window.location.replace(url)
}

/**
 * The customer app's /admin, /admin/* and /admin/stocks when the build names the separate admin console
 * (VITE_ADMIN_CONSOLE_URL): the browser leaves for the console, replacing this history entry so Back returns to
 * the page before. The link covers a browser that does not follow the scripted navigation.
 */
export function AdminConsoleRedirect({ consoleUrl, navigate = replaceLocation }: { consoleUrl: string; navigate?: (url: string) => void }) {
  const { pathname } = useLocation()
  const target = adminConsoleTarget(consoleUrl, pathname)
  useEffect(() => {
    if (target) navigate(target)
  }, [target, navigate])
  return (
    <main className="arco-demo flex min-h-screen items-center justify-center bg-[var(--color-arco-page)] p-6 text-center text-sm text-[var(--color-arco-ink)]">
      {target ? (
        <p role="status">
          The admin console has moved to its own address.{" "}
          <a className="font-medium underline" href={target}>
            Open the admin console
          </a>
        </p>
      ) : (
        <p role="alert">The admin console address in this build is not a valid http(s) URL.</p>
      )}
    </main>
  )
}
