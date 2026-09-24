import { existsSync, writeFileSync } from "fs"
import path from "path"
import hre from "hardhat"
import { deployStocks } from "./deploy"

async function main() {
  const output = process.env.STOCKS_MANIFEST_OUTPUT
  const abiDigest = process.env.STOCKS_ABI_DIGEST ?? ""
  if (!output || !path.isAbsolute(output) || existsSync(output)) {
    throw new Error("Set STOCKS_MANIFEST_OUTPUT to a new absolute output filename")
  }
  const { manifest, publicAccounts } = await deployStocks(hre, abiDigest)
  writeFileSync(
    output,
    JSON.stringify(
      {
        execution: "LOCAL_EVM_TEST_HARNESS_ONLY",
        manifest,
        publicAccounts,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  )
  console.log(`Local Stocks deployment written to ${output}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Stocks local deployment failed")
  process.exitCode = 1
})
