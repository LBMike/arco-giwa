import assert from "assert/strict"
import hre from "hardhat"
import type { Contract, ContractReceipt } from "ethers"
import { deployStocks, type StocksDeployment } from "../../scripts/stocks/deploy"

const ONE = hre.ethers.BigNumber.from("1000000000")
const CASH = hre.ethers.BigNumber.from("120000000")
const ZERO = hre.ethers.constants.AddressZero
const ZERO_ID = hre.ethers.constants.HashZero
const key = (value: string) => hre.ethers.utils.sha256(hre.ethers.utils.toUtf8Bytes(value))
const eventTopic = (text: string) => hre.ethers.utils.id(text)
const equal = (actual: { toString(): string }, expected: { toString(): string }) =>
  assert.equal(actual.toString(), expected.toString())
async function reject(call: Promise<unknown>, reason: string) {
  await assert.rejects(call, (error: any) => String(error.message).includes(reason), reason)
}
function events(receipt: ContractReceipt, contract: Contract, name: string) {
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === contract.address.toLowerCase())
    .flatMap((log) => {
      const parsed = contract.interface.parseLog(log)
      return parsed.name === name ? [parsed] : []
    })
}

describe("GIWA Stocks non-upgradeable test contracts", () => {
  let d: StocksDeployment
  beforeEach(async () => {
    d = await deployStocks(hre, "a".repeat(64))
  })

  async function fund(amount = CASH) {
    const { cash, vault } = d.contracts
    const { holder, faucetOperator } = d.signers
    await (await cash.connect(faucetOperator).faucet(holder.address, amount)).wait()
    await (await cash.connect(holder).approve(vault.address, amount)).wait()
    return (await vault.connect(holder).depositForOrder(key("buy-1"), amount)).wait()
  }
  async function mint(quantity = ONE, recipient = d.signers.holder.address, operation = "mint-1") {
    const { controller, stock } = d.contracts
    return (
      await controller
        .connect(d.signers.operator)
        .mintForOperation(key(operation), stock.address, recipient, quantity)
    ).wait()
  }
  async function escrow(quantity = ONE, order = "sell-1", signer = d.signers.holder) {
    const { escrow: custody, stock } = d.contracts
    await (await stock.connect(signer).approve(custody.address, quantity)).wait()
    const receipt = await (
      await custody.connect(signer).escrowForOrder(key(order), stock.address, quantity)
    ).wait()
    const id = hre.ethers.utils.keccak256(
      hre.ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "address", "address"],
        [key(order), signer.address, stock.address],
      ),
    )
    return { id, receipt }
  }

  it("pins chain, test labels, scales, code hashes and constructor relationships in v2 manifest", async () => {
    const { manifest, contracts: c, signers: s } = d
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.chainId, 91342)
    assert.equal(await c.cash.symbol(), "ARCO_TEST_USDC")
    assert.equal(await c.stock.symbol(), "ARCO_TEST_NVDA")
    assert.equal(await c.cash.decimals(), 6)
    assert.equal(await c.stock.decimals(), 9)
    assert.equal(await c.cash.faucetOperator(), s.faucetOperator.address)
    assert.equal(await c.stock.mintController(), c.controller.address)
    assert.equal(await c.stock.redemptionEscrow(), c.escrow.address)
    assert.equal(await c.vault.cashToken(), c.cash.address)
    assert.equal(await c.vault.redemptionEscrow(), c.escrow.address)
    assert.equal(await c.controller.stockToken(), c.stock.address)
    assert.equal(await c.escrow.stockToken(), c.stock.address)
    assert.equal(await c.escrow.cashToken(), c.cash.address)
    assert.equal(await c.escrow.fundingVault(), c.vault.address)
    for (const contract of Object.values(c)) {
      assert.equal(
        manifest.codeHashes[contract.address.toLowerCase()],
        hre.ethers.utils.keccak256(await hre.ethers.provider.getCode(contract.address)),
      )
    }
  })

  it("enforces explicit faucet authority and rejects zero faucet inputs", async () => {
    const { cash } = d.contracts
    const { operator, holder, faucetOperator } = d.signers
    await reject(cash.connect(operator).faucet(holder.address, CASH), "STOCKS_UNAUTHORIZED")
    await reject(cash.connect(faucetOperator).faucet(ZERO, CASH), "STOCKS_ZERO_ADDRESS")
    await reject(cash.connect(faucetOperator).faucet(holder.address, 0), "STOCKS_ZERO_AMOUNT")
    equal(await cash.totalSupply(), 0)
  })

  it("requires approval and records exact incoming cash movement with frozen funding ABI", async () => {
    const { cash, vault } = d.contracts
    const { holder, faucetOperator } = d.signers
    await (await cash.connect(faucetOperator).faucet(holder.address, CASH)).wait()
    await reject(
      vault.connect(holder).depositForOrder(key("order"), CASH),
      "insufficient allowance",
    )
    const receipt = await fund()
    const event = events(receipt, vault, "FundingReceived")[0]
    assert.equal(event.topic, eventTopic("FundingReceived(bytes32,address,address,uint256)"))
    assert.equal(event.args.orderKey, key("buy-1"))
    assert.equal(event.args.payer, holder.address)
    assert.equal(event.args.token, cash.address)
    equal(event.args.amount, CASH)
    const transfer = events(receipt, cash, "Transfer")[0]
    assert.equal(transfer.args.from, holder.address)
    assert.equal(transfer.args.to, vault.address)
    equal(transfer.args.value, CASH)
  })

  it("rejects zero funding amount and empty order key", async () => {
    await reject(d.contracts.vault.depositForOrder(key("order"), 0), "STOCKS_ZERO_AMOUNT")
    await reject(d.contracts.vault.depositForOrder(ZERO_ID, CASH), "STOCKS_ZERO_ORDER")
  })

  it("preserves repeated funding facts rather than silently consuming another deposit", async () => {
    const first = await fund()
    const second = await fund()
    assert.equal(events(first, d.contracts.vault, "FundingReceived").length, 1)
    assert.equal(events(second, d.contracts.vault, "FundingReceived").length, 1)
    equal(await d.contracts.cash.balanceOf(d.contracts.vault.address), CASH.mul(2))
  })

  it("only designated controller can issue and only its operator can request issuance", async () => {
    const { controller, stock } = d.contracts
    const { holder, operator } = d.signers
    await reject(stock.connect(holder).mintTo(holder.address, ONE), "STOCKS_UNAUTHORIZED")
    await reject(stock.connect(operator).mintTo(holder.address, ONE), "STOCKS_UNAUTHORIZED")
    await reject(
      controller.connect(holder).mintForOperation(key("mint"), stock.address, holder.address, ONE),
      "STOCKS_UNAUTHORIZED",
    )
    equal(await stock.totalSupply(), 0)
  })

  it("mint uses exact frozen event ABI including zero-address Transfer topic", async () => {
    const receipt = await mint()
    const { stock, controller } = d.contracts
    const event = events(receipt, controller, "StockMinted")[0]
    assert.equal(event.topic, eventTopic("StockMinted(bytes32,address,address,uint256)"))
    assert.equal(event.args.operationId, key("mint-1"))
    assert.equal(event.args.token, stock.address)
    assert.equal(event.args.recipient, d.signers.holder.address)
    equal(event.args.quantity, ONE)
    const transfer = receipt.logs.find(
      (log: any) =>
        log.address === stock.address &&
        log.topics[0] === eventTopic("Transfer(address,address,uint256)"),
    )!
    assert.equal(transfer.topics[1], ZERO_ID)
    equal(await stock.balanceOf(d.signers.holder.address), ONE)
  })

  it("mint replay moves no value; conflicting quantity, recipient or token reverts", async () => {
    await mint()
    const { controller, stock, cash } = d.contracts
    const { operator, holder, otherHolder } = d.signers
    const replay = await mint()
    assert.equal(replay.logs.length, 0)
    equal(await stock.totalSupply(), ONE)
    await reject(
      controller
        .connect(operator)
        .mintForOperation(key("mint-1"), stock.address, holder.address, ONE.add(1)),
      "STOCKS_OPERATION_CONFLICT",
    )
    await reject(
      controller
        .connect(operator)
        .mintForOperation(key("mint-1"), stock.address, otherHolder.address, ONE),
      "STOCKS_OPERATION_CONFLICT",
    )
    await reject(
      controller
        .connect(operator)
        .mintForOperation(key("mint-1"), cash.address, holder.address, ONE),
      "STOCKS_WRONG_TOKEN",
    )
  })

  it("rejects invalid mint identity, quantity, zero recipient and custody recipient", async () => {
    const { controller, stock, escrow: custody } = d.contracts
    const { operator, holder } = d.signers
    const c = controller.connect(operator)
    await reject(
      c.mintForOperation(ZERO_ID, stock.address, holder.address, ONE),
      "STOCKS_ZERO_OPERATION",
    )
    await reject(
      c.mintForOperation(key("m"), stock.address, holder.address, 0),
      "STOCKS_ZERO_AMOUNT",
    )
    await reject(c.mintForOperation(key("m"), stock.address, ZERO, ONE), "STOCKS_ZERO_ADDRESS")
    await reject(
      c.mintForOperation(key("m"), stock.address, custody.address, ONE),
      "STOCKS_CUSTODY_RECIPIENT",
    )
    equal(await stock.totalSupply(), 0)
  })

  it("forbids ordinary transfers, approved third-party transfers and holder direct burns", async () => {
    await mint()
    const { stock, escrow: custody } = d.contracts
    const { holder, otherHolder } = d.signers
    await reject(
      stock.connect(holder).transfer(otherHolder.address, ONE),
      "STOCKS_RESTRICTED_TRANSFER",
    )
    await reject(stock.connect(holder).transfer(custody.address, ONE), "STOCKS_RESTRICTED_TRANSFER")
    await (await stock.connect(holder).approve(otherHolder.address, ONE)).wait()
    await reject(
      stock.connect(otherHolder).transferFrom(holder.address, custody.address, ONE),
      "STOCKS_RESTRICTED_TRANSFER",
    )
    await reject(stock.connect(holder).burnEscrow(ONE), "STOCKS_UNAUTHORIZED")
    await reject(stock.connect(holder).escrowFrom(holder.address, ONE), "STOCKS_UNAUTHORIZED")
    await reject(stock.connect(holder).returnFromEscrow(holder.address, ONE), "STOCKS_UNAUTHORIZED")
    equal(await stock.balanceOf(holder.address), ONE)
  })

  it("refund requires operator and replays without another transfer", async () => {
    await fund()
    const { vault, cash } = d.contracts
    const { operator, holder, otherHolder } = d.signers
    await reject(
      vault.connect(holder).refundForOperation(key("r"), holder.address, CASH),
      "STOCKS_UNAUTHORIZED",
    )
    const receipt = await (
      await vault.connect(operator).refundForOperation(key("r"), holder.address, CASH)
    ).wait()
    const event = events(receipt, vault, "FundingRefunded")[0]
    assert.equal(event.topic, eventTopic("FundingRefunded(bytes32,address,uint256)"))
    assert.equal(event.args.recipient, holder.address)
    equal(event.args.amount, CASH)
    const replay = await (
      await vault.connect(operator).refundForOperation(key("r"), holder.address, CASH)
    ).wait()
    assert.equal(replay.logs.length, 0)
    await reject(
      vault.connect(operator).refundForOperation(key("r"), otherHolder.address, CASH),
      "STOCKS_OPERATION_CONFLICT",
    )
    await reject(
      vault.connect(operator).refundForOperation(key("r"), holder.address, CASH.sub(1)),
      "STOCKS_OPERATION_CONFLICT",
    )
    equal(await cash.balanceOf(holder.address), CASH)
    equal(await cash.balanceOf(vault.address), 0)
  })

  it("cannot invoke redemption payout directly, even as ordinary operator", async () => {
    await fund()
    const { vault } = d.contracts
    for (const signer of [d.signers.holder, d.signers.operator, d.signers.deployer]) {
      await reject(
        vault.connect(signer).payoutRedemption(key("p"), key("e"), signer.address, CASH),
        "STOCKS_UNAUTHORIZED",
      )
    }
  })

  it("refund failure rolls back the operation identity for a later funded retry", async () => {
    const { vault } = d.contracts
    const { operator, holder } = d.signers
    await reject(
      vault.connect(operator).refundForOperation(key("r"), holder.address, CASH),
      "transfer amount exceeds balance",
    )
    assert.equal(await vault.operationPayloads(key("r")), ZERO_ID)
    await fund()
    await (await vault.connect(operator).refundForOperation(key("r"), holder.address, CASH)).wait()
    assert.notEqual(await vault.operationPayloads(key("r")), ZERO_ID)
  })

  it("escrow requires holder approval and records exact payer-bound identity", async () => {
    await mint()
    const { escrow: custody, stock } = d.contracts
    const { holder } = d.signers
    await reject(
      custody.connect(holder).escrowForOrder(key("sell-1"), stock.address, ONE),
      "insufficient allowance",
    )
    const { id, receipt } = await escrow()
    const event = events(receipt, custody, "StockEscrowed")[0]
    assert.equal(event.topic, eventTopic("StockEscrowed(bytes32,bytes32,address,address,uint256)"))
    assert.equal(event.args.escrowId, id)
    assert.equal(event.args.orderKey, key("sell-1"))
    assert.equal(event.args.payer, holder.address)
    assert.equal(event.args.token, stock.address)
    equal(event.args.quantity, ONE)
    const record = await custody.escrows(id)
    assert.equal(record.payer, holder.address)
    equal(record.state, 1)
    equal(await stock.balanceOf(holder.address), 0)
    equal(await stock.balanceOf(custody.address), ONE)
    equal(await stock.totalSupply(), ONE)
  })

  it("rejects zero escrow, unsupported token and duplicate composite identity", async () => {
    await mint()
    const { escrow: custody, stock, cash } = d.contracts
    const e = custody.connect(d.signers.holder)
    await reject(e.escrowForOrder(ZERO_ID, stock.address, ONE), "STOCKS_ZERO_ORDER")
    await reject(e.escrowForOrder(key("sell-1"), stock.address, 0), "STOCKS_ZERO_AMOUNT")
    await reject(e.escrowForOrder(key("sell-1"), cash.address, ONE), "STOCKS_WRONG_TOKEN")
    await escrow()
    await reject(
      e.escrowForOrder(key("sell-1"), stock.address, ONE),
      "STOCKS_ESCROW_ALREADY_EXISTS",
    )
  })

  it("another payer cannot poison the holder's order key", async () => {
    await mint()
    await mint(ONE, d.signers.otherHolder.address, "mint-2")
    const first = await escrow(ONE, "same-order", d.signers.otherHolder)
    const second = await escrow(ONE, "same-order", d.signers.holder)
    assert.notEqual(first.id, second.id)
    const a = await d.contracts.escrow.escrows(first.id)
    const b = await d.contracts.escrow.escrows(second.id)
    assert.equal(a.payer, d.signers.otherHolder.address)
    assert.equal(b.payer, d.signers.holder.address)
    equal(await d.contracts.stock.balanceOf(d.contracts.escrow.address), ONE.mul(2))
  })

  it("operator settlement atomically burns stock and pays exact original payer cash", async () => {
    await fund()
    await mint()
    const { id } = await escrow()
    const { escrow: custody, cash, stock, vault } = d.contracts
    const { operator, holder } = d.signers
    const receipt = await (
      await custody.connect(operator).settleRedemption(key("redeem-1"), id, CASH)
    ).wait()
    const event = events(receipt, custody, "StockRedeemed")[0]
    assert.equal(
      event.topic,
      eventTopic("StockRedeemed(bytes32,bytes32,address,address,uint256,address,uint256)"),
    )
    assert.equal(event.args.operationId, key("redeem-1"))
    assert.equal(event.args.escrowId, id)
    assert.equal(event.args.recipient, holder.address)
    assert.equal(event.args.token, stock.address)
    assert.equal(event.args.cashToken, cash.address)
    equal(event.args.quantity, ONE)
    equal(event.args.cashAmount, CASH)
    const burn = events(receipt, stock, "Transfer")[0]
    assert.equal(burn.args.from, custody.address)
    assert.equal(burn.args.to, ZERO)
    equal(burn.args.value, ONE)
    const pay = events(receipt, cash, "Transfer")[0]
    assert.equal(pay.args.from, vault.address)
    assert.equal(pay.args.to, holder.address)
    equal(pay.args.value, CASH)
    equal(await stock.totalSupply(), 0)
    equal(await stock.balanceOf(custody.address), 0)
    equal(await cash.balanceOf(holder.address), CASH)
    equal((await custody.escrows(id)).state, 2)
  })

  it("settlement is operator-only and cannot redirect recipient", async () => {
    await fund()
    await mint()
    const { id } = await escrow()
    for (const signer of [d.signers.holder, d.signers.otherHolder, d.signers.deployer]) {
      await reject(
        d.contracts.escrow.connect(signer).settleRedemption(key("r"), id, CASH),
        "STOCKS_UNAUTHORIZED",
      )
    }
    assert.equal(d.contracts.escrow.interface.getFunction("settleRedemption").inputs.length, 3)
  })

  it("replayed settlement is no-op; changed cash, cross-action reuse and second operation revert", async () => {
    await fund()
    await mint()
    const { id } = await escrow()
    const e = d.contracts.escrow.connect(d.signers.operator)
    await (await e.settleRedemption(key("r"), id, CASH)).wait()
    const replay = await (await e.settleRedemption(key("r"), id, CASH)).wait()
    assert.equal(replay.logs.length, 0)
    await reject(e.settleRedemption(key("r"), id, CASH.add(1)), "STOCKS_OPERATION_CONFLICT")
    await reject(e.returnEscrowForOperation(key("r"), id), "STOCKS_OPERATION_CONFLICT")
    await reject(e.settleRedemption(key("r2"), id, CASH), "STOCKS_ESCROW_CLOSED")
    await reject(e.returnEscrowForOperation(key("return"), id), "STOCKS_ESCROW_CLOSED")
    assert.equal(await e.operationPayloads(key("r2")), ZERO_ID)
  })

  it("insufficient cash rolls back burn, supply, state and both operation registries", async () => {
    await mint()
    const { id } = await escrow()
    const { escrow: custody, stock, vault } = d.contracts
    const e = custody.connect(d.signers.operator)
    await reject(e.settleRedemption(key("r"), id, CASH), "transfer amount exceeds balance")
    equal(await stock.totalSupply(), ONE)
    equal(await stock.balanceOf(custody.address), ONE)
    equal((await custody.escrows(id)).state, 1)
    assert.equal(await custody.operationPayloads(key("r")), ZERO_ID)
    assert.equal(await vault.operationPayloads(key("r")), ZERO_ID)
    await fund()
    await (await e.settleRedemption(key("r"), id, CASH)).wait()
    equal(await stock.totalSupply(), 0)
  })

  it("vault cross-action operation collision rolls back an attempted burn", async () => {
    await fund(CASH.mul(2))
    await mint()
    const { id } = await escrow()
    const { escrow: custody, stock, vault } = d.contracts
    const { operator, holder } = d.signers
    await (
      await vault.connect(operator).refundForOperation(key("same"), holder.address, CASH)
    ).wait()
    await reject(
      custody.connect(operator).settleRedemption(key("same"), id, CASH),
      "STOCKS_OPERATION_CONFLICT",
    )
    equal(await stock.totalSupply(), ONE)
    equal((await custody.escrows(id)).state, 1)
    assert.equal(await custody.operationPayloads(key("same")), ZERO_ID)
  })

  it("returns full recorded escrow only to original payer without changing supply", async () => {
    await mint()
    const { id } = await escrow()
    const { escrow: custody, stock } = d.contracts
    const { operator, holder } = d.signers
    await reject(
      custody.connect(holder).returnEscrowForOperation(key("return"), id),
      "STOCKS_UNAUTHORIZED",
    )
    const receipt = await (
      await custody.connect(operator).returnEscrowForOperation(key("return"), id)
    ).wait()
    const event = events(receipt, custody, "StockReturned")[0]
    assert.equal(event.topic, eventTopic("StockReturned(bytes32,bytes32,address,address,uint256)"))
    assert.equal(event.args.recipient, holder.address)
    equal(event.args.quantity, ONE)
    equal(await stock.balanceOf(holder.address), ONE)
    equal(await stock.balanceOf(custody.address), 0)
    equal(await stock.totalSupply(), ONE)
    equal((await custody.escrows(id)).state, 3)
  })

  it("return wins before settlement; replay, cross-action and distinct-operation attempts cannot spend custody twice", async () => {
    await fund()
    await mint()
    const { id } = await escrow()
    const e = d.contracts.escrow.connect(d.signers.operator)
    await (await e.returnEscrowForOperation(key("return"), id)).wait()
    const replay = await (await e.returnEscrowForOperation(key("return"), id)).wait()
    assert.equal(replay.logs.length, 0)
    await reject(e.settleRedemption(key("return"), id, CASH), "STOCKS_OPERATION_CONFLICT")
    await reject(e.settleRedemption(key("settle"), id, CASH), "STOCKS_ESCROW_CLOSED")
    await reject(e.returnEscrowForOperation(key("return-2"), id), "STOCKS_ESCROW_CLOSED")
    await reject(
      d.contracts.escrow
        .connect(d.signers.holder)
        .escrowForOrder(key("sell-1"), d.contracts.stock.address, ONE),
      "STOCKS_ESCROW_ALREADY_EXISTS",
    )
  })

  it("operation identity cannot be reused for another escrow", async () => {
    await mint(ONE.mul(2))
    const first = await escrow(ONE, "sell-1")
    const second = await escrow(ONE, "sell-2")
    const e = d.contracts.escrow.connect(d.signers.operator)
    await (await e.returnEscrowForOperation(key("r"), first.id)).wait()
    await reject(e.returnEscrowForOperation(key("r"), second.id), "STOCKS_OPERATION_CONFLICT")
    equal((await e.escrows(second.id)).state, 1)
  })

  for (const first of ["settle", "return"] as const) {
    it(`mines concurrent ${first}-first competing transactions with exactly one terminal custody outcome`, async () => {
      await fund()
      await mint()
      const { id } = await escrow()
      const { escrow: custody, stock, cash, vault } = d.contracts
      const { operator, holder } = d.signers
      const e = custody.connect(operator)
      const nonce = await operator.getTransactionCount("pending")
      await hre.network.provider.send("evm_setAutomine", [false])
      let successfulHash = ""
      let failedHash = ""
      try {
        const a =
          first === "settle"
            ? await e.settleRedemption(key("race-settle"), id, CASH, { nonce, gasLimit: 1000000 })
            : await e.returnEscrowForOperation(key("race-return"), id, { nonce, gasLimit: 1000000 })
        const b =
          first === "settle"
            ? await e.returnEscrowForOperation(key("race-return"), id, {
                nonce: nonce + 1,
                gasLimit: 1000000,
              })
            : await e.settleRedemption(key("race-settle"), id, CASH, {
                nonce: nonce + 1,
                gasLimit: 1000000,
              })
        successfulHash = a.hash
        failedHash = b.hash
        await hre.network.provider.send("evm_mine")
      } finally {
        await hre.network.provider.send("evm_setAutomine", [true])
      }
      assert.equal((await hre.ethers.provider.getTransactionReceipt(successfulHash)).status, 1)
      assert.equal((await hre.ethers.provider.getTransactionReceipt(failedHash)).status, 0)
      equal((await custody.escrows(id)).state, first === "settle" ? 2 : 3)
      equal(await stock.balanceOf(custody.address), 0)
      equal(await stock.totalSupply(), first === "settle" ? 0 : ONE)
      equal(await stock.balanceOf(holder.address), first === "settle" ? 0 : ONE)
      equal(await cash.balanceOf(holder.address), first === "settle" ? CASH : 0)
      equal(await cash.balanceOf(vault.address), first === "settle" ? 0 : CASH)
    })
  }

  it("unknown custody, zero settlement amount and zero operation are rejected", async () => {
    await mint()
    const { id } = await escrow()
    const e = d.contracts.escrow.connect(d.signers.operator)
    await reject(e.settleRedemption(key("r"), key("unknown"), CASH), "STOCKS_UNKNOWN_ESCROW")
    await reject(e.returnEscrowForOperation(key("r"), key("unknown")), "STOCKS_UNKNOWN_ESCROW")
    await reject(e.settleRedemption(key("r"), id, 0), "STOCKS_ZERO_AMOUNT")
    await reject(e.settleRedemption(ZERO_ID, id, CASH), "STOCKS_ZERO_OPERATION")
    await reject(e.returnEscrowForOperation(ZERO_ID, id), "STOCKS_ZERO_OPERATION")
  })

  it("conserves exact integer cash and supply across fractional buy, return, redemption and replay sequences", async () => {
    const quantities = ["1", "333333333", "999999999", "2500000000", "1000000001"]
    let issued = hre.ethers.BigNumber.from(0)
    let redeemed = hre.ethers.BigNumber.from(0)
    let paid = hre.ethers.BigNumber.from(0)
    const totalCash = CASH.mul(100)
    await fund(totalCash)
    for (let i = 0; i < quantities.length; i++) {
      const quantity = hre.ethers.BigNumber.from(quantities[i])
      await mint(quantity, d.signers.holder.address, `mint-${i}`)
      issued = issued.add(quantity)
      const { id } = await escrow(quantity, `sell-${i}`)
      const e = d.contracts.escrow.connect(d.signers.operator)
      if (i % 2 === 0) {
        await (await e.returnEscrowForOperation(key(`return-${i}`), id)).wait()
        await (await e.returnEscrowForOperation(key(`return-${i}`), id)).wait()
      } else {
        const amount = quantity.mul(CASH).div(ONE)
        await (await e.settleRedemption(key(`settle-${i}`), id, amount)).wait()
        await (await e.settleRedemption(key(`settle-${i}`), id, amount)).wait()
        redeemed = redeemed.add(quantity)
        paid = paid.add(amount)
      }
      equal(await d.contracts.stock.totalSupply(), issued.sub(redeemed))
      equal(await d.contracts.stock.balanceOf(d.signers.holder.address), issued.sub(redeemed))
      equal(await d.contracts.stock.balanceOf(d.contracts.escrow.address), 0)
      equal(await d.contracts.cash.balanceOf(d.contracts.vault.address), totalCash.sub(paid))
      equal(await d.contracts.cash.balanceOf(d.signers.holder.address), paid)
    }
  })

  it("rejects zero roles and mismatched immutable deployment relationships", async () => {
    const f = (name: string) => hre.ethers.getContractFactory(name)
    const { operator, holder } = d.signers
    await reject((await f("StocksTestCash")).deploy(ZERO), "STOCKS_ZERO_ADDRESS")
    await reject((await f("StocksToken")).deploy(ZERO, holder.address), "STOCKS_ZERO_ADDRESS")
    await reject(
      (await f("StocksToken")).deploy(holder.address, holder.address),
      "STOCKS_OVERLAPPING_ROLES",
    )
    await reject(
      (await f("StocksMintController")).deploy(ZERO, d.contracts.stock.address),
      "STOCKS_ZERO_ADDRESS",
    )
    await reject(
      (await f("StocksFundingVault")).deploy(
        holder.address,
        operator.address,
        d.contracts.escrow.address,
      ),
      "STOCKS_CASH_NOT_CONTRACT",
    )
    await reject(
      (await f("StocksRedemptionEscrow")).deploy(
        operator.address,
        d.contracts.stock.address,
        d.contracts.vault.address,
      ),
      "STOCKS_ESCROW_MISMATCH",
    )
  })
})
