# arco-giwa

Standalone GIWA product: the Vite/React investor + admin app, the Fastify API, the
on-chain indexer, and the contracts ops package for the vault set **live on GIWA
Sepolia (chain 91342)**.

Extracted from the `Arco product` monorepo @ `2876326` (branch `feat/app-number-font`).
The marketing landing, the legacy `/app` demo, and the waitlist infra were intentionally
left behind. Directory layout was preserved verbatim (`src/demo/giwa/…`) so nothing was
import-rewritten and the design-governance hooks work unchanged.

## Layout

| Path | What it is |
|---|---|
| `src/demo/giwa/` | The app: investor list, savings, portfolio, product detail, `/app/admin/*` |
| `src/demo/{components,data,lib}/`, `src/components/ui/input.tsx`, `src/lib/` | Shared pieces the app imports (traced closure — nothing else) |
| `server/src/` | Fastify API (SIWE auth, market/monitoring/portfolio/register services) + indexer (`server/src/indexer/`) |
| `packages/contracts/` | Hardhat ops package (yarn 4 via corepack). Contracts are **LIVE — do not re-deploy** |
| `deployments/91342/arco-giwa-preprod.json` | The live registry (`GIWA_REGISTRY_PATH` default; cwd-relative) |
| `prisma/` | Postgres schema (`arco_evm` schema) + migrations; `scripts/` — ops scripts |
| `.claude/` | Design-governance hooks (token gate, story check, env protection) + agents |

## Prereqs

Node **>= 22** (`node --test` glob patterns), npm. For contracts work: corepack
(`packageManager: yarn@4.10.3`).

## Setup

```sh
npm install
npm run prisma:generate    # safe without a DB — the script shims a dummy DATABASE_URL
```

Contracts **artifacts** (required by `test:server`, the indexer, and registry generation —
see the Phase 4 requirement below):

```sh
# either copy packages/contracts/artifacts/ from a machine that has them, or:
cd packages/contracts && corepack yarn install && corepack yarn compile
```

## Environment

Copy `.env.example` → `.env` and fill it in. The server env contract lives in
`server/src/config/env.ts` and is validated at boot (explicit CORS origins, no `*`).
**Never commit env files; never put a secret behind `VITE_*`.**
The deployer keystore lives at `packages/contracts/.secrets/giwa-deployer.json`
(gitignored); its password is env-only (`GIWA_KEYSTORE_PASSWORD`) — see
`corepack yarn keystore:import`.

## Run

```sh
npm run dev            # Vite on http://localhost:5173 (strictPort — must match CORS_ALLOWED_ORIGINS)
npm run start:server   # API on :8080
npm run indexer:giwa   # indexer worker (needs INDEXER_RPC_URL + DATABASE_URL + artifacts)
```

Routes (root-based, served at **app.arco.financial**): `/` (investor) · `/savings` ·
`/portfolio` · `/product/:id` · `/admin/{operations,prices,config,featured,monitoring}`.
Legacy `/app/*` and `/app/giwa-preprod/*` deep links redirect to the root paths. Note:
the indexer loads the registry at **startup only** — after registering a vault, backfill
from its deploy block and restart.

## Verify

```sh
npm run typecheck && npm run build
npm run test:frontend && npm run test:server && npm run test:security
npm run design:tokens    # KNOWN DEBT: 7 pre-existing violations inherited from the source repo
npm run design:stories   # soft (warn-only until Storybook lands)
```

## Registry & contracts ops

```sh
npm run registry:generate:giwa | registry:validate:giwa | registry:sync:supabase
npm run evm:probe:giwa | evm:deploy:giwa:dry-run | evm:deploy:giwa   # keystore password via env
npm run evm:verify:giwa -- <address> [constructor args]              # Blockscout verification
```

## Deploy (Render)

`render.yaml` defines `arco-giwa-api` (web: install → prisma:generate → build:server,
boots `node server/dist/index.js`) and `arco-giwa-indexer` (worker: same plus the
contracts-artifacts compile, boots `node scripts/indexer/run-giwa.mjs`); env comes from
the shared `arco-giwa-server` group — note the WORKER validates the same server env as
the API (`validateServerEnv`), so it needs all five required secrets too. The server
never reads `VITE_*` values at runtime; those are Vercel build-time only.

### ⚠ Phase 4 requirement — contracts-artifacts gap

A **fresh clone cannot run `test:server`, the indexer, or registry generation**:
`server/src/evm/abi.ts` reads `packages/contracts/artifacts/**` (gitignored Hardhat build
output) at runtime. Phase 1 ships with a local copy from the source machine. Before CI or
a clean Render build of the **indexer worker**, do ONE of:

1. Commit the six canonical ABI JSONs consumed by `CONTRACT_ARTIFACT_PATHS` (ProductToken,
   TestAssetToken, TestAssetFaucet, ProductPriceFeed, ArcoDepositVault, ArcoRedemptionVault)
   to a checked-in path and point `abi.ts` at it, **or**
2. Add `cd packages/contracts && corepack yarn install && corepack yarn compile` to the
   Render build command for `arco-giwa-indexer`.

Option 2 is implemented in BOTH `.github/workflows/ci.yml` ("Compile contract artifacts")
and `render.yaml` (the `arco-giwa-indexer` buildCommand) — keep the two in sync. The API
service deliberately skips it (no runtime artifact readers).

## Cutover (decided): app.arco.financial subdomain, root-based

The GIWA app serves at **app.arco.financial** with root-based routes; the marketing
landing stays untouched on arco.financial and simply links across. Vite `base` stays
`'/'` — correct for a subdomain root, and it keeps the app's root-absolute `public/`
asset strings (`/logos/…`) working everywhere (a path-proxy under `arco.financial/app`
would have required a `base`/asset-helper migration; the subdomain avoids all of it).
Remaining cutover steps are infra only: DNS CNAME for `app` → Vercel, add the domain to
the Vercel project, set `CORS_ALLOWED_ORIGINS=https://app.arco.financial` on Render, and
set `VITE_ARCO_API_BASE` to the Render API URL on Vercel.

## Follow-ups (inherited from the source repo)

- `/logos/beqty.png` is referenced but **missing** (bEQTY is a live product). Also dead:
  `/logos/acme-iss.png`, `/logos/acme-mgr.png`, `/accept-asset/eth-mark.png`.
- 7 pre-existing design-token violations (`Investor.tsx:111`, `components.tsx` ×6) — fix as
  a dedicated approved task; don't grow the list.
- Commit canonical ABIs (Phase 4 requirement above).
- Trim landing-only residue in `src/index.css` (liquid-glass/hero blocks, the `* { Almarai }`
  rule — all inert under `.arco-demo`).
- Optional: rename `src/demo` → `src/app` (mechanical, after CI is green).
