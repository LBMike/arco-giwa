import path from "path"
import base from "../../hardhat.stocks.config"

const root = path.resolve(__dirname, "../..")
export default {
  ...base,
  networks: { hardhat: { chainId: 31337, hardfork: "cancun" as const, loggingEnabled: false } },
  paths: {
    root,
    sources: path.join(root, "contracts/stocks"),
    tests: path.join(root, "test/stocks"),
    cache: path.join(root, "cache/stocks"),
    artifacts: path.join(root, "artifacts/stocks"),
  },
}
