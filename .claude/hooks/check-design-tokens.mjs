#!/usr/bin/env node
// check-design-tokens.mjs — flags raw colors in Launch App component code.
//
// Scope (project-tuned): ONLY src/demo/** is governed. The landing (src/components,
// except ui), shadcn primitives (src/components/ui/**), and token/theme definition
// files are exempt — they legitimately use shadcn HSL channels or define raw values.
//
// Modes:
//   hook (default, stdin payload) — emit a warning context, never block.
//   --all                         — scan all governed files, exit 1 on violations.
//   --file <path>                 — scan one file, exit 1 on violations.
//
// Decision (project): in governed component code, colors must be CSS-var tokens
// (var(--color-arco-*)). Raw hex, rgb/hsl/oklch, named colors, and Tailwind default
// color classes (bg-slate-*, text-gray-*, border-white …) are disallowed.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

// Only files under this prefix are governed.
const GOVERNED_PREFIX = path.join('src', 'demo')

// Within the governed prefix, these are exempt (token/theme definitions).
const EXEMPT_FILES = [
  path.join('src', 'demo', 'theme.css'),
  path.join('src', 'index.css'),
  'tailwind.config.js',
  path.join('docs', 'DESIGN.md'),
  'DESIGN.md',
]
// Path fragments that are always exempt (generated / primitive code).
const EXEMPT_FRAGMENTS = [path.join('components', 'ui') + path.sep, path.sep + 'ui' + path.sep]

const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.scss', '.sass', '.mdx'])

const RULES = [
  { re: /#[0-9a-fA-F]{3,8}\b/, msg: 'raw hex color' },
  { re: /\b(rgba?|hsla?|oklch|oklab|lab|lch)\s*\(/, msg: 'raw color function' },
  { re: /\bcolor-mix\s*\(/, msg: 'color-mix()' },
  { re: /\b(bg|text|border|ring|from|to|via|fill|stroke|outline|divide|shadow|placeholder|caret|accent)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/, msg: 'Tailwind default color class' },
  { re: /\b(bg|text|border|ring|fill|stroke|divide|placeholder)-(black|white)\b/, msg: 'Tailwind black/white class' },
]

// Lines containing one of these are skipped (e.g. eslint-style allow comment).
const ALLOW_COMMENT = /design-tokens:allow/

function isGoverned(rel) {
  if (!rel.startsWith(GOVERNED_PREFIX + path.sep)) return false
  if (EXEMPT_FILES.includes(rel)) return false
  if (EXEMPT_FRAGMENTS.some((f) => rel.includes(f))) return false
  return EXTS.has(path.extname(rel))
}

function scanFile(abs) {
  const rel = path.relative(ROOT, abs)
  const out = []
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (ALLOW_COMMENT.test(line)) return
    for (const { re, msg } of RULES) {
      const m = line.match(re)
      if (m) out.push({ rel, line: i + 1, msg, snippet: m[0] })
    }
  })
  return out
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, acc)
    else acc.push(abs)
  }
}

function governedFiles() {
  const all = []
  const base = path.join(ROOT, GOVERNED_PREFIX)
  if (fs.existsSync(base)) walk(base, all)
  return all.filter((abs) => isGoverned(path.relative(ROOT, abs)))
}

function report(findings) {
  if (findings.length === 0) {
    console.log('[design-tokens] ✓ no raw colors in governed (src/demo) component code')
    return
  }
  console.error(`[design-tokens] ✗ ${findings.length} raw-color violation(s):`)
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}  ${f.msg} → ${f.snippet}`)
  }
  console.error('  Fix: replace with a token, e.g. bg-[var(--color-arco-page)]. See src/demo/theme.css.')
}

const arg = process.argv[2]

if (arg === '--all') {
  const findings = governedFiles().flatMap(scanFile)
  report(findings)
  process.exit(findings.length ? 1 : 0)
}

if (arg === '--file') {
  const file = process.argv[3]
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
  if (!isGoverned(path.relative(ROOT, abs))) {
    console.log('[design-tokens] (skipped — not governed)')
    process.exit(0)
  }
  const findings = scanFile(abs)
  report(findings)
  process.exit(findings.length ? 1 : 0)
}

// hook mode: read payload. Blocks by default (raw colors rejected); set
// ARCO_TOKENS_BLOCK=0 to downgrade to warn-only during a transition.
async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return chunks.join('')
}
const raw = await readStdin().catch(() => '')
let payload = {}
try { payload = raw ? JSON.parse(raw) : {} } catch { process.exit(0) }
const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? {}
const file = input.file_path ?? input.path ?? ''
if (!file) process.exit(0)
const abs = path.isAbsolute(file) ? file : path.join(ROOT, file)
const rel = path.relative(ROOT, abs)
if (!isGoverned(rel) || !fs.existsSync(abs)) process.exit(0)
const findings = scanFile(abs)
const BLOCK = process.env.ARCO_TOKENS_BLOCK !== '0'
if (findings.length) {
  const level = BLOCK ? 'BLOCKED' : 'warning'
  console.error(`[design-tokens] ${level}: ${findings.length} raw-color use(s) in ${rel} — use var(--color-arco-*) tokens (or // design-tokens:allow).`)
  for (const f of findings.slice(0, 8)) console.error(`  L${f.line}: ${f.msg} (${f.snippet})`)
  process.exit(BLOCK ? 2 : 0)
}
process.exit(0)
