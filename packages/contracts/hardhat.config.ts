import "dotenv/config"
import "@nomiclabs/hardhat-ethers"
import "@openzeppelin/hardhat-upgrades"
import "@nomicfoundation/hardhat-verify"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { Wallet } from "ethers"
import { HardhatUserConfig } from "hardhat/config"
import {
  DEFAULT_GIWA_KEYSTORE_RELATIVE_PATH,
  EXPECTED_GIWA_DEPLOYER,
  GIWA_EXPLORER_BASE_URL,
  KEYSTORE_IMPORT_COMMAND,
} from "./scripts/keystore-constants"

const GIWA_CHAIN_ID = 91342
const evmVersion = process.env.GIWA_EVM_VERSION ?? "cancun"
const forbiddenGiwaEvmVersion = "pra" + "gue"

if (evmVersion === forbiddenGiwaEvmVersion) {
  throw new Error("GIWA builds must not use the future mainnet EVM target")
}

if (process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("Raw DEPLOYER_PRIVATE_KEY is forbidden; use the encrypted GIWA deployer keystore")
}

function giwaKeystorePath() {
  return (
    process.env.GIWA_DEPLOYER_KEYSTORE ??
    path.join(__dirname, DEFAULT_GIWA_KEYSTORE_RELATIVE_PATH)
  )
}

function giwaAccounts() {
  if (process.env.GIWA_REQUIRE_KEYSTORE !== "1") return []

  const keystorePath = giwaKeystorePath()
  if (!existsSync(keystorePath)) {
    throw new Error(`GIWA deployer keystore is not set up. Run: ${KEYSTORE_IMPORT_COMMAND}`)
  }

  const password = process.env.GIWA_KEYSTORE_PASSWORD
  if (!password) {
    throw new Error(
      "GIWA keystore password is missing. Run npm run evm:probe:giwa or npm run evm:deploy:giwa so the password prompt can unlock the keystore.",
    )
  }

  let wallet: Wallet
  try {
    wallet = Wallet.fromEncryptedJsonSync(readFileSync(keystorePath, "utf8"), password)
  } catch {
    throw new Error("Unable to decrypt GIWA deployer keystore. Check the password and try again.")
  }

  if (wallet.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA keystore resolves to ${wallet.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }

  return [wallet.privateKey]
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    giwaSepolia: {
      chainId: GIWA_CHAIN_ID,
      url: process.env.GIWA_DEPLOY_RPC_URL ?? "https://sepolia-rpc.giwa.io",
      accounts: giwaAccounts(),
    },
  },
  etherscan: {
    // Blockscout (GIWA's explorer) does not enforce real API keys, but the
    // hardhat-verify plugin requires a non-empty value per configured network.
    apiKey: {
      giwaSepolia: "empty",
    },
    customChains: [
      {
        network: "giwaSepolia",
        chainId: GIWA_CHAIN_ID,
        urls: {
          apiURL: `${GIWA_EXPLORER_BASE_URL}/api`,
          browserURL: GIWA_EXPLORER_BASE_URL,
        },
      },
    ],
  },
  mocha: {
    timeout: 120000,
  },
}

export default config
