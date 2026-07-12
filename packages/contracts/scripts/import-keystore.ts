import { mkdirSync, writeFileSync, chmodSync, existsSync } from "fs"
import path from "path"
import { Wallet } from "ethers"
import {
  DEFAULT_GIWA_KEYSTORE_RELATIVE_PATH,
  EXPECTED_GIWA_DEPLOYER,
} from "./keystore-constants"
import { promptHidden } from "./hidden-prompt"

function packageRoot() {
  return path.resolve(__dirname, "..")
}

function keystorePath() {
  return path.join(packageRoot(), DEFAULT_GIWA_KEYSTORE_RELATIVE_PATH)
}

async function main() {
  const outputPath = keystorePath()
  const force = process.argv.includes("--force")
  if (existsSync(outputPath) && !force) {
    throw new Error(
      `GIWA deployer keystore already exists at ${outputPath}. Re-run with --force only if you intend to replace it.`,
    )
  }

  const privateKey = await promptHidden(`Paste private key for ${EXPECTED_GIWA_DEPLOYER}: `)
  const wallet = new Wallet(privateKey.trim())
  if (wallet.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`Private key resolves to ${wallet.address}, expected ${EXPECTED_GIWA_DEPLOYER}`)
  }

  const password = await promptHidden("Create keystore password: ")
  const confirmation = await promptHidden("Confirm keystore password: ")
  if (!password) throw new Error("Keystore password cannot be empty")
  if (password !== confirmation) throw new Error("Keystore passwords do not match")

  const encryptedJson = await wallet.encrypt(password)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, encryptedJson, { mode: 0o600 })
  chmodSync(outputPath, 0o600)

  console.log(
    JSON.stringify(
      {
        status: "giwa deployer keystore written",
        address: wallet.address,
        path: outputPath,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
