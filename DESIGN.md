# Arco — Design Foundations

> Visual foundation for everything Arco ships: marketing, admin console, LP portal, future apps.
>
> This is **not** an IA document. It does not describe screens, components, or product structure — those are planned per-product. This document holds the visual primitives and direction those products must follow.
>
> v0.2 — foundational only.

---

## 0. Brand premise

Arco operates across three kinds of surfaces:

- **Marketing** — the public-facing voice. Persuades, signals credibility.
- **Admin Console** (Issuer OS) — the operator's workshop. Runs tokenized funds.
- **LP Portal** — the investor's statement room. Calm, factual, trustworthy.

These surfaces share a **brand family**, not a visual treatment. Same fonts. Same cream accent. Same scale system. Same number formatting. The base background, density, and motion budget vary by surface — because their jobs vary.

The signal that ties all three together is **cream `#E1E0CC`** — Arco's brand color, used sparingly in every surface as the mark of "this is Arco."

---

## 1. Color

> **Color values vs. color implementation.** This document is the source of truth for *which* colors exist and *what they mean* (the hex values and their semantic roles below). It does **not** mandate *how* a surface wires those colors into code — that is a per-surface implementation choice:
> - **Marketing / Admin / LP base (shadcn surfaces)** — keep the existing shadcn convention: HSL channels on CSS variables (`--background: 47 33% 95%`) consumed as `hsl(var(--token))`. Unchanged.
> - **Launch App (`src/demo/`)** — uses **direct CSS-variable color tokens** (`--color-arco-page: #F8F8F8`) consumed as `bg-[var(--color-arco-page)]`. Raw hex / `hsl()` in component code is disallowed here and enforced by the design-system harness. See the Launch App token reference (`docs/DESIGN.md` in the harness) for the concrete token list.
>
> Both map back to the same hex values defined here. The harness only governs the Launch App surface.

### 1.1 Brand color (shared, all surfaces)

```
--arco-cream         #E1E0CC   Brand signature. Sparing use only.
--arco-cream-soft    #DEDBC8   Tailwind 'primary' token. Headlines on dark surfaces.
--arco-on-cream      #111214   Default text when sitting on cream. Warm near-black.
```

**Cream is reserved.** Use it for:
- Brand marks (logo, watermark)
- Primary CTAs on dark surfaces
- Active state of navigation
- Single-letter brand badges (the "C" for Calamos)
- Ceremony moments (confirmation cards, success states)

**Cream is not for** body text, table fills, large card surfaces, decorative blocks. Overuse drains the color of its meaning.

### 1.2 Semantic colors (shared meaning, surface-tuned tone)

```
success   green   confirmed, live, healthy
warning   amber   pending review, caution
danger    red     failed, blocked, irreversible warning
info      blue    informational, neutral notice
```

Tune the exact hex per surface so it sits well on the surface's base background. Same semantic label across all surfaces (e.g., `LIVE` is always green).

### 1.3 Surface base palettes

These three palettes are deliberately distinct. The differences are the system, not noise.

**Marketing — black base, cream accent**
```
bg              #000000
surface         #212121
text-primary    #E1E0CC
text-body       #9ca3af
text-muted      #6b7280
divider         rgba(255,255,255,0.08)
```

**Admin Console — warm dark, operational**
```
bg              #0E0E10        (slightly warmer than pure black)
surface-1       #16161A
surface-2       #1E1E22
text-primary    #E1E0CC
text-body       #A0A0A8
text-muted      #6B6B72
border          rgba(255,255,255,0.08)
input-bg        #1A1A1F
cta-bg          #E1E0CC        (cream button, black text)
```

**LP Portal — warm off-white, calm**
```
bg              #F5F4ED        (cream family, not white)
surface         #FFFFFF
surface-muted   #FAF8F1
text-primary    #111214
text-body       #4F5159
text-muted      #8A8C94
border          #E8E6DC
cta-bg          #111214        (black button, white text)
cta-accent      #E1E0CC        (cream reserved for brand moments)
```

