import type { PrismaArcoService } from "../services/prisma-arco-service.js"
import type { GiwaIndexerStore } from "./giwa-indexer.js"

export class PrismaGiwaIndexerStore implements GiwaIndexerStore {
  constructor(private readonly arco: PrismaArcoService) {}

  getCursor(chainId: number, name: string) {
    return this.arco.getIndexerCursor(chainId, name) as ReturnType<GiwaIndexerStore["getCursor"]>
  }

  upsertCursor(input: Parameters<GiwaIndexerStore["upsertCursor"]>[0]) {
    return this.arco.upsertIndexerCursor(input)
  }

  insertIndexedEvent(input: Parameters<GiwaIndexerStore["insertIndexedEvent"]>[0]) {
    return this.arco.insertIndexedEvent(input)
  }

  upsertRedemptionRequest(input: Parameters<GiwaIndexerStore["upsertRedemptionRequest"]>[0]) {
    return this.arco.upsertRedemptionRequest(input)
  }

  markRedemptionFulfilled(input: Parameters<GiwaIndexerStore["markRedemptionFulfilled"]>[0]) {
    return this.arco.markRedemptionFulfilled(input)
  }

  markRedemptionClaimed(input: Parameters<GiwaIndexerStore["markRedemptionClaimed"]>[0]) {
    return this.arco.markRedemptionClaimed(input)
  }
}
