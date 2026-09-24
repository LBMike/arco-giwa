import { spawnSync } from "node:child_process"
import path from "node:path"
import { inspectMigrationsDirectory } from "./inspect-migrations.mjs"

// Enforce isolation before Prisma starts or reads a database configuration.
// Inspection is local and read-only; it never changes historical SQL.
const findings = inspectMigrationsDirectory(path.join(process.cwd(), "prisma", "migrations"))
if (findings.length) {
  console.error(findings.join("\n"))
  process.exit(1)
}

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL is required for prisma:migrate:deploy")
  process.exit(1)
}

process.env.DATABASE_URL = process.env.DIRECT_URL

const result = spawnSync("prisma", ["migrate", "deploy"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
})

process.exit(result.status ?? 1)

