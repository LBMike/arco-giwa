import type { PrismaArcoService } from "./prisma-arco-service.js"
import type { RegistrySyncInput } from "./types.js"

export class EvmRegistryService {
  constructor(private readonly arco: PrismaArcoService) {}

  sync(registry: RegistrySyncInput) {
    return this.arco.syncRegistry(registry)
  }

  listNetworks() {
    return this.arco.listNetworks()
  }

  getRegistry(chainId: number) {
    return this.arco.getRegistry(chainId)
  }
}

