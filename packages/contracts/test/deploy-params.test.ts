import { expect } from "chai"
import { VAULT_CATEGORIES as SHARED_CATEGORIES } from "../../../shared/vault-taxonomy"
import {
  DEPLOY_PARAMS_DEFAULTS,
  VAULT_CATEGORIES as PARAMS_CATEGORIES,
  validateDeployParams,
  type DeployParamsFile,
} from "../scripts/deploy-params"
import { PRODUCTS, buildDeploySteps, deploymentPreview, remainingSteps } from "../scripts/deploy-plan"
import { BigNumber } from "ethers"

const RESERVED_IDS = PRODUCTS.map((product) => product.productId)
const RESERVED_SYMBOLS = PRODUCTS.map((product) => product.symbol)

function goodParams(): DeployParamsFile {
  return {
    schemaVersion: 1,
    products: [
      {
        productId: "agold",
        symbol: "aGOLD",
        name: "Arco GOLD",
        paymentAssetSymbol: "tUSDC",
        category: "Prime Credit",
      },
    ],
  }
}

describe("deploy-params (2c-2 shared schema)", () => {
  it("category enum IS the shared taxonomy constant (single source, exact strings)", () => {
    expect(PARAMS_CATEGORIES).to.equal(SHARED_CATEGORIES) // same module object, not a copy
    expect([...SHARED_CATEGORIES]).to.deep.equal(["U.S Treasuries", "Prime Credit", "Arco Saving"])
  })

  it("accepts a valid file and applies launch-parity defaults", () => {
    const result = validateDeployParams(goodParams(), RESERVED_IDS, RESERVED_SYMBOLS)
    expect(result.ok, result.errors.join("; ")).to.equal(true)
    expect(result.parsed?.products[0].productId).to.equal("agold")
    expect(DEPLOY_PARAMS_DEFAULTS.maxSupplyCapShares).to.equal("1000000")
    expect(DEPLOY_PARAMS_DEFAULTS.vaultMintAllowanceShares).to.equal("500000")
    expect(DEPLOY_PARAMS_DEFAULTS.feedInitialAnswer).to.equal("100000000")
    expect(DEPLOY_PARAMS_DEFAULTS.feedHealthyDiffSeconds).to.equal(3600)
  })

  it("fails fast on bad shape, unknown asset, off-taxonomy category, duplicates, bad numbers", () => {
    expect(validateDeployParams(null, RESERVED_IDS, RESERVED_SYMBOLS).ok).to.equal(false)
    expect(validateDeployParams({ schemaVersion: 2, products: [] }, RESERVED_IDS, RESERVED_SYMBOLS).ok).to.equal(false)

    const badAsset = goodParams()
    ;(badAsset.products[0] as any).paymentAssetSymbol = "tDOGE"
    expect(validateDeployParams(badAsset, RESERVED_IDS, RESERVED_SYMBOLS).errors.join()).to.match(/paymentAssetSymbol/)

    const badCategory = goodParams()
    ;(badCategory.products[0] as any).category = "U.S. Treasuries" // period form is display-only, NOT canonical
    expect(validateDeployParams(badCategory, RESERVED_IDS, RESERVED_SYMBOLS).errors.join()).to.match(/category/)

    const duplicate = goodParams()
    duplicate.products[0].productId = "acapix"
    expect(validateDeployParams(duplicate, RESERVED_IDS, RESERVED_SYMBOLS).errors.join()).to.match(/duplicates/)

    const badNumber = goodParams()
    duplicateSafeInit(badNumber).feedInitialAnswer = "1.5"
    expect(validateDeployParams(badNumber, RESERVED_IDS, RESERVED_SYMBOLS).errors.join()).to.match(/feedInitialAnswer/)

    const badHealthy = goodParams()
    ;(duplicateSafeInit(badHealthy) as any).feedHealthyDiffSeconds = 0
    expect(validateDeployParams(badHealthy, RESERVED_IDS, RESERVED_SYMBOLS).errors.join()).to.match(/feedHealthyDiffSeconds/)

    const unknownKey = goodParams()
    ;(duplicateSafeInit(badHealthy), (unknownKey.products[0].init = { nope: "1" } as any))
    expect(validateDeployParams(unknownKey, RESERVED_IDS, RESERVED_SYMBOLS).errors.join()).to.match(/not a recognised/)
  })

  it("merged plan adds exactly 12 correctly-keyed steps and resumes past the built-ins", () => {
    const extra = { productId: "agold", symbol: "aGOLD", name: "Arco GOLD", paymentAssetSymbol: "tUSDC" as const }
    const baseSteps = buildDeploySteps()
    const mergedSteps = buildDeploySteps([...PRODUCTS, extra])
    expect(mergedSteps.length).to.equal(baseSteps.length + 12)

    const extraSteps = mergedSteps.filter((step) => step.productId === "agold")
    expect(extraSteps.length).to.equal(12)
    expect(extraSteps.filter((step) => step.type === "proxy").length).to.equal(4)
    expect(extraSteps.filter((step) => step.type === "grant").length).to.equal(8)
    expect(extraSteps.some((step) => step.key === "proxy:product:agold:depositVault")).to.equal(true)

    // A registry that has fully recorded the built-in deployment leaves ONLY the new
    // product's 12 steps — the resume logic needs no changes for extras.
    const recordedRegistry = {
      deploymentRecords: baseSteps.filter((step) => step.type === "proxy").map((step) => ({ key: step.key })),
      roleGrants: baseSteps.filter((step) => step.type === "grant").map((step) => ({ key: step.key })),
    }
    const remaining = remainingSteps(recordedRegistry, mergedSteps)
    expect(remaining.length).to.equal(12)
    expect(remaining.every((step) => step.productId === "agold")).to.equal(true)

    // DRY-RUN preview path (pure, no network/broadcast) reflects the merged plan.
    const preview = deploymentPreview("0x0000000000000000000000000000000000000001", BigNumber.from(1), recordedRegistry, [
      ...PRODUCTS,
      extra,
    ])
    expect(preview.contractCounts.productTokens).to.equal(PRODUCTS.length + 1)
    expect(preview.resumability.remainingSteps).to.equal(12)
    expect((preview.productPaymentMappings as Record<string, string>).aGOLD).to.equal("tUSDC")
  })
})

function duplicateSafeInit(file: DeployParamsFile) {
  file.products[0].init = file.products[0].init ?? {}
  return file.products[0].init as Record<string, unknown>
}
