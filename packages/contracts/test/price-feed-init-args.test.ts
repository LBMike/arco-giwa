import { expect } from "chai"
import { ethers } from "hardhat"
import { DEPLOY_PARAMS_DEFAULTS, priceFeedInitializerArgs } from "../scripts/deploy-params"
import { deployProxy } from "./helpers"

describe("deploy params → ProductPriceFeed.initialize", () => {
  it("puts feedMinAnswer/feedMaxAnswer in the min/max slots and leaves deviation disabled", async () => {
    const [admin] = await ethers.getSigners()
    const init = {
      ...DEPLOY_PARAMS_DEFAULTS,
      feedInitialAnswer: "150000000",
      feedHealthyDiffSeconds: 7200,
      feedMinAnswer: "50000000",
      feedMaxAnswer: "900000000",
    }
    const args = priceFeedInitializerArgs(init, admin.address)
    expect(args).to.deep.equal([8, "150000000", 7200, "50000000", "900000000", 0, admin.address])

    const feed = await deployProxy("ProductPriceFeed", [...args])
    expect((await feed.minExpectedAnswer()).toString()).to.equal("50000000")
    expect((await feed.maxExpectedAnswer()).toString()).to.equal("900000000")
    expect((await feed.maxDeviationBps()).toString()).to.equal("0")
    expect((await feed.healthyDiff()).toString()).to.equal("7200")
    expect((await feed.getDataInBase18()).toString()).to.equal(ethers.utils.parseUnits("1.5", 18).toString())
  })

  it("defaults deploy a working feed (min 0 behaves like the built-ins' min 1: answers must be > 0)", async () => {
    const [admin] = await ethers.getSigners()
    const feed = await deployProxy("ProductPriceFeed", [...priceFeedInitializerArgs(DEPLOY_PARAMS_DEFAULTS, admin.address)])
    expect((await feed.maxDeviationBps()).toString()).to.equal("0")
    expect((await feed.maxExpectedAnswer()).toString()).to.equal(DEPLOY_PARAMS_DEFAULTS.feedMaxAnswer)
    expect((await feed.getDataInBase18()).toString()).to.equal(ethers.utils.parseUnits("1", 18).toString())
  })
})
