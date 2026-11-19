import type { FastifyInstance } from "fastify"
import type { ArcoGoldService } from "./service.js"

// Public, read-only (on-chain state anyway). Always 200: "not-deployed" before the gold registry file exists,
// "unavailable" when a read fails.
export async function arcoGoldPlugin(app: FastifyInstance, { service }: { service: ArcoGoldService }): Promise<void> {
  // The gold Reserve: per-coin instant liquidity (assets[].available), totals in ounces, pauses.
  app.get("/api/v1/arcogold/reserve", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return service.reserveState()
  })
  // ArcoGOLD: price per share, totals, pauses, the display APY and the USD price of an ounce.
  app.get("/api/v1/arcogold/savings", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return service.savingsState()
  })
}
