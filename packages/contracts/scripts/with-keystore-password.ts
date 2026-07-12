import { spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import {
  DEFAULT_GIWA_KEYSTORE_RELATIVE_PATH,
  KEYSTORE_IMPORT_COMMAND,
} from "./keystore-constants"
import { promptHidden } from "./hidden-prompt"

function packageRoot() {
  return path.resolve(__dirname, "..")
}

function keystorePath() {
  return process.env.GIWA_DEPLOYER_KEYSTORE ?? path.join(packageRoot(), DEFAULT_GIWA_KEYSTORE_RELATIVE_PATH)
}

async function main() {
  const command = process.argv[2]
  const args = process.argv.slice(3)
  if (!command) throw new Error("Missing command to run with the GIWA deployer keystore")
  if (!existsSync(keystorePath())) {
    throw new Error(`GIWA deployer keystore is not set up. Run: ${KEYSTORE_IMPORT_COMMAND}`)
  }

  const password = process.env.GIWA_KEYSTORE_PASSWORD ?? (await promptHidden("GIWA deployer keystore password: "))
  if (!password) throw new Error("GIWA keystore password cannot be empty")

  const child = spawn(command, args, {
    cwd: packageRoot(),
    env: {
      ...process.env,
      GIWA_REQUIRE_KEYSTORE: "1",
      GIWA_KEYSTORE_PASSWORD: password,
    },
    shell: process.platform === "win32",
    stdio: "inherit",
  })

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Command terminated by ${signal}`)
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 1
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
