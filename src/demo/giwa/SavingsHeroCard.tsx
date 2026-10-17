// The dark Savings card at the top of the page. Before a wallet is connected it invites a deposit and shows what the
// account offers; once connected it shows the savings balance (ticking up with the yield), the coins available to
// deposit, and the Deposit / Withdraw buttons. Both states end with who the reserves are held with.

import { useEffect, useState, type ReactNode } from "react"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChartNoAxesColumn, ChevronDown, Eye, Landmark, Link2, Pause, Play, Sprout, Zap } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { SavingsInfoTip } from "./SavingsInfoTip"
import { SAVINGS_POWERED_BY } from "./savings-backing"
import { balanceParts, tokenAmount, usd } from "./savings-format"

const ON_HERO_MUTED = "text-[var(--color-savings-on-hero-muted)]"
const ON_HERO = "text-[var(--color-arco-on-dark)]"
const FOCUS_ON_HERO = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-on-dark)]"
const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const SLIDE_MS = 6_000

const HERO_BACKGROUND = {
  backgroundImage:
    "linear-gradient(135deg, var(--color-arco-hero-deco-1) 0%, var(--color-arco-hero-deco-2) 55%, var(--color-arco-hero) 100%)",
}
const HERO_GRID = {
  backgroundImage:
    "linear-gradient(var(--color-savings-on-hero-fill) 1px, transparent 1px), linear-gradient(90deg, var(--color-savings-on-hero-fill) 1px, transparent 1px)",
  backgroundSize: "28px 28px",
  maskImage: "linear-gradient(to bottom, var(--color-arco-ink), transparent 85%)",
  WebkitMaskImage: "linear-gradient(to bottom, var(--color-arco-ink), transparent 85%)",
}
const HERO_GLOW = { backgroundImage: "radial-gradient(closest-side, var(--color-savings-hero-glow), transparent)" }

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * The balance as it grows at the APY from the moment it was read. Display only: what can be withdrawn is the balance
 * at the latest posted NAV. Still when the APY is unknown or the user prefers reduced motion.
 */
export function useLiveAccrual(value: number | null, apyPercent: number | null): number | null {
  const base = value !== null && Number.isFinite(value) ? value : null
  const [anchor, setAnchor] = useState(() => ({ base, at: Date.now() }))
  const [now, setNow] = useState(() => Date.now())
  if (anchor.base !== base) setAnchor({ base, at: Date.now() })
  const growing = base !== null && base > 0 && apyPercent !== null && apyPercent > 0
  useEffect(() => {
    if (!growing || prefersReducedMotion()) return
    const timer = window.setInterval(() => setNow(Date.now()), 120)
    return () => window.clearInterval(timer)
  }, [growing])
  if (base === null) return null
  if (!growing) return base
  const years = Math.max(0, now - anchor.at) / YEAR_MS
  return base * Math.pow(1 + apyPercent! / 100, years)
}

function HeroFrame({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Your savings"
      className="relative isolate w-full overflow-hidden rounded-[22px] text-[var(--color-arco-on-dark)]"
      style={HERO_BACKGROUND}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10" style={HERO_GRID} />
      <div aria-hidden="true" className="savings-hero-glow pointer-events-none absolute -top-1/2 left-0 -z-10 h-[200%] w-[60%] blur-2xl" style={HERO_GLOW} />
      {children}
    </section>
  )
}

