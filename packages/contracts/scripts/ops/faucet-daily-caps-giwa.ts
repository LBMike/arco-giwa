import { readFileSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractTransaction, utils } from "ethers"
import { ethers, network } from "hardhat"
import { EXPECTED_GIWA_DEPLOYER, GIWA_EXPLORER_BASE_URL } from "../keystore-constants"

// Sets the test-asset faucet's daily cap on GIWA Sepolia to FAUCET_DAILY_DRIPS drips a day, for every asset the faucet
// lists. Only the daily cap changes: the drip amount, the global cap, the cooldown and the enabled switch stay as they are
// (configureAsset rewrites all five, so the current values are read and sent back). Running it again with the same number
// changes nothing.
//
// dry-run (default): reads and prints the plan. No signer, no transaction.
//   cd packages/contracts
//   FAUCET_DAILY_DRIPS=1000 corepack yarn hardhat run scripts/ops/faucet-daily-caps-giwa.ts --network giwaSepolia
// broadcast: the deployer keystore (FAUCET_ADMIN_ROLE), one configureAsset per asset that changes.
//   FAUCET_DAILY_DRIPS=1000 CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
//     corepack yarn ts-node scripts/with-keystore-password.ts \
//     hardhat run scripts/ops/faucet-daily-caps-giwa.ts --network giwaSepolia

const CONFIRM = "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA"
const TX_TIMEOUT_MS = 180_000
const FAUCET_ADMIN_ROLE = utils.keccak256(utils.toUtf8Bytes("FAUCET_ADMIN_ROLE"))
const FAUCET_ABI = [
  "function supportedAssets() view returns (address[])",
  "function assetConfigs(address) view returns (uint256 dripAmount, uint256 dailyCap, uint256 globalCap, uint256 cooldown, bool enabled)",
  "function totalMintedByAsset(address) view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function configureAsset(address token, uint256 dripAmount, uint256 dailyCap, uint256 globalCap, uint256 cooldown, bool enabled)",
]
const TOKEN_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"]

type AssetConfig = { dripAmount: BigNumber; dailyCap: BigNumber; globalCap: BigNumber; cooldown: BigNumber; enabled: boolean }

function repoRoot() {
  return path.resolve(__dirname, "../../../..")
}

function faucetAddress(): string {
  const registry = JSON.parse(readFileSync(path.join(repoRoot(), "deployments/91342/arco-giwa-preprod.json"), "utf8"))
  const address = registry?.faucet?.proxy
  if (typeof address !== "string" || !utils.isAddress(address)) throw new Error("No faucet proxy in deployments/91342/arco-giwa-preprod.json")
  return utils.getAddress(address)
}

function dailyDrips(): number {
  const raw = process.env.FAUCET_DAILY_DRIPS
  const drips = Number(raw)
  if (!raw || !Number.isInteger(drips) || drips < 1 || drips > 100_000) {
    throw new Error("Set FAUCET_DAILY_DRIPS to the drips a day each asset allows (a whole number, 1 to 100000), e.g. 1000")
  }
  return drips
}

async function waitFor(tx: ContractTransaction, label: string) {
  let timer: NodeJS.Timeout | undefined
  try {
    const receipt = await Promise.race([
      tx.wait(1),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: no receipt after ${TX_TIMEOUT_MS / 1000}s (${tx.hash})`)), TX_TIMEOUT_MS)
      }),
    ])
    if (receipt.status !== 1) throw new Error(`${label} reverted: ${tx.hash}`)
    return receipt
  } finally {
    // A pending timer would keep the script running for the rest of the timeout after "Done."
    clearTimeout(timer)
  }
}

async function main() {
  if (process.env.DEPLOYER_PRIVATE_KEY) throw new Error("Raw private-key signing is forbidden")
  const chain = await ethers.provider.getNetwork()
  if (network.name !== "giwaSepolia" || chain.chainId !== 91342) throw new Error(`Expected giwaSepolia (91342), got ${network.name} ${chain.chainId}`)
  const drips = dailyDrips()
  const faucet = new Contract(faucetAddress(), FAUCET_ABI, ethers.provider)
  console.log(`Faucet ${faucet.address}: daily cap → ${drips} drips a day for every asset`)

  const plan: { token: string; symbol: string; config: AssetConfig; dailyCap: BigNumber }[] = []
  for (const token of (await faucet.supportedAssets()) as string[]) {
    const erc20 = new Contract(token, TOKEN_ABI, ethers.provider)
    const [symbol, decimals, config, minted] = await Promise.all([
      erc20.symbol() as Promise<string>,
      erc20.decimals() as Promise<number>,
      faucet.assetConfigs(token) as Promise<AssetConfig>,
      faucet.totalMintedByAsset(token) as Promise<BigNumber>,
    ])
    const dailyCap = config.dripAmount.mul(drips)
    const human = (value: BigNumber) => utils.formatUnits(value, decimals)
    const change = dailyCap.eq(config.dailyCap) ? "unchanged" : `${human(config.dailyCap)} → ${human(dailyCap)}`
    console.log(
      `  ${symbol.padEnd(7)} drip ${human(config.dripAmount)} · daily cap ${change} · global cap ${human(config.globalCap)} (minted ${human(minted)}) · cooldown ${config.cooldown.toNumber() / 3600}h · ${config.enabled ? "enabled" : "disabled"}`,
    )
    if (config.globalCap.lt(dailyCap)) console.log(`    note: the global cap is below the new daily cap; the global cap still limits ${symbol}`)
    if (!dailyCap.eq(config.dailyCap)) plan.push({ token, symbol, config, dailyCap })
  }
  if (plan.length === 0) {
    console.log("Nothing to change.")
    return
  }
  if (process.env.CONFIRM_GIWA_BROADCAST !== CONFIRM) {
    console.log(`dry-run: nothing sent. ${plan.length} configureAsset transaction(s) would be sent from ${EXPECTED_GIWA_DEPLOYER}.`)
    console.log(`To send them: CONFIRM_GIWA_BROADCAST=${CONFIRM} with the keystore (see the top of this file).`)
    return
  }

  const [signer] = await ethers.getSigners()
  if (!signer) throw new Error("No signer: run through scripts/with-keystore-password.ts")
  if (signer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) throw new Error(`Signer is ${signer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  if (!(await faucet.hasRole(FAUCET_ADMIN_ROLE, signer.address))) throw new Error(`${signer.address} lacks FAUCET_ADMIN_ROLE on the faucet`)
  const writer = faucet.connect(signer)
  for (const { token, symbol, config, dailyCap } of plan) {
    const tx: ContractTransaction = await writer.configureAsset(token, config.dripAmount, dailyCap, config.globalCap, config.cooldown, config.enabled)
    console.log(`sent configureAsset ${symbol}: ${GIWA_EXPLORER_BASE_URL}/tx/${tx.hash}`)
    await waitFor(tx, `configureAsset ${symbol}`)
    const after = (await faucet.assetConfigs(token)) as AssetConfig
    if (!after.dailyCap.eq(dailyCap)) throw new Error(`${symbol}: daily cap reads ${after.dailyCap.toString()} after the transaction`)
    console.log(`confirmed ${symbol}: daily cap ${after.dailyCap.toString()} (base units)`)
  }
  console.log("Done.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
