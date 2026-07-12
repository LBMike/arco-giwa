import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

export function createPrismaClient() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to create PrismaClient")
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  return new PrismaClient({ adapter })
}
