import fs from "node:fs"
import path from "node:path"

const migrationsDir = path.join(process.cwd(), "prisma", "migrations")
const findings = []

if (!fs.existsSync(migrationsDir)) {
  console.error("No prisma/migrations directory found")
  process.exit(1)
}

for (const dirent of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue
  const migrationPath = path.join(migrationsDir, dirent.name, "migration.sql")
  if (!fs.existsSync(migrationPath)) continue
  const sql = fs.readFileSync(migrationPath, "utf8")

  if (/\bpublic\b/i.test(sql)) {
    findings.push(`${migrationPath} references public schema`)
  }
  if (/\bwaitlist\b/i.test(sql)) {
    findings.push(`${migrationPath} references waitlist`)
  }
  if (!/CREATE SCHEMA IF NOT EXISTS "arco_evm"/.test(sql)) {
    findings.push(`${migrationPath} must create arco_evm idempotently`)
  }

  const schemaMatches = [...sql.matchAll(/"([a-zA-Z0-9_]+)"\."/g)].map((match) => match[1])
  for (const schema of schemaMatches) {
    if (schema !== "arco_evm") {
      findings.push(`${migrationPath} references non-arco_evm schema ${schema}`)
    }
  }
}

if (findings.length) {
  console.error(findings.join("\n"))
  process.exit(1)
}

console.log("Prisma migration SQL inspection passed")

