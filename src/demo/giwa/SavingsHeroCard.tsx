// The dark Savings card at the top of the page. Before a wallet is connected it leads with the account's APY, invites a
// deposit and shows what the account offers; once connected it shows the savings balance (ticking up with the yield),
// the coins available to deposit, and the Deposit / Withdraw buttons. Both states end with who the reserves are held
// with. Behind both: the aurora and three tilted orbits, each with a glowing dot travelling it (look "E2b").

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Eye, Landmark, Pause, Play, Sprout, Zap } from "lucide-react"
import { BrandMark } from "../components/BrandMark"
import { RollingDigits, useTrend } from "./RollingDigits"
import { SavingsInfoTip } from "./SavingsInfoTip"
import { SAVINGS_POWERED_BY } from "./savings-backing"
import { savingsMarkIsRound } from "./savings-category"
import { balanceParts, tokenAmount, usd } from "./savings-format"

const ON_HERO_MUTED = "text-[var(--color-savings-on-hero-muted)]"
const FOCUS_ON_HERO = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-on-dark)]"
const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const SLIDE_MS = 6_000

export const HERO_BACKGROUND = {
  backgroundImage:
    "linear-gradient(135deg, var(--color-arco-hero-deco-1) 0%, var(--color-arco-hero-deco-2) 55%, var(--color-arco-hero) 100%)",
}
// The Featured Funds card's grid (FeaturedFunds.tsx). The Savings card itself has no grid since look "E2b".
export const HERO_GRID = {
  backgroundImage:
    "linear-gradient(var(--color-savings-on-hero-fill) 1px, transparent 1px), linear-gradient(90deg, var(--color-savings-on-hero-fill) 1px, transparent 1px)",
  backgroundSize: "28px 28px",
  maskImage: "linear-gradient(to bottom, var(--color-arco-ink), transparent 85%)",
  WebkitMaskImage: "linear-gradient(to bottom, var(--color-arco-ink), transparent 85%)",
}
// An aurora behind the card: four soft curtains of light (azure, cyan, indigo and a pale ice ribbon), tall and
// tilted, each drifting and stretching on its own slow loop (theme.css), so where they overlap the light keeps
// changing. Sizes are shares of the card, so it fits any card height. Still under reduced motion.
const AURORA: readonly Readonly<{ name: string; box: CSSProperties; color: string }>[] = [
  { name: "savings-aurora-a", box: { left: "-14%", top: "-35%", width: "46%", height: "170%" }, color: "var(--color-savings-aurora-1)" },
  { name: "savings-aurora-b", box: { left: "62%", top: "-45%", width: "28%", height: "180%" }, color: "var(--color-savings-aurora-2)" },
  { name: "savings-aurora-c", box: { left: "12%", top: "35%", width: "70%", height: "110%" }, color: "var(--color-savings-aurora-3)" },
  { name: "savings-aurora-d", box: { left: "36%", top: "-55%", width: "14%", height: "210%" }, color: "var(--color-savings-aurora-4)" },
]

export function HeroAurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {AURORA.map((curtain) => (
        <div
          key={curtain.name}
          className={`${curtain.name} absolute`}
          style={{ ...curtain.box, backgroundImage: `radial-gradient(closest-side, ${curtain.color}, transparent)` }}
        />
      ))}
    </div>
  )
}

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

/**
 * The card's look: blue (the navy card, Stablecoins), cream (a black card with cream lines and light, Crypto Native) or
 * gold (a light gold card with dark brown text, Gold / ArcoGOLD).
 */
export type SavingsHeroTone = "blue" | "cream" | "gold"

/** The card's look for an account's category. */
export function savingsHeroTone(category: "stablecoins" | "crypto-native" | "gold"): SavingsHeroTone {
  return category === "crypto-native" ? "cream" : category === "gold" ? "gold" : "blue"
}

