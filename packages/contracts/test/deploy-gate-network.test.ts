import { expect } from "chai"
import { ethers, network } from "hardhat"

describe("pre-broadcast test gate network", () => {
  it("runs contract tests on the local hardhat chain, not GIWA", async () => {
    const chain = await ethers.provider.getNetwork()
    expect(network.name).to.equal("hardhat")
    expect(chain.chainId).to.equal(31337)
    expect(chain.chainId).not.to.equal(91342)
  })
})
