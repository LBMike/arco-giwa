import { expect } from "chai"
import { ethers } from "hardhat"
import { deployProxy, expectRevert, parse, ROLES } from "./helpers"

const str = (value: { toString(): string }) => value.toString()

const BLACKLIST_OPERATOR_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("BLACKLIST_OPERATOR_ROLE"))
const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero

async function tokenFixture() {
  const [admin, minter, alice, bob] = await ethers.getSigners()
  const arco = await deployProxy("ArcoUSD", [admin.address])
  await arco.grantRole(ROLES.MINTER_ROLE, minter.address)
  await arco.grantRole(ROLES.BURNER_ROLE, minter.address)
  return { admin, minter, alice, bob, arco }
}

describe("ArcoUSD token", () => {
  it("is an 18-decimal ArcoUSD whose admin can neither mint nor burn", async () => {
    const { admin, arco } = await tokenFixture()
    expect(await arco.name()).to.equal("ArcoUSD")
    expect(await arco.symbol()).to.equal("ArcoUSD")
    expect(await arco.decimals()).to.equal(18)
    expect(await arco.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
    expect(await arco.hasRole(BLACKLIST_OPERATOR_ROLE, admin.address)).to.equal(true)
    expect(await arco.hasRole(ROLES.PAUSER_ROLE, admin.address)).to.equal(true)
    expect(await arco.hasRole(ROLES.MINTER_ROLE, admin.address)).to.equal(false)
    expect(await arco.hasRole(ROLES.BURNER_ROLE, admin.address)).to.equal(false)
    await expectRevert(arco.mint(admin.address, 1), "missing role")
  })

  it("burn only ever burns the caller's own balance", async () => {
    const { minter, alice, arco } = await tokenFixture()
    await arco.connect(minter).mint(alice.address, parse("10", 18))
    await arco.connect(minter).mint(minter.address, parse("3", 18))
    await arco.connect(minter).burn(parse("3", 18))
    expect((await arco.balanceOf(minter.address)).toString()).to.equal("0")
    expect((await arco.balanceOf(alice.address)).toString()).to.equal(parse("10", 18).toString())
    // There is no burn(from, amount): the burner cannot erase alice's tokens.
    expect((arco as any)["burn(address,uint256)"]).to.equal(undefined)
    await expectRevert(arco.connect(alice).burn(1), "missing role")
  })

  it("blacklisted addresses cannot send or receive; pause stops mint/burn but never transfers", async () => {
    const { admin, minter, alice, bob, arco } = await tokenFixture()
    await arco.connect(minter).mint(alice.address, parse("10", 18))
    await arco.blacklist(bob.address)
    await expectRevert(arco.connect(alice).transfer(bob.address, 1), "MAC: blacklisted")
    await arco.unBlacklist(bob.address)
    await arco.connect(alice).transfer(bob.address, 1)
    await arco.blacklist(alice.address)
    await expectRevert(arco.connect(alice).transfer(bob.address, 1), "MAC: blacklisted")
    await arco.unBlacklist(alice.address)

    await arco.connect(admin).pause()
    await expectRevert(arco.connect(minter).mint(alice.address, 1), "FP: paused")
    await expectRevert(arco.connect(minter).burn(0), "FP: paused")
    await arco.connect(alice).transfer(bob.address, 1) // DeFi transfers keep working
    await arco.connect(admin).unpause()
    await arco.connect(minter).mint(alice.address, 1)
  })

  it("a blacklisted spender cannot use an old allowance", async () => {
    const { admin, minter, alice, bob, arco } = await tokenFixture()
    await arco.connect(minter).mint(alice.address, parse("10", 18))
    await arco.connect(alice).approve(bob.address, parse("5", 18))
    await arco.connect(admin).blacklist(bob.address)
    await expectRevert(arco.connect(bob).transferFrom(alice.address, admin.address, 1), "MAC: blacklisted")
  })

  it("TRUST: the admin can still grant itself MINTER — mainnet admin must be a timelocked multisig", async () => {
    const { admin, alice, arco } = await tokenFixture()
    await arco.grantRole(ROLES.MINTER_ROLE, admin.address)
    await arco.mint(alice.address, 1)
    expect(str(await arco.balanceOf(alice.address))).to.equal("1")
  })

  it("supports EIP-2612 permit", async () => {
    const { minter, alice, bob, arco } = await tokenFixture()
    await arco.connect(minter).mint(alice.address, parse("5", 18))
    const { chainId } = await ethers.provider.getNetwork()
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600
    const value = parse("2", 18)
    const signature = await alice._signTypedData(
      { name: "ArcoUSD", version: "1", chainId, verifyingContract: arco.address },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { owner: alice.address, spender: bob.address, value, nonce: 0, deadline },
    )
    const { v, r, s } = ethers.utils.splitSignature(signature)
    await arco.connect(bob).permit(alice.address, bob.address, value, deadline, v, r, s)
    expect((await arco.allowance(alice.address, bob.address)).toString()).to.equal(value.toString())
    await arco.connect(bob).transferFrom(alice.address, bob.address, value)
    expect((await arco.balanceOf(bob.address)).toString()).to.equal(value.toString())
  })
})
