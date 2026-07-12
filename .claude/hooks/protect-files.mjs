#!/usr/bin/env node
// protect-files.mjs — blocks Claude Code from reading or modifying .env files.
// PreToolUse hook on Read/Write/Edit/MultiEdit/Bash. Reads the tool payload from
// stdin (Claude Code hook protocol) and exits non-zero to block.
//
// Allowed (safe templates): .env.example/.sample/.template/.schema/.defaults
// Blocked: every other .env* variant.

import process from 'node:process'

const BLOCK_RE = /(^|[\/\\])\.env(\.(local|development|test|production|staging|preview)(\.local)?)?$/
const ALLOW_RE = /\.env\.(example|sample|template|schema|defaults)$/

function isProtected(p) {
  if (!p) return false
  if (ALLOW_RE.test(p)) return false
  return BLOCK_RE.test(p)
}

function bashTouchesEnv(cmd) {
  if (!cmd) return false
  return cmd.split(/\s+|['"=]/).some((tok) => isProtected(tok))
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return chunks.join('')
}

function block(msg) {
  console.error(`[protect-files] BLOCKED: ${msg}`)
  process.exit(2)
}

const raw = await readStdin().catch(() => '')
let payload = {}
try {
  payload = raw ? JSON.parse(raw) : {}
} catch {
  process.exit(0)
}

const tool = payload.tool_name ?? payload.toolName ?? ''
const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? {}

const pathFields = [input.file_path, input.path, input.filePath, input.notebook_path]
for (const p of pathFields) {
  if (isProtected(String(p ?? ''))) block(`${tool} on protected env file: ${p}`)
}
if (Array.isArray(input.edits)) {
  for (const e of input.edits) {
    if (isProtected(String(e?.file_path ?? ''))) block(`MultiEdit on protected env file`)
  }
}
if (tool === 'Bash' && bashTouchesEnv(String(input.command ?? ''))) {
  block(`Bash command references a protected env file`)
}

process.exit(0)
