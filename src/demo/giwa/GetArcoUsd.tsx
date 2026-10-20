// Get ArcoUSD, at the top right of every page: converts a stablecoin to ArcoUSD one for one, or ArcoUSD back to a
// stablecoin, on the Savings transfer screen titled Convert. Shown only where there are converters
// (ArcoUsdConvertContext): the demo wallet's chain; the app has none yet. The screen loads on the first press, so the
// shell every page shares carries only this button.

import { Suspense, lazy, useContext, useState } from "react"
import { ARCOUSD_OPTION } from "./arcousd-convert"
import { ArcoUsdConvertContext } from "./savings-routes"

const ArcoUsdConvertScreen = lazy(() => import("./ArcoUsdConvertScreen"))

const BUTTON =
  "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] px-2 text-sm font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)] hover:bg-[var(--color-arco-chip)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] sm:px-3 lg:h-12 lg:px-4"

export function GetArcoUsdButton() {
  const convert = useContext(ArcoUsdConvertContext)
  const [open, setOpen] = useState(false)
  // The screen, and its reads, start on the first press and then stay: a conversion left running finishes in it.
  const [started, setStarted] = useState(false)
  if (convert === null || convert.converters.length === 0) return null
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setStarted(true)
          setOpen(true)
        }}
        className={BUTTON}
      >
        <img src={ARCOUSD_OPTION.logo} alt="" width={20} height={20} className="size-5 shrink-0 rounded-[var(--radius-pill)]" />
        {/* The logo alone on a phone; the name stays for screen readers. */}
        <span className="sr-only sm:not-sr-only">Get ArcoUSD</span>
      </button>
      {started && (
        <Suspense fallback={null}>
          <ArcoUsdConvertScreen convert={convert} open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