const HERO_BLACK = { backgroundColor: "var(--color-arco-hero)" }
const HERO_GOLD = {
  backgroundImage: "linear-gradient(135deg, var(--color-savings-gold-1) 0%, var(--color-savings-gold-2) 42%, var(--color-savings-gold-3) 100%)",
}
const HERO_LOOK: Record<SavingsHeroTone, CSSProperties> = { blue: HERO_BACKGROUND, cream: HERO_BLACK, gold: HERO_GOLD }

// Three concentric tilted ellipses in the card's lower right, each with one small glowing dot travelling it at its
// own speed (about 6s, 9s and 13s a lap; CSS offset-path in theme.css). The dots stand still under reduced motion,
// and where offset-path is not supported. Lines and dots take the card's own colours, so each look re-scopes them.
// Lines and dots are two layers so each can be kept off the card's text on its own (theme.css masks them for each
// card state, `layout`): a glowing dot, or a line, behind small text would take its contrast below AA.
export function HeroOrbits({ layout }: { layout: "welcome" | "connected" }) {
  return (
    <div aria-hidden="true" data-hero-orbits={layout} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="savings-orbit-layer savings-orbit-lines">
        <div className="savings-orbits">
          <span className="savings-orbit savings-orbit-1" />
          <span className="savings-orbit savings-orbit-2" />
          <span className="savings-orbit savings-orbit-3" />
        </div>
      </div>
      <div className="savings-orbit-layer savings-orbit-dots">
        <div className="savings-orbits">
          <span className="savings-orbit-dot savings-orbit-dot-a" />
          <span className="savings-orbit-dot savings-orbit-dot-b" />
          <span className="savings-orbit-dot savings-orbit-dot-c" />
        </div>
      </div>
    </div>
  )
}

// The cream and gold looks re-scope the card's colours (theme.css, [data-savings-tone="cream"] / "gold"), so the
// orbits, hairlines, text and light below need no second set of styles.
function HeroFrame({ tone, layout, children }: { tone: SavingsHeroTone; layout: "welcome" | "connected"; children: ReactNode }) {
  return (
    <section
      aria-label="Your savings"
      data-savings-tone={tone}
      className="relative isolate w-full overflow-hidden rounded-[22px] text-[var(--color-arco-on-dark)]"
      style={HERO_LOOK[tone]}
    >
      <HeroAurora />
      <HeroOrbits layout={layout} />
      {children}
    </section>
  )
}

const PARTNER_LOGO_SIZE = 28

/** A partner's own logo file, filling its round badge; its initial while the file is missing. */
function PartnerLogo({ name, logo }: { name: string; logo: string }) {
  const [missing, setMissing] = useState(false)
  if (missing) {
    return (
      <>
        <BrandMark label={name} size={PARTNER_LOGO_SIZE} />
        <span className="sr-only">{name}</span>
      </>
    )
  }
  return <img src={logo} alt={name} onError={() => setMissing(true)} className="size-full object-cover" />
}

