import assert from "node:assert/strict"
import test from "node:test"
import { GiwaReadinessChecker } from "./checker.js"

test("readiness check does not echo raw infrastructure errors", async () => {
  const checker = new GiwaReadinessChecker({
    arco: {
      async healthCheck() {
        throw new Error("connect ECONNREFUSED postgres://app_user@db.example:5432/arco")
      },
      async getIndexerCursor() {
        return { lagBlocks: 0 }
      },
    } as any,
    rpcClient: {
      async getChainId() {
        return 91342
      },
      async getBytecode() {
        return "0x"
      },
    } as any,
    registryPath: "deployments/91342/arco-giwa-preprod.json",
    cursorName: "giwa",
    maxLagBlocks: 100,
  })

  const result = await checker.check()
  const serialized = JSON.stringify(result)

  assert.equal(result.ok, false)
  assert.equal(result.checks.db.detail, "db unreachable")
  assert.equal(serialized.includes("db.example"), false)
  assert.equal(serialized.includes("app_user"), false)
  assert.equal(serialized.includes("5432"), false)
})
