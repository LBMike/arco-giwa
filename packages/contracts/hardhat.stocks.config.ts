import "@nomiclabs/hardhat-ethers"
import { HardhatUserConfig, subtask } from "hardhat/config"
import {
  TASK_NODE_CREATE_SERVER,
  TASK_NODE_GET_PROVIDER,
  TASK_NODE_SERVER_READY,
} from "hardhat/builtin-tasks/task-names"

subtask(TASK_NODE_GET_PROVIDER).setAction(async (args, _hre, runSuper) => {
  if (args.forkUrl || args.forkBlockNumber !== undefined)
    throw new Error("Stocks local node cannot fork")
  return runSuper(args)
})

subtask(TASK_NODE_CREATE_SERVER).setAction(async (args, _hre, runSuper) => {
  if (args.hostname !== "127.0.0.1") throw new Error("Stocks local node must bind loopback")
  return runSuper(args)
})

// Hardhat's default node banner prints private keys. Never invoke that banner.
subtask(TASK_NODE_SERVER_READY).setAction(async ({ address, port }) => {
  if (address !== "127.0.0.1") throw new Error("Stocks local node must bind loopback")
  console.log(`STOCKS_TEST_HARNESS_ONLY ready at http://127.0.0.1:${port}`)
})

const port = process.env.STOCKS_LOCAL_RPC_PORT ?? "18545"
if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
  throw new Error("Invalid Stocks local port")

// Isolated local EVM. No dotenv, keystore, live network, proxy, or registry imports.
const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 91342, hardfork: "cancun", loggingEnabled: false },
    stocksLocal: { chainId: 91342, url: `http://127.0.0.1:${port}`, accounts: "remote" },
  },
  paths: {
    sources: "./contracts/stocks",
    tests: "./test/stocks",
    cache: "./cache/stocks",
    artifacts: "./artifacts/stocks",
  },
  mocha: { timeout: 120000 },
}

export default config