// The partners' logos as a stack of round badges, each tucked half under the one before it (the first on top); the
// ring, in the card's own black, cuts each badge out of the one beneath. Pointing at a logo lifts it out of the stack
// on top of the others, moves its neighbours' badges aside and names the partner above it. Only the badges move: each
// logo's pointer area stays where it is, so the logo under the pointer never changes as the others slide.
// `inRow`: on the welcome card, in one row beside the savings token. It never wraps; on the narrowest phones (under
// 360px) the words give way and the logos stay (the list keeps its "Powered by" name for screen readers).
function PoweredBy({ inRow = false }: { inRow?: boolean }) {
  return (
    <div className={inRow ? "flex items-center gap-1.5 md:gap-3" : "flex flex-wrap items-center gap-x-3 gap-y-2"}>
      <span
        className={
          inRow
            ? `whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.06em] max-[359px]:hidden md:tracking-[0.12em] md:max-[879px]:hidden ${ON_HERO_MUTED}`
            : `text-[10px] font-medium uppercase tracking-[0.12em] ${ON_HERO_MUTED}`
        }
      >
        Powered by
      </span>
      <ul aria-label="Powered by" className="flex items-center">
        {SAVINGS_POWERED_BY.map((mark, index) => (
          <li
            key={mark.id}
            className={`group/logo relative z-[var(--stack-z)] shrink-0 hover:z-10${index > 0 ? " -ml-3.5" : ""}`}
            style={{ "--stack-z": SAVINGS_POWERED_BY.length - index } as CSSProperties}
          >
            <span className="flex size-7 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-arco-surface)] ring-2 ring-[var(--color-arco-hero)] transition-transform duration-200 ease-out group-hover/logo:-translate-y-1 group-hover/logo:scale-110 [li:hover~li>&]:translate-x-2 [li:has(~li:hover)>&]:-translate-x-2 motion-reduce:transition-none">
              <PartnerLogo name={mark.name} logo={mark.logo} />
            </span>
            <span
              aria-hidden="true"
              className="pointer-events-none invisible absolute bottom-full left-1/2 mb-3 -translate-x-1/2 translate-y-1 whitespace-nowrap rounded-[var(--radius-pill)] bg-[var(--color-savings-on-hero-fill)] px-2 py-0.5 text-xs font-medium text-[var(--color-arco-on-dark)] opacity-0 ring-1 ring-[var(--color-savings-on-hero-line)] backdrop-blur-sm transition-[opacity,transform,visibility] duration-200 group-hover/logo:visible group-hover/logo:translate-y-0 group-hover/logo:opacity-100 motion-reduce:transition-none"
            >
              {mark.name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A coin's own mark (the savings token's, or the wallet coin's beside what is available), as it is: no disc behind it.
 * A hairline in the card's line colour keeps a dark logo's edge on the dark card. A mark that is not a disc (Tether
 * Gold's gem) gets no hairline and no round crop: a circle around it would draw an empty ring.
 */
function TokenMark({ src, label, size, className = "" }: { src: string | undefined; label: string; size: number; className?: string }) {
  return savingsMarkIsRound(label) ? (
    <BrandMark src={src} label={label} size={size} className={`ring-1 ring-[var(--color-savings-on-hero-line)]${className ? ` ${className}` : ""}`} />
  ) : (
    <BrandMark src={src} label={label} size={size} shape="rounded" className={className} />
  )
}

/**
 * The coins the wallet holds beside what is available: up to four marks, each tucked under the one before it. No
 * cut-out ring around them: the strip they sit on is lighter than the card's own colour, so a ring in that colour
 * would read as a dark edge. Each round mark's own hairline keeps them apart (a gem, XAUT, has none; the round mark
 * on top of it keeps its hairline).
 */
function CoinStack({ coins }: { coins: readonly Readonly<{ icon: string | undefined; symbol: string }>[] }) {
  const shown = coins.slice(0, 4)
  return (
    <span data-coin-stack="" className="inline-flex items-center">
      {shown.map((coin, index) => (
        <span
          key={coin.symbol}
          className={`relative inline-flex${index > 0 ? " -ml-1.5" : ""}`}
          style={{ zIndex: shown.length - index }}
        >
          <TokenMark src={coin.icon} label={coin.symbol} size={20} />
        </span>
      ))}
    </span>
  )
}

// The savings token in the welcome card's bottom row: 40px on wide screens, 30px on a phone so the row stays on one line.
function TokenChip({ symbol, icon }: { symbol: string; icon: string | undefined }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 md:gap-2.5">
      <TokenMark src={icon} label={symbol} size={40} className="max-md:!size-[30px]" />
      <span className="whitespace-nowrap text-base font-medium md:text-lg">{symbol}</span>
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
        className="min-h-[116px] rounded-[16px] border border-[var(--color-savings-on-hero-line)] bg-[var(--color-savings-on-hero-fill)] p-4 backdrop-blur-[8px]"
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

// Three chevrons pointing right at the savings token, lighting up one after the other (still under reduced motion).
function Chevrons() {
  return (
    <span aria-hidden="true" data-hero-chevrons="" className={`-mx-1.5 flex shrink-0 items-center leading-none ${ON_HERO_MUTED}`}>
      {[0, 1, 2].map((step) => (
        <ChevronRight
          key={step}
          className={`savings-chevron size-4 md:size-5${step > 0 ? " -ml-[10px] md:-ml-[11px]" : ""}`}
          strokeWidth={2.25}
          style={{ animationDelay: `${step * 0.2}s` }}
        />
      ))}
    </span>
  )
}

export type SavingsHeroProps = {
  connected: boolean
  /** What the card invites a deposit of, and what the wallet has available: "Stablecoins", "ETH". */
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
  /**
   * The coins the wallet holds that a deposit can use, when there are several to pick from (the stablecoin account):
   * shown overlapping beside what is available, in place of the pay coin's mark.
   */
  availableCoins?: readonly Readonly<{ icon: string | undefined; symbol: string }>[]
  apyPercent: number | null
  onDeposit: () => void
  onWithdraw: () => void
  /** "blue" (default) for Stablecoins, "cream" for Crypto Native, "gold" for Gold. */
  tone?: SavingsHeroTone
  /** Before a wallet is connected: the card opens the wallet modal. Without it the card is not a button. */
  onConnect?: () => void
}

export function SavingsHeroCard(props: SavingsHeroProps) {
  return props.connected ? <ConnectedHero {...props} /> : <WelcomeHero {...props} />
}

// Before a wallet is connected, the whole card connects one (`onConnect`, the same wallet modal as the header's Connect
// Wallet): a button laid over the card, under the slides and the partner logos, which keep working as before. The
// "Connect Wallet →" pill (bottom right; under the headline on a phone) is what the eye reads as the button: it is
// always shown, and while the card is pointed at or the button has keyboard focus it lights up (a halo in the card's
// line colour) and its arrow steps forward. The pointing look is kept to screens that can point (a tap would otherwise
// leave it stuck on).
const PILL_ON_CONNECT = [
  "[@media(hover:hover)]:group-has-[[data-hero-connect]:hover]/hero:bg-[var(--color-savings-hero-cta-hover)]",
  "[@media(hover:hover)]:group-has-[[data-hero-connect]:hover]/hero:shadow-[0_0_0_4px_var(--color-savings-on-hero-line),0_0_28px_var(--color-savings-on-hero-line)]",
  "group-has-[[data-hero-connect]:focus-visible]/hero:bg-[var(--color-savings-hero-cta-hover)]",
  "group-has-[[data-hero-connect]:focus-visible]/hero:shadow-[0_0_0_4px_var(--color-savings-on-hero-line),0_0_28px_var(--color-savings-on-hero-line)]",
].join(" ")
const ARROW_ON_CONNECT =
  "[@media(hover:hover)]:group-has-[[data-hero-connect]:hover]/hero:translate-x-1 group-has-[[data-hero-connect]:focus-visible]/hero:translate-x-1"

/** "4.02%": the APY with at most 2 decimals and no forced trailing zeros; null while unknown. */
export function heroApyText(apyPercent: number | null): string | null {
  if (apyPercent === null || !Number.isFinite(apyPercent)) return null
  return `${apyPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
}

/** The small label over the APY: which account it is ("CRYPTO NATIVE · BTC"), then "APY" when there is one to show. */
export function heroApyLabel(tone: SavingsHeroTone, depositLabel: string, withApy: boolean): string {
  const account = tone === "gold" ? "GOLD SAVINGS" : tone === "cream" ? `CRYPTO NATIVE · ${depositLabel.toUpperCase()}` : "STABLECOIN SAVINGS"
  return withApy ? `${account} · APY` : account
}

// A thin square bracket either side of the APY (drawn, not typed); decorative.
function Bracket({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden="true"
      className={`h-[66px] w-2.5 shrink-0 border-2 border-[var(--color-arco-on-dark)] min-[375px]:h-[76px] md:h-[92px] md:w-3 ${side === "left" ? "border-r-0" : "border-l-0"}`}
    />
  )
}

function WelcomeHero({ depositLabel, tokenSymbol, tokenIcon, apyPercent, tone = "blue", onConnect }: SavingsHeroProps) {
  const connectable = onConnect !== undefined
  const apy = heroApyText(apyPercent)
  return (
    <HeroFrame tone={tone} layout="welcome">
      <div className={connectable ? "group/hero" : undefined}>
        {connectable && (
          // Over the card's text (z-[1]); the slides and the partner logos sit above it (z-10).
          <button
            type="button"
            data-hero-connect=""
            aria-label="Connect wallet to start saving"
            onClick={onConnect}
            className="absolute inset-0 z-[1] cursor-pointer rounded-[22px] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[var(--color-arco-on-dark)]"
          />
        )}
        <div className="flex min-h-[291px] flex-col gap-5 p-5 md:grid md:min-h-[340px] md:grid-cols-[minmax(0,1fr)_300px] md:gap-8 md:p-7 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-5 md:justify-between md:gap-6">
            <div className="flex min-w-0 flex-col gap-1.5">
              <p data-hero-apy-label="" className={`text-[11px] font-semibold uppercase tracking-[0.12em] md:text-xs ${ON_HERO_MUTED}`}>
                {heroApyLabel(tone, depositLabel, apy !== null)}
              </p>
              {apy !== null && (
                <p data-hero-apy="" className="flex items-center gap-2 leading-none md:gap-2.5">
                  <Bracket side="left" />
                  <span className="whitespace-nowrap text-[72px] font-medium leading-none tracking-[-0.04em] tabular-nums min-[375px]:text-[80px] md:text-[96px]">
                    {apy}
                    <span className="sr-only"> APY</span>
                  </span>
                  <Bracket side="right" />
                </p>
              )}
              {/* Unknown APY: no number and no brackets; the headline is the hero, as large as it was before. */}
              <h2
                className={
                  apy !== null
                    ? `mt-1 text-lg font-medium leading-snug md:mt-1.5 md:text-[22px] ${ON_HERO_MUTED}`
                    : "mt-1 text-[30px] font-medium leading-[36px] sm:text-[36px] sm:leading-[44px]"
                }
              >
                Deposit {depositLabel} and start saving
              </h2>
            </div>
            <div data-hero-token-row="" className="flex min-w-0 items-center gap-1 md:gap-2.5">
              <Chevrons />
              <TokenChip symbol={tokenSymbol} icon={tokenIcon} />
              <span aria-hidden="true" className="h-[22px] w-px shrink-0 bg-[var(--color-savings-on-hero-line)] md:mx-1.5 md:h-7" />
              <div className="relative z-10 shrink-0">
                <PoweredBy inRow />
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-5 md:justify-between">
            <div className="relative z-10 w-full">
              <FeatureCarousel slides={heroSlides(tokenSymbol)} />
            </div>
            {connectable && (
              // The button over the card says it for screen readers; this pill is for the eye.
              <span
                aria-hidden="true"
                data-hero-pill=""
                data-hero-connect-hint=""
                className={`order-first inline-flex h-12 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)] bg-[var(--color-savings-hero-cta)] px-5 text-[15px] font-semibold text-[var(--color-savings-hero-cta-ink)] transition-[background-color,box-shadow] duration-200 motion-reduce:transition-none md:order-none md:w-auto md:self-end ${PILL_ON_CONNECT}`}
              >
                Connect Wallet
                <ArrowRight className={`size-4 transition-transform duration-200 motion-reduce:transition-none ${ARROW_ON_CONNECT}`} strokeWidth={2.25} />
              </span>
            )}
          </div>
        </div>
      </div>
    </HeroFrame>
  )
}

function ConnectedHero({
  depositLabel,
  tokenSymbol,
  tokenIcon,
  paySymbol,
  payIcon,
  balanceUsd,
  shares,
  available,
  availableUsd,
  availableCoins,
  apyPercent,
  onDeposit,
  onWithdraw,
  tone = "blue",
}: SavingsHeroProps) {
  const live = useLiveAccrual(balanceUsd, apyPercent)
  const parts = live !== null ? balanceParts(live) : null
  // An empty balance reads "$0.00"; the three ticking digits after the cents show only once there is a balance.
  const ticking = live !== null && live > 0
  // The balance rolls digit by digit: up from below as it grows (the yield, a deposit), down as a withdrawal lands.
  const trend = useTrend(live)
  const earning = balanceUsd !== null && balanceUsd > 0
  const availableText = availableUsd !== null ? usd(availableUsd) : available !== null ? `${tokenAmount(available)} ${paySymbol}` : "—"
  // What the wallet can deposit, named as the card's headline names it: "Stablecoins" for the stablecoin account.
  const availableNoun = depositLabel === "Stablecoins" ? "stablecoins" : depositLabel === "Gold" ? "gold" : depositLabel
  return (
    <HeroFrame tone={tone} layout="connected">
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
            <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-savings-on-hero-fill)] px-2 py-0.5 text-xs text-[var(--color-savings-hero-earning)] ring-1 ring-[var(--color-savings-on-hero-line)]">
              {/* The dot beats like a heart (a double beat, then a rest) with a halo fading out of it (theme.css). */}
              <span aria-hidden="true" className="relative inline-flex size-1.5 shrink-0">
                <span className="savings-heartbeat-halo absolute inset-0 rounded-[var(--radius-pill)] bg-[var(--color-savings-hero-earning)]" />
                <span className="savings-heartbeat-dot relative size-1.5 rounded-[var(--radius-pill)] bg-[var(--color-savings-hero-earning)]" />
              </span>
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
                  <span className="text-[40px] leading-[48px] sm:text-[48px] sm:leading-[56px]">
                    <RollingDigits text={parts.whole} trend={trend} />
                  </span>
                  <span className="text-2xl">
                    <RollingDigits text={parts.cents} trend={trend} />
                  </span>
                  {ticking && (
                    <span className={`text-2xl ${ON_HERO_MUTED}`}>
                      <RollingDigits text={parts.tail} trend={trend} />
                    </span>
                  )}
                </span>
              ) : (
                <span aria-hidden="true" className="text-[40px] leading-[48px] sm:text-[48px] sm:leading-[56px]">
                  —
                </span>
              )}
            </p>
            <p className="mt-1 flex items-center gap-2 text-base tabular-nums">
              <TokenMark src={tokenIcon} label={tokenSymbol} size={24} />
              {shares !== null ? `${tokenAmount(shares)} ${tokenSymbol}` : `— ${tokenSymbol}`}
            </p>
          </div>
          <PoweredBy />
        </div>
      </div>
      {/* Frosted: the orbits blur behind it. */}
      <div className="flex flex-col gap-4 border-t border-[var(--color-savings-on-hero-line)] bg-[var(--color-savings-on-hero-fill)] p-5 backdrop-blur-[8px] sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
        <div>
          <p className={`flex items-center gap-1 text-[13px] ${ON_HERO_MUTED}`}>
            Available {depositLabel}
            <SavingsInfoTip
              tone="dark"
              side="top"
              label={`About available ${availableNoun}`}
              text={`The ${availableNoun} in your connected wallet that you can deposit.`}
            />
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-xl font-medium tabular-nums">
            {availableText}
            {availableCoins !== undefined && availableCoins.length > 1 ? (
              <CoinStack coins={availableCoins} />
            ) : availableCoins !== undefined && availableCoins.length === 1 ? (
              <TokenMark src={availableCoins[0]!.icon} label={availableCoins[0]!.symbol} size={20} />
            ) : (
              <TokenMark src={payIcon} label={paySymbol} size={20} />
            )}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button
            type="button"
            onClick={onDeposit}
            className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-savings-hero-cta)] px-5 text-sm font-medium text-[var(--color-savings-hero-cta-ink)] hover:bg-[var(--color-savings-hero-cta-hover)] sm:min-w-[128px] ${FOCUS_ON_HERO}`}
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
