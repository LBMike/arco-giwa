import type { FastifyInstance } from "fastify"
import type { ArcoUSDSavingsService } from "./savings.js"
import type { ArcoUSDService } from "./service.js"

// Public, read-only: everything here is on-chain state anyway. Never 500s on an RPC failure —
// the response says "unavailable" and the buy gate reads "closed".
export async function arcoUSDPlugin(
  app: FastifyInstance,
  { service, savings }: { service: ArcoUSDService; savings?: ArcoUSDSavingsService },
): Promise<void> {
  app.get("/api/v1/arcousd/reserve", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return service.reserveState()
  })
  app.get("/api/v1/arcousd/gate", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return service.gate()
  })
  if (!savings) return
  // sArcoUSD (Savings): vault, vesting, the distributor's next distribution; "not-deployed" until
  // the Savings contracts are in the ArcoUSD registry.
  app.get("/api/v1/arcousd/savings", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return savings.state()
  })
  // Share price / TVL history from the savings indexer's snapshots, with the realized APY.
  app.get<{ Querystring: { days?: string } }>("/api/v1/arcousd/savings/history", async (request, reply) => {
    reply.header("Cache-Control", "no-store")
    return savings.history(request.query?.days)
  })
}
