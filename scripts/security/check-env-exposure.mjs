import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const allowedSecretLikeViteKeys = new Set([
  "VITE_DYNAMIC_ENVIRONMENT_ID",
  "VITE_PUBLIC_GIWA_RPC",
  "VITE_GIWA_CHAIN_ID",
  "VITE_GIWA_EXPLORER",
  "VITE_ARCO_API_BASE",
  // Public wallet addresses gating admin-page VISIBILITY only — real enforcement is the
  // server's requireOperator + on-chain FEED_ADMIN_ROLE (see src/demo/giwa/config.ts).
  "VITE_GIWA_ADMIN_ADDRESSES",
])

const sourceDirs = ["src", "server", "scripts"]
const findings = []

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(fullPath)
    return [fullPath]
  })
}

for (const dir of sourceDirs) {
  for (const file of walk(path.join(root, dir))) {
    if (!/\.(ts|tsx|js|mjs|json|env|md)$/.test(file)) continue
    const text = fs.readFileSync(file, "utf8")
    const viteKeys = text.match(/\bVITE_[A-Z0-9_]+\b/g) ?? []
    for (const key of viteKeys) {
      const looksSecret = /SECRET|PRIVATE|SERVICE|TOKEN|NODIT|INDEXER|DATABASE|DIRECT|ADMIN|KEY/.test(key)
      if (looksSecret && !allowedSecretLikeViteKeys.has(key)) {
        findings.push(`${path.relative(root, file)} references secret-like ${key}`)
      }
    }
    if (/giwa-sepolia\.nodit\.io/i.test(text) && !file.endsWith(".env.harness.example")) {
      findings.push(`${path.relative(root, file)} embeds a Nodit endpoint`)
    }
  }
}

if (findings.length) {
  console.error(findings.join("\n"))
  process.exit(1)
}

console.log("env exposure check passed")