function PoweredBy() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className={`text-[10px] font-medium uppercase tracking-[0.12em] ${ON_HERO_MUTED}`}>Powered by</span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {SAVINGS_POWERED_BY.map((mark) => (
          <li key={mark.id} className="flex items-center gap-1.5">
            <span className="inline-flex size-5 items-center justify-center overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)]">
              <BrandMark src={mark.logo} label={mark.name} size={16} />
            </span>
            <span className={`text-[13px] font-medium ${ON_HERO}`}>{mark.name}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A token mark on a light disc, so dark logos stay visible on the dark card. */
function HeroMark({ src, label, size }: { src: string | undefined; label: string; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)]"
      style={{ width: size, height: size }}
    >
      <BrandMark src={src} label={label} size={Math.round(size * 0.78)} />
    </span>
  )
}

function TokenChip({ symbol, icon }: { symbol: string; icon: string | undefined }) {
  return (
    <span className="flex items-center gap-2">
      <HeroMark src={icon} label={symbol} size={30} />
      <span className="text-lg font-medium">{symbol}</span>
    </span>
  )
}

type Slide = Readonly<{ icon: ReactNode; title: string; body: string }>

function heroSlides(tokenSymbol: string): Slide[] {
  return [
    {
      icon: <Landmark className="size-4" />,
      title: "Institution-grade backing",
      body: "Reserves are held in tokenized funds from Fidelity, UBS and Franklin Templeton.",
    },
    {
      icon: <Zap className="size-4" />,
      title: "Instant withdrawals",
      body: "Withdraw at once from the liquidity reserve. Larger withdrawals are queued as a request.",
    },
    {
      icon: <Sprout className="size-4" />,
      title: "Your balance keeps growing",
      body: `Yield builds up in the price of ${tokenSymbol}, so your balance grows without claiming.`,
    },
    {
      icon: <Eye className="size-4" />,
      title: "See what backs it",
      body: "Backing and exposure are published below, down to each manager's share.",
    },
    {
      icon: <Link2 className="size-4" />,
      title: "Settled onchain on GIWA",
      body: "Deposits and withdrawals are onchain transactions you can check on the GIWA explorer.",
    },
  ]
}

// The slides move on by themselves every few seconds; they hold while pointed at or focused, stop for good with the
// pause button, and never move for users who prefer reduced motion.
function FeatureCarousel({ slides }: { slides: readonly Slide[] }) {
  const [index, setIndex] = useState(0)
  const [held, setHeld] = useState(false)
  const [stopped, setStopped] = useState(() => prefersReducedMotion())
  useEffect(() => {
    if (held || stopped || slides.length < 2) return
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % slides.length), SLIDE_MS)
    return () => window.clearInterval(timer)
  }, [held, stopped, slides.length])
  const slide = slides[index]!
  const step = (delta: number) => setIndex((current) => (current + delta + slides.length) % slides.length)
  return (
    <div
      className="w-full"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <div
        role="group"
        aria-roledescription="slide"
        aria-label={`${index + 1} of ${slides.length}`}
        className="min-h-[116px] rounded-[16px] border border-[var(--color-savings-on-hero-line)] bg-[var(--color-savings-on-hero-fill)] p-4 backdrop-blur-sm"
      >
        <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-[10px] bg-[var(--color-savings-on-hero-fill)] ring-1 ring-[var(--color-savings-on-hero-line)]">
          {slide.icon}
        </span>
        <p className="mt-3 text-sm font-medium">{slide.title}</p>
        <p className={`mt-1 text-[13px] leading-5 ${ON_HERO_MUTED}`}>{slide.body}</p>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span aria-hidden="true" className="flex items-center gap-1">
          {slides.map((item, dot) => (
            <span
              key={item.title}
              className={`h-1 rounded-[var(--radius-pill)] transition-all duration-300 motion-reduce:transition-none ${
                dot === index ? "w-5 bg-[var(--color-arco-on-dark)]" : "w-1 bg-[var(--color-savings-on-hero-line)]"
              }`}
            />
          ))}
        </span>
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label={stopped ? "Play slides" : "Pause slides"}
            aria-pressed={stopped}
            onClick={() => setStopped((current) => !current)}
            className={`inline-flex size-7 items-center justify-center rounded-[var(--radius-pill)] ring-1 ring-[var(--color-savings-on-hero-line)] hover:bg-[var(--color-savings-on-hero-fill)] ${FOCUS_ON_HERO}`}
          >
            {stopped ? <Play aria-hidden="true" className="size-3" /> : <Pause aria-hidden="true" className="size-3" />}
          </button>
          <button
            type="button"
            aria-label="Previous"
            onClick={() => step(-1)}
            className={`inline-flex size-7 items-center justify-center rounded-[var(--radius-pill)] ring-1 ring-[var(--color-savings-on-hero-line)] hover:bg-[var(--color-savings-on-hero-fill)] ${FOCUS_ON_HERO}`}
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => step(1)}
            className={`inline-flex size-7 items-center justify-center rounded-[var(--radius-pill)] ring-1 ring-[var(--color-savings-on-hero-line)] hover:bg-[var(--color-savings-on-hero-fill)] ${FOCUS_ON_HERO}`}
          >
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </div>
    </div>
  )
}

function Chevrons() {
  return (
    <span aria-hidden="true" className={`ml-1 flex flex-col items-center leading-none ${ON_HERO_MUTED}`}>
      {[0, 1, 2].map((row) => (
        <ChevronDown key={row} className="savings-chevron -my-1.5 size-5" style={{ animationDelay: `${row * 0.2}s` }} />
      ))}
    </span>
  )
}

export type SavingsHeroProps = {
  connected: boolean
  /** The coin the headline invites ("USDC", "ETH"). */
  depositLabel: string
  tokenSymbol: string
  tokenIcon: string | undefined
  /** The wallet coin a deposit spends ("USDC", "tWETH"). */
  paySymbol: string
  payIcon: string | undefined
  /** Savings balance in USD (shares × NAV), or null while unknown. */
  balanceUsd: number | null
  shares: number | null
  /** The wallet's balance of the pay coin, and its USD value; null while unknown. */
  available: number | null
  availableUsd: number | null
  apyPercent: number | null
  onDeposit: () => void
  onWithdraw: () => void
}

export function SavingsHeroCard(props: SavingsHeroProps) {
  return props.connected ? <ConnectedHero {...props} /> : <WelcomeHero {...props} />
}

