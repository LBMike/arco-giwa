// Checks that a customer-app build carries none of the admin UI (docs/admin-console.md). With VITE_ADMIN_CONSOLE_URL
// set at build time the customer app sends /admin, /admin/* and /admin/stocks to the separate admin console and the
// build leaves the legacy admin pages out; this inspects the emitted files to confirm it:
//
//   VITE_ADMIN_CONSOLE_URL=https://admin.example.com npm run build && npm run check:customer-bundle
//
// Any one of these fails the check:
//   1. a file named after an admin module (Vite names a lazily loaded chunk after its module: AdminPrices-1a2B3c4D.js);
//   2. admin copy: strings that only admin modules contain, derived from src/ on every run so they follow edits;
//   3. source maps, when the build wrote them (vite build --sourcemap): an admin module among their sources.
// When VITE_ADMIN_CONSOLE_URL is also set for this command, the bundle must contain that address too.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

/** Modules that only the admin UI loads, as paths relative to the repository root. */
export const ADMIN_MODULES = [
  /^src\/admin\//,
  /^src\/demo\/giwa\/(?:GiwaAdminLayout|RequireGiwaAdmin|AdminPrices|AdminConfig|AdminFeatured|AdminOperations|AdminMonitoring|VaultAdmin|PriceFeedAdminPanel|admin-context|admin-roles)\.tsx?$/,
  /^src\/demo\/giwa\/stocks-market\/StocksAdminPage\.tsx$/,
  /^src\/demo\/giwa\/stocks-admin\//,
  /^src\/demo\/giwa\/stocks-trading-control\//,
]

export const isAdminModule = (relative) => ADMIN_MODULES.some((pattern) => pattern.test(relative))
// Tests and verification pages never reach a bundle, so they neither supply nor veto markers.
const isProductSource = (relative) =>
  /\.tsx?$/.test(relative) && !/\.d\.ts$/.test(relative) && !/\.test\.tsx?$/.test(relative) && !/(?:^|\/)verification\//.test(relative)

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full, base)
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join("/")] : []
  })
}

const QUOTED = /(["'`])((?:(?!\1)[^\\\n$]){16,160})\1/g
const JSX_TEXT = />([^<>{}\n]{16,160})</g
// Operator-facing sentences: printable ASCII (the minifier may escape anything else), no code punctuation, three or
// more words and a capital letter, which leaves out class lists, paths, identifiers and stray code.
const PROSE = (text) => /^[\x20-\x7e]+$/.test(text) && !/[<>{}=;]/.test(text) && text.split(/\s+/).length >= 3 && /[A-Z]/.test(text)

/**
 * What identifies admin code in a bundle: the copy only admin modules contain (checked against every customer
 * source file) and the names of the admin component modules that Vite would give their chunks.
 */
export function adminSignals(root = ROOT) {
  const sources = walk(path.join(root, "src")).map((file) => `src/${file}`).filter(isProductSource)
  const admin = sources.filter(isAdminModule)
  const customer = sources.filter((file) => !isAdminModule(file))
  const customerText = customer.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n")
  const markers = new Map()
  for (const module of admin) {
    const text = fs.readFileSync(path.join(root, module), "utf8")
    const found = [...text.matchAll(QUOTED)].map((match) => match[2]).concat([...text.matchAll(JSX_TEXT)].map((match) => match[1]))
    for (const candidate of found.map((value) => value.trim())) {
      if (candidate.length >= 16 && PROSE(candidate) && !markers.has(candidate) && !customerText.includes(candidate)) markers.set(candidate, module)
    }
  }
  const stem = (file) => path.posix.basename(file).replace(/\.tsx?$/, "")
  const customerStems = new Set(customer.map(stem))
  const names = new Set(admin.map(stem).filter((name) => (/[A-Z]/.test(name) || /admin/i.test(name)) && !customerStems.has(name)))
  if (markers.size < 20 || names.size < 8) throw new Error(`Too few admin signals (${markers.size} markers, ${names.size} names): is ${root} the repository root?`)
  return { markers: [...markers].map(([text, module]) => ({ text, module })), names }
}

/** Every trace of admin code in the build at `dist`; an empty list means the customer bundle is clean. */
export function inspectCustomerBundle({ dist, root = ROOT, consoleUrl } = {}) {
  if (!dist || !fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error(`${dist} has no index.html: build the customer app first (npm run build).`)
  }
  const files = walk(dist)
  const code = files.filter((file) => /\.(?:m?js|html)$/.test(file))
  if (!code.some((file) => file.endsWith(".js"))) throw new Error(`${dist} has no JavaScript files.`)
  const { markers, names } = adminSignals(root)
  const violations = []
  for (const file of files) {
    const name = /^(.+?)-[\w-]{8}\.(?:m?js|css)(?:\.map)?$/.exec(path.posix.basename(file))?.[1]
    if (name && names.has(name)) violations.push({ file, rule: "chunk name", detail: name })
  }
  const texts = new Map(code.map((file) => [file, fs.readFileSync(path.join(dist, file), "utf8")]))
  for (const [file, text] of texts) {
    for (const marker of markers) if (text.includes(marker.text)) violations.push({ file, rule: "admin copy", detail: `${JSON.stringify(marker.text)} from ${marker.module}` })
  }
  for (const file of files.filter((name) => name.endsWith(".map"))) {
    const map = JSON.parse(fs.readFileSync(path.join(dist, file), "utf8"))
    for (const source of Array.isArray(map.sources) ? map.sources : []) {
      const relative = path.relative(root, path.resolve(path.dirname(path.join(dist, file)), String(source))).split(path.sep).join("/")
      if (isAdminModule(relative)) violations.push({ file, rule: "source map", detail: relative })
    }
  }
  if (consoleUrl && ![...texts.values()].some((text) => text.includes(consoleUrl))) {
    violations.push({ file: "(bundle)", rule: "console address", detail: `${consoleUrl} is not in the bundle; was it built with this VITE_ADMIN_CONSOLE_URL?` })
  }
  return { violations, files: files.length, markers: markers.length, names: names.size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dist = path.resolve(process.argv[2] ?? path.join(ROOT, "dist"))
  const consoleUrl = process.env.VITE_ADMIN_CONSOLE_URL || undefined
  try {
    const result = inspectCustomerBundle({ dist, consoleUrl })
    if (result.violations.length) {
      console.error(`Admin code found in the customer bundle at ${dist}:`)
      for (const { file, rule, detail } of result.violations.slice(0, 40)) console.error(`  ${file} — ${rule}: ${detail}`)
      if (result.violations.length > 40) console.error(`  … and ${result.violations.length - 40} more`)
      console.error("Build the customer app with VITE_ADMIN_CONSOLE_URL set to leave the legacy admin out (docs/admin-console.md).")
      process.exit(1)
    }
    console.log(`customer bundle check passed: ${result.files} files, no admin chunks (${result.names} module names, ${result.markers} admin strings checked)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
