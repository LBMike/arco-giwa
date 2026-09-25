import path from "path"
import base from "../../hardhat.stocks.config"

const root = path.resolve(__dirname, "../..")
// Isolated Hardhat-only fixture compiles the unchanged platform token/faucet as well as Stocks.
// No dotenv, GIWA account loader, live RPC, registry or user key material is imported.
export default {
  ...base,
  networks: { hardhat: { chainId: 91342, hardfork: "cancun" as const, loggingEnabled: false } },
  paths: {
    root,
    sources: path.join(root, "contracts"),
    tests: path.join(root, "test/external-cash"),
    cache: path.join(root, "cache/external-cash"),
    artifacts: path.join(root, "artifacts/stocks"),
  },
}
