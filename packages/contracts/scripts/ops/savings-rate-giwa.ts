import { readFileSync } from "fs"
import path from "path"
import { BigNumber, Contract, ContractTransaction, utils } from "ethers"
import { ethers, network } from "hardhat"
import { EXPECTED_GIWA_DEPLOYER, GIWA_EXPLORER_BASE_URL } from "../keystore-constants"

// Sets the sArcoUSD yield rate on GIWA Sepolia: ArcoUSDSavingsDistributor.setParams with maxAprBps = SAVINGS_MAX_APR_BPS
// (the distribution interval and the reserve margin stay as they are). It also prints what the yield needs to flow,
// because the rate is only a cap: each distribution is the smallest of the Reserve's surplus above its margin, this APR
// on sArcoUSD's average assets, and the room under the mint cap; the keeper sends one a day once it is at least a cent.
//
// dry-run (default): reads and prints. No signer, no transaction.
//   cd packages/contracts
//   SAVINGS_MAX_APR_BPS=450 corepack yarn hardhat run scripts/ops/savings-rate-giwa.ts --network giwaSepolia
// broadcast: the deployer keystore (the distributor's DEFAULT_ADMIN_ROLE), one setParams.
//   SAVINGS_MAX_APR_BPS=450 CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
//     corepack yarn ts-node scripts/with-keystore-password.ts \
//     hardhat run scripts/ops/savings-rate-giwa.ts --network giwaSepolia

const CONFIRM = "I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA"
const TX_TIMEOUT_MS = 180_000
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32)
const MAX_APR_BPS = 5_000 // ArcoUSDSavingsDistributor.MAX_APR_BPS
const KEEPER_MIN = utils.parseUnits("0.01", 18) // the keeper sends distribute() from a cent
const DISTRIBUTOR_ABI = [
  "function minInterval() view returns (uint64)",
  "function maxAprBps() view returns (uint16)",
  "function reserveMarginBps() view returns (uint16)",
  "function lastDistribution() view returns (uint64)",
  "function preview() view returns (uint256 amount, uint256 surplus, uint256 rateCap, uint256 mintHeadroom, uint256 nextAt, bool navOk)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function setParams(uint64 minInterval_, uint16 maxAprBps_, uint16 reserveMarginBps_)",
]
const VAULT_ABI = ["function totalAssets() view returns (uint256)"]
const LENS_ABI = [
  "function totalBacking(address reserve) view returns (uint256 backing, bool navOk)",
  "function totalLiabilities(address reserve) view returns (uint256)",
]

function repoRoot() {
  return path.resolve(__dirname, "../../../..")
}

function address(value: unknown, label: string): string {
  if (typeof value !== "string" || !utils.isAddress(value)) throw new Error(`No ${label} in deployments/91342/arcousd-giwa.json`)
  return utils.getAddress(value)
}

function contracts() {
  const registry = JSON.parse(readFileSync(path.join(repoRoot(), "deployments/91342/arcousd-giwa.json"), "utf8"))
  return {
    reserve: address(registry?.reserve?.proxy, "reserve proxy"),
    lens: address(registry?.lens?.address, "lens"),
    vault: address(registry?.savings?.vault?.proxy, "sArcoUSD proxy"),
    distributor: address(registry?.savings?.distributor?.address, "distributor"),
  }
}

function targetAprBps(): number {
  const raw = process.env.SAVINGS_MAX_APR_BPS
  const bps = Number(raw)
  if (!raw || !Number.isInteger(bps) || bps < 0 || bps > MAX_APR_BPS) {
    throw new Error(`Set SAVINGS_MAX_APR_BPS to the yearly rate in basis points (a whole number, 0 to ${MAX_APR_BPS}), e.g. 450 for 4.5%`)
  }
  return bps
}