> **Why LP isn't dark.** Investors expect Schwab/Vanguard conventions. Dark theme reads as crypto-native, which conflicts with the "registered, regulated" trust signal. LP stays in the cream family but inverts to light.

> **Why LP CTAs are black, not cream.** Cream-on-light has poor contrast and breaks the convention investors trust. Cream returns as accent for brand moments only.

---

## 2. Typography

### 2.1 Type families (shared)

- **Sans — `Almarai`** (default). System fallback for body, labels, UI.
- **Display italic — `Instrument Serif`, italic only**. Editorial accent. **Marketing only** by default — Admin and LP do not use serif italic.
- **Mono — system stack** (`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`). Used for any value a person reads precisely: numbers, identifiers, tickers, addresses, filenames, code.

### 2.2 Type direction per surface

- **Marketing** — large display sizes, generous line-height, headlines breathe across viewports. Italic serif appears for editorial weight (e.g., the WhyArco middle segment).
- **Admin** — compact ramp, denser line-height. Headlines no larger than 24px. Mono carries all values. **No italic serif.**
- **LP** — medium ramp, comfortable line-height. Headlines around 20–28px. Mono for all financial values + as-of timestamps. **No italic serif.**

### 2.3 The mono rule (shared across surfaces)

If a number, identifier, or token needs to be **read precisely** — render it in mono.

Examples that must be mono:
- Currency values (`$1.15B`, `$25,000.00`)
- Yields and returns (`9.09%`)
- Share / token amounts (`92,837 CAPIX`)
- Tickers, CUSIPs, fund IDs
- Wallet addresses (`0x5K2L...m7Jz`)
- File names (`capix-sub-docs.pdf`)
- Timestamps in tabular contexts

Examples that should **not** be mono:
- Names ("Calamos Aksia Alt. Credit", "Jin Park")
- Sentence-form copy
- City / jurisdiction labels

> A `92,837 CAPIX` reads the same way in the Admin Shareholders table and the LP Position card — same digit shapes, same alignment — even though the surrounding UI differs.

---

## 3. Style (spacing, radius, shadow, motion)

### 3.1 Spacing

4px grid. Use only these values:

```
0   2   4   6   8   12   16   20   24   32   40   48   64   80   96   128
```

If you reach for `3` or `7` or `14`, the padding is probably wrong.

### 3.2 Radius

Five values, no exceptions.

```
sm    4px    Form fields, small chips, checkboxes
md    8px    Card-in-card, mock UI primitives
lg    12px   Section cards, modals
xl    16px   Hero panels, large surfaces
pill  999px  Pills, badges, large CTAs
```

Do not mix multiple radii inside a single component.

### 3.3 Shadow direction

- **Marketing & Admin (dark surfaces)** — shadow sparingly. Dark surfaces already have depth. Use shadow only on elevated cards and CTAs.
- **LP (light surfaces)** — use shadow more, in the Schwab convention. Cards have a small shadow, modals have a larger shadow, hover lifts subtly.

### 3.4 Motion

Easing standard (used everywhere):
```
ease-out-soft   cubic-bezier(0.22, 1, 0.36, 1)
ease-in-out     cubic-bezier(0.4, 0, 0.2, 1)
```

Duration scale:
```
instant  90ms    Hover color, focus ring
fast     180ms   Press, simple toggle
base     280ms   Tab swap, panel reveal
cinema   600ms   Marketing reveal, step cross-fade
```

Motion budget per surface:
- **Marketing** — liberal. Scroll-driven reveals, headline staggers, hero motion. Animation supports the brand story.
- **Admin** — conservative. Hover, focus, tab switch, dropdown only. **Never** delay an action with a flourish.
- **LP** — minimal. Page transitions only. The portal should feel paper-stable.

> If motion interrupts a user's task, it's noise. If it explains a state change, it's communication.

### 3.5 Iconography

- Use `lucide-react` for utility icons. Sizes 14–20px depending on context.
- Use **inline brand SVG** for network and protocol marks (Ethereum, Solana, etc.). Never load brand icons from a CDN.
- Icon color follows the parent text color unless the icon is a brand mark.
- No emoji in product surfaces (Admin, LP). Marketing avoids emoji as well — use brand glyphs or `lucide` instead.

