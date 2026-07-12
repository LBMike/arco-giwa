import { ethers, network } from "hardhat"
import { EXPECTED_GIWA_DEPLOYER, GIWA_EXPLORER_BASE_URL } from "./keystore-constants"

async function main() {
  const evmVersion = process.env.GIWA_EVM_VERSION ?? "cancun"
  const chainId = await ethers.provider.getNetwork().then((n) => n.chainId)
  if (chainId !== 91342) {
    throw new Error(`evm:probe:giwa must run on chain 91342, got ${chainId}`)
  }

  const [deployer] = await ethers.getSigners()
  if (!deployer) {
    throw new Error("No deployer signer is configured for GIWA probe")
  }
  if (deployer.address.toLowerCase() !== EXPECTED_GIWA_DEPLOYER.toLowerCase()) {
    throw new Error(`GIWA probe signer is ${deployer.address}; expected ${EXPECTED_GIWA_DEPLOYER}`)
  }

  const Probe = await ethers.getContractFactory("EvmVersionProbe")
  const probe = await Probe.deploy()
  const receipt = await probe.deployTransaction.wait()

  console.log(
    JSON.stringify(
      {
        network: network.name,
        chainId,
        deployer: deployer.address,
        probe: probe.address,
        evmVersion,
        txHash: probe.deployTransaction.hash,
        explorerUrl: `${GIWA_EXPLORER_BASE_URL}/tx/${probe.deployTransaction.hash}`,
        status: receipt.status === 1 ? "accepted" : "failed",
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  if ((process.env.GIWA_EVM_VERSION ?? "cancun") === "cancun") {
    console.error("If GIWA rejects the cancun bytecode, fall back to GIWA_EVM_VERSION=shanghai. Never use prague on GIWA.")
  }
  process.exitCode = 1
})