const usd = (value: BigNumber) => Number(utils.formatUnits(value, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`
const apyOf = (aprBps: number) => (Math.pow(1 + aprBps / 10_000 / 365, 365) - 1) * 100

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
  const target = targetAprBps()
  const at = contracts()
  const distributor = new Contract(at.distributor, DISTRIBUTOR_ABI, ethers.provider)
  const vault = new Contract(at.vault, VAULT_ABI, ethers.provider)
  const lens = new Contract(at.lens, LENS_ABI, ethers.provider)

  const [minInterval, maxAprBps, marginBps, preview, assets, backingRead, liabilities] = await Promise.all([
    distributor.minInterval() as Promise<BigNumber>,
    distributor.maxAprBps() as Promise<number>,
    distributor.reserveMarginBps() as Promise<number>,
    distributor.preview() as Promise<{ amount: BigNumber; surplus: BigNumber; rateCap: BigNumber; nextAt: BigNumber; navOk: boolean }>,
    vault.totalAssets() as Promise<BigNumber>,
    lens.totalBacking(at.reserve) as Promise<{ backing: BigNumber; navOk: boolean }>,
    lens.totalLiabilities(at.reserve) as Promise<BigNumber>,
  ])
  const margin = liabilities.mul(marginBps).div(10_000)
  console.log(`Distributor ${at.distributor}`)
  console.log(`  rate cap: ${pct(maxAprBps)} APR now → ${pct(target)} APR (about ${apyOf(target).toFixed(2)}% APY when the surplus covers it)`)
  console.log(`  interval ${minInterval.toNumber() / 3600}h and reserve margin ${pct(marginBps)} stay as they are`)
  console.log(`Reserve: backing $${usd(backingRead.backing)} (NAV ${backingRead.navOk ? "readable" : "UNREADABLE"}), ArcoUSD issued $${usd(liabilities)}, margin $${usd(margin)}`)
  console.log(`  surplus above the margin: $${usd(preview.surplus)}`)
  console.log(`sArcoUSD assets: $${usd(assets)}`)
  console.log(`Next distribution: $${usd(preview.amount)} now (rate cap $${usd(preview.rateCap)}), not before ${new Date(preview.nextAt.toNumber() * 1000).toISOString()}`)

  // What the yield needs at the target rate.
  const daily = assets.mul(target).div(10_000).div(365)
  const minAssets = KEEPER_MIN.mul(365 * 10_000).div(Math.max(target, 1))
  console.log(`At ${pct(target)}: about $${usd(daily)} a day on today's sArcoUSD assets; the keeper pays from $0.01 a day, so it needs about $${usd(minAssets)} in sArcoUSD.`)
  if (preview.surplus.isZero()) {
    console.log(
      `  There is no surplus yet. Send tUSDC to the Reserve (${at.reserve}) as a plain transfer (not deposit, which issues ArcoUSD): the part above the $${usd(margin)} margin is paid out.`,
    )
  }

  if (maxAprBps === target) {
    console.log("The rate is already set. Nothing to send.")
    return
  }
  if (process.env.CONFIRM_GIWA_BROADCAST !== CONFIRM) {
    console.log(`dry-run: nothing sent. setParams(${minInterval.toString()}, ${target}, ${marginBps}) would be sent from ${EXPECTED_GIWA_DEPLOYER}.`)
    console.log(`To send it: CONFIRM_GIWA_BROADCAST=${CONFIRM} with the keystore (see the top of this file).`)
    return
  }

  const [signer] = await ethers.getSigners()
  if (!signer) throw new Error("No signer: run through scripts/with-keystore-password.ts")
  if (signer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) throw new Error(`Signer is ${signer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  if (!(await distributor.hasRole(DEFAULT_ADMIN_ROLE, signer.address))) throw new Error(`${signer.address} lacks DEFAULT_ADMIN_ROLE on the distributor`)
  const tx: ContractTransaction = await distributor.connect(signer).setParams(minInterval, target, marginBps)
  console.log(`sent setParams: ${GIWA_EXPLORER_BASE_URL}/tx/${tx.hash}`)
  await waitFor(tx, "setParams")
  const after = (await distributor.maxAprBps()) as number
  if (after !== target) throw new Error(`maxAprBps reads ${after} after the transaction`)
  console.log(`confirmed: rate cap ${pct(after)} APR. Done.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
