// Featured Funds at the top of the Funds page (Figma 4:148): one fund at a time on the Savings card's dark backdrop,
// with its aurora in greens and the fund's mark large and faint on the right. The fund's mark, name, type, a sentence
// on it and its rate, AUM and network sit on the left; the whole card opens the fund. Previous / next and the dots
// switch funds.

import { useState } from "react"
import { Link } from "react-router-dom"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { fundMarkSrc } from "./FundMark"
import type { LineupFund } from "./funds-lineup"
import { giwaProductPath } from "./routes"
import { HERO_BACKGROUND, HERO_GRID, HeroAurora } from "./SavingsHeroCard"

const ON_HERO_MUTED = "text-[var(--color-savings-on-hero-muted)]"
const FOCUS_ON_HERO = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-on-dark)]"
// The large mark fades out towards the text.
const MARK_FADE = {
  maskImage: "radial-gradient(closest-side, var(--color-arco-ink), transparent)",
  WebkitMaskImage: "radial-gradient(closest-side, var(--color-arco-ink), transparent)",
}

export function FeaturedFunds({ funds }: { funds: readonly LineupFund[] }) {
  const [index, setIndex] = useState(0)
  const active = funds[index] ?? funds[0]
  if (!active) return null
  const { fund } = active
  const mark = fundMarkSrc(fund.symbol)
  const count = funds.length
  const show = (next: number) => setIndex((next + count) % count)

  return (
    <section aria-labelledby="featured-funds-title" className="w-full space-y-6">
      <h1 id="featured-funds-title" className="text-2xl font-medium leading-8 text-[var(--color-arco-ink)]">
        Featured Funds
      </h1>

      <div
        data-funds-hero
        data-testid="featured-fund"
        role="group"
        aria-roledescription="carousel"
        aria-label="Featured Funds"
        className="relative isolate w-full overflow-hidden rounded-[var(--radius-funds-hero)] border border-[var(--color-savings-on-hero-line)] text-[var(--color-arco-on-dark)]"
        style={HERO_BACKGROUND}
      >
        <HeroAurora />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10" style={HERO_GRID} />
        {mark && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-16 -top-10 -z-10 size-[260px] opacity-25 sm:right-[6%] sm:top-1/2 sm:size-[360px] sm:-translate-y-1/2 sm:opacity-35"
            style={MARK_FADE}
          >
            <img src={mark} alt="" className="size-full rounded-[var(--radius-pill)] object-contain" />
          </div>
        )}

        <p aria-live="polite" className="sr-only">{`${index + 1} of ${count}: ${fund.name}`}</p>
        {/* The card clips its overflow, so the link's focus ring is drawn inside its edge. */}
        <Link
          to={giwaProductPath(fund.id)}
          className="flex min-h-[384px] flex-col gap-4 rounded-[var(--radius-funds-hero)] p-6 pb-16 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[var(--color-arco-on-dark)] sm:p-12"
        >
          <div className="flex flex-col gap-4">
            <span className="inline-flex size-11 shrink-0 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-funds-hero-tile)] p-px">
              <BrandMark src={mark} label={fund.symbol} size={42} />
            </span>
            <div>
              <p className="text-2xl font-medium leading-8">{fund.name}</p>
              <p className={`text-sm leading-5 ${ON_HERO_MUTED}`}>{active.type}</p>
            </div>
          </div>

          <p className="max-w-[592px] flex-1 text-base leading-[22px] opacity-80">{active.blurb}</p>

          <dl className="flex flex-wrap gap-x-14 gap-y-4 pt-4">
            <div className="flex flex-col gap-1">
              <dt className={`text-sm leading-5 ${ON_HERO_MUTED}`}>{fund.metric.label}</dt>
              <dd className="font-mono text-2xl font-medium leading-8 text-[var(--color-funds-hero-rate)]">{fund.metric.value}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className={`text-sm leading-5 ${ON_HERO_MUTED}`}>AUM</dt>
              <dd className="font-mono text-2xl font-medium leading-8">{fund.aum.value}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className={`text-sm leading-5 ${ON_HERO_MUTED}`}>Network</dt>
              <dd className="flex h-8 items-center">
                <span title="GIWA" className="inline-flex size-5 items-center justify-center overflow-hidden rounded-[6.667px] bg-[var(--color-funds-hero-tile)] p-px">
                  <img src="/logos/giwa.png" alt="GIWA" width={18} height={18} className="size-[18px] object-contain" />
                </span>
              </dd>
            </div>
          </dl>
        </Link>

        {count > 1 && (
          <>
            <div className="absolute right-6 top-6 flex items-center gap-2 sm:right-12 sm:top-12">
              <button
                type="button"
                aria-label="Previous featured fund"
                onClick={() => show(index - 1)}
                className={`inline-flex size-[30px] items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-savings-on-hero-line)] backdrop-blur-md hover:bg-[var(--color-savings-on-hero-fill)] ${FOCUS_ON_HERO}`}
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Next featured fund"
                onClick={() => show(index + 1)}
                className={`inline-flex size-[30px] items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-savings-on-hero-line)] backdrop-blur-md hover:bg-[var(--color-savings-on-hero-fill)] ${FOCUS_ON_HERO}`}
              >
                <ChevronRight aria-hidden="true" className="size-4" />
              </button>
            </div>

            <div className="absolute bottom-6 right-6 flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--color-savings-on-hero-line)] px-2 py-1 backdrop-blur-md sm:bottom-12 sm:right-12">
              {funds.map((entry, dot) => (
                <button
                  key={entry.fund.id}
                  type="button"
                  aria-label={`Show ${entry.fund.symbol}`}
                  aria-current={dot === index}
                  onClick={() => setIndex(dot)}
                  className={`flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-pill)] px-1 ${FOCUS_ON_HERO}`}
                >
                  <span
                    className={`h-2 rounded-[var(--radius-pill)] transition-all duration-300 motion-reduce:transition-none ${
                      dot === index ? "w-8 bg-[var(--color-arco-on-dark)]" : "w-2 bg-[var(--color-savings-on-hero-line)]"
                    }`}
                  />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
