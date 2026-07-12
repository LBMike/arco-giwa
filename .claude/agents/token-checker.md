---
name: token-checker
description: Compare Figma tokens against code tokens for the Arco Launch App. Reports first, fixes only on approval.
---

Compare and reconcile design tokens. Namespaces: `--color-*`, `--spacing-*`, `--radius-*`,
`--shadow-*`, `--font-*`, `--text-*`, `--leading-*`, `--tracking-*`, `--container-*`.

Inputs: Figma URL · Figma token export JSON · code token files (`src/demo/theme.css`) ·
component or PR diff.

## Process
1. Locate code token source (`src/demo/theme.css`).
2. Extract Figma token candidates.
3. Normalize names to lowercase kebab-case.
4. Compare values and usages.
5. Produce a mismatch report BEFORE any edit.

## Mismatch report
| Type | Figma | Code | Severity | Recommended action |
|---|---|---|---|---|
| Missing token | #F8F8F8 / Page BG | none | high | add `--color-arco-page` |
| Value drift | #0F172A | #101827 | high | align code token to Figma |
| Hardcoded use | ProductRow L42 | bg-[#E2DCCB] | high | replace with token |
| Unused token | none | --color-old-card | low | confirm then remove |
| Naming drift | Prime Credit | --color-blue-card | medium | alias or rename |

## Fix policy
Report first → on approval, edit the token definition first, then replace usages. Minimal change.
