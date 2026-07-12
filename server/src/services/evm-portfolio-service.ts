import type { PrismaArcoService } from "./prisma-arco-service.js"

export class EvmPortfolioService {
  constructor(private readonly arco: PrismaArcoService) {}

  async portfolio(walletAddress: string, chainId: number) {
    const redemptions = await this.arco.redemptionsForWallet(walletAddress, chainId)
    return {
      walletAddress: walletAddress.toLowerCase(),
      chainId,
      positions: [],
      redemptions,
    }
  }

  activity(walletAddress: string, chainId?: number) {
    return this.arco.activityForWallet(walletAddress, chainId)
  }

  redemptions(walletAddress: string, chainId?: number) {
    return this.arco.redemptionsForWallet(walletAddress, chainId)
  }

  faucetStatus(walletAddress: string, chainId: number) {
    return this.arco.faucetStatus(walletAddress, chainId)
  }
}

