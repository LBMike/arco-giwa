#!/usr/bin/env node
// notify.mjs — best-effort desktop notification on Claude Code notification events.
// Never blocks; falls back to stdout if the OS notifier is unavailable.

import { execFile } from 'node:child_process'
import process from 'node:process'

const TITLE = 'Arco Design Harness'

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return chunks.join('')
}

const raw = await readStdin().catch(() => '')
let payload = {}
try { payload = raw ? JSON.parse(raw) : {} } catch {}
const msg = (payload.message ?? payload.notification ?? 'Task update').toString().slice(0, 200)

function done() { process.exit(0) }

try {
  if (process.platform === 'darwin') {
    const script = `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(TITLE)}`
    execFile('osascript', ['-e', script], () => done())
  } else if (process.platform === 'linux') {
    execFile('notify-send', [TITLE, msg], (err) => {
      if (err) console.log(`[${TITLE}] ${msg}`)
      done()
    })
  } else if (process.platform === 'win32') {
    const ps = `powershell -NoProfile -Command "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(4000, ${JSON.stringify(TITLE)}, ${JSON.stringify(msg)}, 'Info')"`
    execFile('cmd', ['/c', ps], () => done())
  } else {
    console.log(`[${TITLE}] ${msg}`)
    done()
  }
} catch {
  console.log(`[${TITLE}] ${msg}`)
  done()
}
