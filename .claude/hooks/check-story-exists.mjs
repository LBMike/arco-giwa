#!/usr/bin/env node
// check-story-exists.mjs — companion-file structure check for Launch App components.
//
// Project-tuned: Storybook is NOT yet installed, so .stories.tsx is treated as a
// SOFT requirement (warning only) until Storybook lands. The hard requirement for
// now is the type split + barrel when a component lives in its own folder.
//
//   Component.tsx        (required)
//   Component.types.ts   (required when folder-per-component)
//   index.ts             (required when folder-per-component)
//   Component.stories.tsx(soft — warn until Storybook is set up)
//
// Single-file components directly under components/ (e.g. ProductsTable.tsx with no
// dedicated folder) are allowed during the transition and only produce a notice.
//
// Modes: --all (scan, exit 1 on HARD violations) | hook (stdin, warn only).

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const GOVERNED = path.join('src', 'demo', 'components')
const STORYBOOK_PRESENT = fs.existsSync(path.join(ROOT, '.storybook'))

const isComponentFile = (name) =>
  /^[A-Z][A-Za-z0-9]*\.(t|j)sx$/.test(name) &&
  !/\.(stories|test|spec)\./.test(name) &&
  name !== 'index.tsx'

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, acc)
    else if (isComponentFile(e.name)) acc.push(abs)
  }
}

function check(abs) {
  const dir = path.dirname(abs)
  const base = path.basename(abs).replace(/\.(t|j)sx$/, '')
  const rel = path.relative(ROOT, abs)
  // folder-per-component = the file sits in a dir named after it (Foo/Foo.tsx)
  const folderPer = path.basename(dir) === base
  const has = (f) => fs.existsSync(path.join(dir, f))

  const hard = []
  const soft = []
  if (folderPer) {
    if (!has(`${base}.types.ts`)) hard.push(`${base}.types.ts`)
    if (!has('index.ts')) hard.push('index.ts')
  }
  if (!has(`${base}.stories.tsx`)) {
    ;(STORYBOOK_PRESENT ? hard : soft).push(`${base}.stories.tsx`)
  }
  return { rel, folderPer, hard, soft }
}

function run() {
  const files = []
  walk(path.join(ROOT, GOVERNED), files)
  let hardCount = 0
  for (const abs of files) {
    const r = check(abs)
    if (r.hard.length) {
      hardCount += r.hard.length
      console.error(`[story-structure] ✗ ${r.rel} missing: ${r.hard.join(', ')}`)
    }
    if (r.soft.length) {
      console.error(`[story-structure] · ${r.rel} (soft) missing: ${r.soft.join(', ')} — add when Storybook lands`)
    }
  }
  if (hardCount === 0) console.log('[story-structure] ✓ no hard structure violations')
  return hardCount
}

const arg = process.argv[2]
if (arg === '--all') {
  process.exit(run() ? 1 : 0)
}

// hook mode — warn only
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
if (!rel.startsWith(GOVERNED + path.sep) || !isComponentFile(path.basename(abs)) || !fs.existsSync(abs)) {
  process.exit(0)
}
const r = check(abs)
if (r.hard.length || r.soft.length) {
  console.error(`[story-structure] note for ${rel}: missing ${[...r.hard, ...r.soft].join(', ')}`)
}
process.exit(0)
