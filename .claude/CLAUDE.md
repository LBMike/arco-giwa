# Claude Code — Session Process (arco-giwa)

Don't write code first. Analyze, plan, get the plan approved, then implement.

## 7-step process
1. **Understand** — restate the request and the target surface (app page / server route / indexer / contracts op).
2. **Analyze** — what exists already (read root `CLAUDE.md`, `DESIGN.md`, `src/demo/theme.css`, similar components).
3. **Explore** — find tokens, export patterns, comparable components/services.
4. **Plan** — present BEFORE coding: files to create/modify · props & variant scope ·
   tokens used · verify commands · any constraints or questions.
5. **Execute** — only approved files; tokens only; `w-full` roots; Figma text verbatim.
6. **Verify** — `npm run typecheck && npm run build`, the relevant test suite
   (`test:frontend` / `test:server` / `test:security`), then the two design hooks `--all`.
7. **Complete** — summarize outcome; all gates green (token hook baseline: 7 known-debt findings, never more).

## Requires approval before coding
- New component · changing existing props · adding/editing/removing a token ·
  Prisma schema/migration change · registry or deployments changes ·
  `package.json` scripts/deps · editing `.claude/**`.

## Forbidden
| Area | Rule |
|---|---|
| Token | `#hex`, `rgb/hsl/oklch`, `var(--t,#fff)` in `src/demo/**` component code |
| Tailwind | `bg-slate-*`, `text-gray-*`, `bg-white`, `text-black` in governed code |
| Figma | altering original text/casing/line breaks |
| Variant | inventing size/state/type not in Figma |
| Width | `w-[1200px]` / `style={{width:1200}}` on a component root |
| Live chain | re-deploying contracts, or hand-editing `deployments/91342/*` |
| Security | reading/editing `.env*` (except `.env.example`) or `packages/contracts/.secrets/**` |
| Scope | unapproved refactors |
