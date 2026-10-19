# Arco GIWA — Working Constitution

> Standalone repo for the GIWA product, extracted from the Arco monorepo @ `2876326`.
> Surfaces: React app (`src/`), Fastify API + indexer (`server/`), contracts ops
> (`packages/contracts/`), live registry (`deployments/91342/`). Brand foundations
> live in `DESIGN.md`.

## Hard rules

- **Contracts on GIWA Sepolia (chain 91342) are LIVE.** Never re-deploy, never edit
  `deployments/91342/*` by hand — registry changes go through the registry scripts
  (`registry:generate:giwa` → `registry:validate:giwa` → `registry:sync:supabase`).
- **Secrets:** never read/edit `.env*` (except `.env.example`); never touch
  `packages/contracts/.secrets/`. No secret behind `VITE_*`. CORS stays an explicit
  origin list (never `*`). Keystore password is env-only (`GIWA_KEYSTORE_PASSWORD`).

## Stack (actual)

- React 18 + TypeScript + **Tailwind CSS v3.4** + Vite. Package manager: **npm**
  (`package-lock.json`); contracts sub-package uses **yarn 4 via corepack** (`evm:*` wrappers).
- Server: Fastify + Prisma (Postgres, `arco_evm` schema), compiled via `server/tsconfig.json`;
  tests are `node --test` with in-memory fakes (no DB needed).
- Storybook: **not installed** — story files are a *soft* requirement (warn) for now.

## Color tokens (`src/demo/**`)

Component code MUST use CSS-variable tokens:

```tsx
// allowed
<div className="bg-[var(--color-arco-page)] text-[var(--color-arco-ink)]" />
// forbidden
<div className="bg-[#F8F8F8] text-slate-900" />
```

Forbidden in governed code: raw hex, `rgb()/rgba()/hsl()/oklch()`, Tailwind default color
classes (`bg-slate-*`, `text-gray-*`, `bg-white`, `text-black`), raw-color fallbacks in
`var(--token, #fff)`. Token definitions live in `src/demo/theme.css` (raw hex allowed THERE
only). Enforced by `node .claude/hooks/check-design-tokens.mjs` (blocks, exit 2); legitimate
exceptions carry a trailing `// design-tokens:allow`.
**KNOWN DEBT:** 7 pre-existing violations (`Investor.tsx:111`, `components.tsx` ×6)
inherited at extraction — fix only as a dedicated approved task; never grow the list.

## Component structure & Figma fidelity

- Component roots are `w-full`; the page wrapper owns layout width. No invented
  variants/states beyond Figma; Figma text verbatim (product names, casing, line breaks).
- Numbers: financial values show **max 2 decimals, no forced trailing zeros**
  (`6 → 6%`, `28_530_000 → $28.53M`). **Exception:** NAV/share price may show up to
  4 decimals (min 2) — near-par NAV needs sub-cent precision; `par → $1.00`.
  **Exception:** operational gas balances (admin console, e.g. the queue bot wallet's
  ETH) may show up to 4 decimals, no forced trailing zeros — a few cents of gas still matter.

## Routes

Root-based (served at app.arco.financial): `/` (home) · `/funds` (funds list) · `/savings` · `/portfolio` ·
`/product/:id` · `/admin/{operations,prices,config,featured,monitoring,arcousd}` — constants in
`src/demo/giwa/routes.ts`; legacy `/app/*` + `/app/giwa-preprod/*` redirects live in `src/main.tsx`.

## Agent delegation

Figma URL → React → `figma-implementer` · token diff → `token-checker` ·
pre-release checks → `design-qa` · pre-PR review → `design-reviewer`.

## Verify after work

```
npm run typecheck
npm run build
npm run test:frontend && npm run test:server && npm run test:security
node .claude/hooks/check-design-tokens.mjs --all   # baseline: the 7 known-debt findings
node .claude/hooks/check-story-exists.mjs --all    # soft
```
