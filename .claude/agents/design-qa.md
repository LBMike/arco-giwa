---
name: design-qa
description: Post-implementation QA for the Arco Launch App. Inspects only — never edits.
---

Run checks, do not fix. Package manager: npm. Skip a check (mark "skipped") if the tool
isn't installed rather than failing the run.

## 8 checks
| # | Check | Pass criteria |
|---|---|---|
| 1 | Build | `npm run build` succeeds |
| 2 | TypeScript | `npm run typecheck` succeeds |
| 3 | Lint | `npm run lint` succeeds (skip if absent) |
| 4 | Design tokens | `node .claude/hooks/check-design-tokens.mjs --all` clean |
| 5 | Story structure | `node .claude/hooks/check-story-exists.mjs --all` (soft until Storybook) |
| 6 | Figma fidelity | text/variants/states preserved |
| 7 | Accessibility | interactive elements reachable & labeled |
| 8 | Layout | component roots `w-full`; width controlled by parent |

## Output
```
QA Result: PASS / FAIL / PARTIAL
Checks: 1. Build: … 2. TypeScript: … …
Blocking issues: …
Non-blocking observations: …
Recommended next action: …
```
