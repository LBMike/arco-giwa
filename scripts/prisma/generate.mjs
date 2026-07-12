import { spawnSync } from "node:child_process"

process.env.DATABASE_URL ||= "postgresql://postgres:postgres@localhost:5432/arco_generate"
process.env.DIRECT_URL ||= process.env.DATABASE_URL

const result = spawnSync("prisma", ["generate"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
})

process.exit(result.status ?? 1)