function WelcomeHero({ depositLabel, tokenSymbol, tokenIcon }: SavingsHeroProps) {
  return (
    <HeroFrame>
      <div className="flex min-h-[291px] flex-col gap-6 p-5 sm:p-6">
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between md:gap-8">
          <h2 className="text-[30px] font-medium leading-[36px] sm:text-[36px] sm:leading-[44px]">
            <span className={ON_HERO_MUTED}>Deposit {depositLabel}</span>
            <br />
            <span className={ON_HERO_MUTED}>and start </span>
            <span className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] border-2 border-[var(--color-arco-on-dark)] px-3 align-middle leading-[40px]">
              saving
              <ChartNoAxesColumn aria-hidden="true" className="size-6" strokeWidth={2.5} />
            </span>
          </h2>
          <div className="w-full md:max-w-[300px]">
            <FeatureCarousel slides={heroSlides(tokenSymbol)} />
          </div>
        </div>
        <div className="mt-auto flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col items-start gap-3">
            <Chevrons />
            <TokenChip symbol={tokenSymbol} icon={tokenIcon} />
          </div>
          <PoweredBy />
        </div>
      </div>
    </HeroFrame>
  )
}

function ConnectedHero({
  tokenSymbol,
  tokenIcon,
  paySymbol,
  payIcon,
  balanceUsd,
  shares,
  available,
  availableUsd,
  apyPercent,
  onDeposit,
  onWithdraw,
}: SavingsHeroProps) {
  const live = useLiveAccrual(balanceUsd, apyPercent)
  const parts = live !== null ? balanceParts(live) : null
  const earning = balanceUsd !== null && balanceUsd > 0
  const availableText = availableUsd !== null ? usd(availableUsd) : available !== null ? `${tokenAmount(available)} ${paySymbol}` : "—"
  return (
    <HeroFrame>
      <div className="flex min-h-[200px] flex-col justify-between gap-6 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <p className={`flex items-center gap-1 text-[13px] ${ON_HERO_MUTED}`}>
            Savings Balance
            <SavingsInfoTip
              tone="dark"
              label="About the savings balance"
              text={`Your ${tokenSymbol} valued at its latest price. The last digits show the yield building up at the current APY.`}
            />
          </p>
          {earning && (
            <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-savings-on-hero-fill)] px-2 py-0.5 text-xs text-[var(--color-arco-delta-up)] ring-1 ring-[var(--color-savings-on-hero-line)]">
              <span aria-hidden="true" className="size-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-delta-up)]" />
              Earning
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <p className="flex items-baseline font-medium tabular-nums">
              <span className="sr-only">{balanceUsd !== null ? usd(balanceUsd) : "Balance unavailable"}</span>
              {parts !== null ? (
                <span aria-hidden="true">
                  <span className="text-[40px] leading-[48px] sm:text-[48px] sm:leading-[56px]">{parts.whole}</span>
                  <span className="text-2xl">{parts.cents}</span>
                  <span className={`text-2xl ${ON_HERO_MUTED}`}>{parts.tail}</span>
                </span>
              ) : (
                <span aria-hidden="true" className="text-[40px] leading-[48px] sm:text-[48px] sm:leading-[56px]">
                  —
                </span>
              )}
            </p>
            <p className="mt-1 flex items-center gap-2 text-base tabular-nums">
              <HeroMark src={tokenIcon} label={tokenSymbol} size={20} />
              {shares !== null ? `${tokenAmount(shares)} ${tokenSymbol}` : `— ${tokenSymbol}`}
            </p>
          </div>
          <PoweredBy />
        </div>
      </div>
      <div className="flex flex-col gap-4 border-t border-[var(--color-savings-on-hero-line)] bg-[var(--color-savings-on-hero-fill)] p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
        <div>
          <p className={`flex items-center gap-1 text-[13px] ${ON_HERO_MUTED}`}>
            Available {paySymbol}
            <SavingsInfoTip
              tone="dark"
              side="top"
              label={`About available ${paySymbol}`}
              text={`The ${paySymbol} in your connected wallet that you can deposit.`}
            />
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-xl font-medium tabular-nums">
            {availableText}
            <HeroMark src={payIcon} label={paySymbol} size={20} />
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button
            type="button"
            onClick={onDeposit}
            className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)] px-5 text-sm font-medium text-[var(--color-arco-ink)] hover:bg-[var(--color-arco-chip)] sm:min-w-[128px] ${FOCUS_ON_HERO}`}
          >
            <ArrowDown aria-hidden="true" className="size-4" />
            Deposit
          </button>
          <button
            type="button"
            onClick={onWithdraw}
            className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-pill)] px-5 text-sm font-medium ring-1 ring-[var(--color-savings-on-hero-line)] hover:bg-[var(--color-savings-on-hero-fill)] sm:min-w-[128px] ${FOCUS_ON_HERO}`}
          >
            <ArrowUp aria-hidden="true" className="size-4" />
            Withdraw
          </button>
        </div>
      </div>
    </HeroFrame>
  )
}
