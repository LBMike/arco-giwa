import type { FastifyInstance } from "fastify"
import type { ArcoUSDService } from "./service.js"

// Public, read-only: everything here is on-chain state anyway. Never 500s on an RPC failure —
// the response says "unavailable" and the buy gate reads "closed".
export async function arcoUSDPlugin(app: FastifyInstance, { service }: { service: ArcoUSDService }): Promise<void> {
  app.get("/api/v1/arcousd/reserve", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return service.reserveState()
  })
  app.get("/api/v1/arcousd/gate", async (_request, reply) => {
    reply.header("Cache-Control", "no-store")
    return service.gate()
  })
}
