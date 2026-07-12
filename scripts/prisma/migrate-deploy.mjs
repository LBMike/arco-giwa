import { spawnSync } from "node:child_process"

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