---

## 4. Direction

This section captures *how it should feel*, not what it should contain.

### 4.1 Marketing

- One headline per viewport. Generous whitespace earns the words.
- Cream against deep black. Headlines never use grays.
- Scroll is a tool — pin sections that reward dwell time, not every section.
- `Instrument Serif italic` is a punctuation, not a body voice. When it appears, the sentence stops to listen.
- Motion delivers meaning, not decoration. Every animation should be defensible in a sentence.
- Voice: declarative, restrained, confident. No marketing clichés.

### 4.2 Admin Console (Issuer OS)

- Information density over hero space. Operators are here to act.
- Every value a person reads precisely is mono.
- CTAs use action verbs ("Add shareholder", "Record subscription", "Tokenize shares"). Never generic ("Continue", "OK").
- Irreversible actions are never one click. Type-to-confirm or dual approval for: deploy, freeze, mint, burn.
- State is visible everywhere. Funds carry `LIVE / DRAFT / PAUSED / WOUND-DOWN` pills wherever they're referenced.
- Voice: direct, precise, action-oriented.

### 4.3 LP Portal

- Read like a statement, not a feed.
- Every financial value has an as-of timestamp.
- Black CTAs (Schwab convention). Cream returns for brand moments only — logo, fund chip, confirmation.
- Conservative density. Row heights ≈ 1.5× the Admin equivalent.
- Print-friendly by default. Statements print cleanly without a "print view."
- Voice: calm, factual, deferential. No "Welcome back!" Say "Your positions, as of June 1, 2026, 4:00 PM HKT."

---

## 5. Do not

These are bright lines. Crossing them breaks the brand family.

### Across all surfaces

- Do not introduce new fonts. Almarai + Instrument Serif + system mono only.
- Do not introduce new brand colors. Cream `#E1E0CC` and its soft variant are the only brand colors.
- Do not load brand assets from CDNs. Everything local — `public/` for raster, inline for SVG.
- Do not register MOCK / per-product tokens in `tailwind.config.js`. Surface-local tokens stay in the surface's component or stylesheet.
- Do not use emoji as UI elements in product surfaces.
- Do not mix multiple radii inside one component.
- Do not use values off the 4px spacing grid.
- Do not write `outline: none` without a replacement focus indicator.

### Marketing

- Do not use cream for body copy. Cream is for headlines, CTAs, and brand marks.
- Do not animate purely for decoration. Every motion should explain or reveal.
- Do not pin sections that aren't worth dwelling on (it traps the user).
- Do not put emoji or stock icons in headlines. Brand SVG or nothing.

### Admin Console

- Do not use bright accent colors as primary backgrounds. The base stays warm dark.
- Do not use serif italic anywhere. It belongs to Marketing only.
- Do not animate save buttons with celebrations. Confirmation is a small text + icon, instantly.
- Do not ship irreversible actions behind a single click.
- Do not show a status pill once per page — show it everywhere the fund is referenced.
- Do not use generic CTA labels ("Submit", "OK"). Always action verbs.
- Do not put marketing tone into help text. ("Awesome!" "Let's go!" — none of this.)

### LP Portal

- Do not invert to dark theme. LP stays light.
- Do not use cream as a primary CTA background. Cream is brand-reserved here.
- Do not use marketing voice. No "Welcome", no exclamation points in default copy.
- Do not show financial values without an as-of timestamp.
- Do not use icons in place of labels for primary actions. Labels first.
- Do not animate page transitions beyond a fade. The portal should feel paper-stable.
- Do not show relative time on financial values ("2 days ago"). Always absolute dates.

---

## 6. Reference

- `PROMPT_section3_mock_ui.md` — concrete mock primitives that anchor the Admin Console visual language
- `CONTENT.md` — voice and copy ground truth for Marketing
- `PROMPT_section6_footer.md` — Marketing brand mark and watermark conventions
- `ISSUER_OS_NOTES.md` — product feedback memo, useful as Admin Console direction input
