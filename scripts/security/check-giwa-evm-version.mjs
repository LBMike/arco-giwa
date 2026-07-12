import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const candidateFiles = [
  "packages/contracts/hardhat.config.ts",
  "packages/contracts/network-profiles/giwa-sepolia.json",
  "deployments/91342/arco-giwa-preprod.json",
]

const findings = []
for (const rel of candidateFiles) {
  const file = path.join(root, rel)
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, "utf8")
  if (/prague/i.test(text)) findings.push(`${rel} contains prague on the GIWA path`)
}

if (findings.length) {
  console.error(findings.join("\n"))
  process.exit(1)
}

console.log("GIWA evmVersion check passed")

