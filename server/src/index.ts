import { pathToFileURL } from "node:url"
import { configuredStocksRuntime, stocksAutodispatch } from "./stocks-runtime/runtime.js"
import { closeOnce, installServerShutdown, startManagedStocksServer } from "./stocks-runtime/lifecycle.js"
import { stocksSessionResolvers } from "./stocks-runtime/session.js"
import { StocksSubmissionsService } from "./stocks-submissions/service.js"
import { configuredStocksMarketData } from "./stocks-market-runtime/config.js"
import type { StocksMarketDataService } from "./stocks-market-data/index.js"
import { createPublicClient, http, keccak256, parseAbi, toBytes, type Hex } from "viem"
import { buildApp, type PauseStateVaultRef, type VaultPauseState } from "./app.js"
import { FUNCTION_PAUSE_SELECTORS } from "./evm/admin-transactions.js"
import { EvmRegisterService, PROXY_SLOTS, type RegisterProbe } from "./services/evm-register-service.js"
import { validateServerEnv } from "./config/env.js"
import { createPrismaClient } from "./db/prisma.js"
import { GIWA_CHAIN_ID } from "./registry/products.js"
import { GiwaReadinessChecker } from "./readiness/checker.js"
import { EvmMarketService } from "./services/evm-market-service.js"
import { EvmMonitoringService } from "./services/evm-monitoring-service.js"
import { EvmPortfolioService } from "./services/evm-portfolio-service.js"
import { EvmRegistryService } from "./services/evm-registry-service.js"
import { PrismaArcoService } from "./services/prisma-arco-service.js"
import { fetchUsdRates } from "./services/usd-rates.js"
import { readRegistryFile } from "./registry/io.js"

export async function startServer(envSource: NodeJS.ProcessEnv = process.env, cliOwnsSignals = false) {
  const env = validateServerEnv(envSource)
  const autodispatch = stocksAutodispatch(envSource)
  const stocksMarketData = configuredStocksMarketData(envSource)
  const prisma = createPrismaClient()
  const closeDatabase = closeOnce(() => prisma.$disconnect())
  try {
    return await composeServer(envSource, env, prisma, closeDatabase, autodispatch, cliOwnsSignals, stocksMarketData)
  } catch (error) {
    await closeDatabase()
    throw error
  }
}

async function composeServer(
  envSource: NodeJS.ProcessEnv,
  env: ReturnType<typeof validateServerEnv>,
  prisma: ReturnType<typeof createPrismaClient>,
  closeDatabase: () => Promise<void>,
  autodispatch: boolean,
  cliOwnsSignals: boolean,
  stocksMarketData: StocksMarketDataService,
) {
  const arco = new PrismaArcoService(prisma)
  const registry = new EvmRegistryService(arco)
  const portfolio = new EvmPortfolioService(arco)
  const rpcClient = createPublicClient({ transport: http(env.indexerRpcUrl) })
  const priceFeedReadAbi = parseAbi([
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  ])
  const market = new EvmMarketService({
    arco,
    loadRegistry: () => readRegistryFile(env.registryPath),
    fetchRates: fetchUsdRates,
    readNavOnChain: async (feedAddress) => {
      try {
        const data = (await rpcClient.readContract({
          address: feedAddress as `0x${string}`,
          abi: priceFeedReadAbi,
          functionName: "latestRoundData",
        })) as readonly [bigint, bigint, bigint, bigint, bigint]
        const answer = Number(data[1])
        return Number.isFinite(answer) && answer > 0 ? answer / 100_000_000 : null
      } catch {
        return null
      }
    },
  })
  const erc20ReadAbi = parseAbi([
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address account) view returns (uint256)",
  ])
  const monitoring = new EvmMonitoringService({
    arco,
    market,
    loadRegistry: () => readRegistryFile(env.registryPath),
    readShareSupply: async (tokenAddress) => {
      try {
        const [supply, decimals] = await Promise.all([
          rpcClient.readContract({ address: tokenAddress as `0x${string}`, abi: erc20ReadAbi, functionName: "totalSupply" }),
          rpcClient.readContract({ address: tokenAddress as `0x${string}`, abi: erc20ReadAbi, functionName: "decimals" }),
        ])
        return { supply: (supply as bigint).toString(), decimals: Number(decimals) }
      } catch {
        return null
      }
    },
    readTokenBalances: async (tokenAddress, addresses) => {
      try {
        const balances = await Promise.all(
          addresses.map(async (address) => {
            const balance = (await rpcClient.readContract({
              address: tokenAddress as `0x${string}`,
              abi: erc20ReadAbi,
              functionName: "balanceOf",
              args: [address as `0x${string}`],
            })) as bigint
            return [address, balance.toString()] as const
          }),
        )
        return Object.fromEntries(balances)
      } catch {
        return null
      }
    },
  })
  // Wallet-less pause snapshot for the public catalog. ~30s cache keeps the catalog from
  // issuing 36 eth_calls per request; a failed sweep returns null so the handler falls
  // back to unpaused defaults instead of failing the catalog.
  const pausableReadAbi = parseAbi([
    "function fnPaused(bytes4 selector) view returns (bool)",
    "function paused() view returns (bool)",
  ])
  let pauseStateCache: { at: number; value: Record<string, VaultPauseState> } | null = null
  const readPauseState = async (vaults: PauseStateVaultRef[]) => {
    if (pauseStateCache && Date.now() - pauseStateCache.at < 30_000) return pauseStateCache.value
    try {
      const readBool = (address: string, functionName: "fnPaused" | "paused", args?: readonly [Hex]) =>
        rpcClient.readContract({
          address: address as `0x${string}`,
          abi: pausableReadAbi,
          functionName,
          ...(args ? { args } : {}),
        }) as Promise<boolean>
      const kindState = async (vault: string | null, kind: "deposit" | "withdraw") => {
        if (!vault) return { paused: false, partial: false }
        const [a, b] = FUNCTION_PAUSE_SELECTORS[kind].selectors
        const [global, first, second] = await Promise.all([
          readBool(vault, "paused"),
          readBool(vault, "fnPaused", [a.selector as Hex]),
          readBool(vault, "fnPaused", [b.selector as Hex]),
        ])
        return { paused: global || first || second, partial: first !== second }
      }
      const entries = await Promise.all(
        vaults.map(async (vault) => {
          const [deposit, withdraw] = await Promise.all([
            kindState(vault.depositVault, "deposit"),
            kindState(vault.redemptionVault, "withdraw"),
          ])
          return [
            vault.productId,
            {
              depositPaused: deposit.paused,
              depositPartial: deposit.partial,
              withdrawPaused: withdraw.paused,
              withdrawPartial: withdraw.partial,
            },
          ] as const
        }),
      )
      pauseStateCache = { at: Date.now(), value: Object.fromEntries(entries) }
      return pauseStateCache.value
    } catch {
      return null
    }
  }
  // Current per-vault limits, read straight from the auto-getters (on-chain is the source of
  // truth — limits aren't persisted in the registry). Returns RAW base units as strings; the
  // route de-scales to human with the registry decimals. Parallel reads, no cache, like readShareSupply.
  const vaultLimitsReadAbi = parseAbi([
    "function minimumDeposit() view returns (uint256)",
    "function maxSupplyCap() view returns (uint256)",
    "function vaultMintAllowance() view returns (uint256)",
    "function minimumRedeem() view returns (uint256)",
    "function vaultRedeemAllowance() view returns (uint256)",
  ])
  const readVaultLimits = async (refs: { depositVault: string; redemptionVault: string }) => {
    const readLimit = (address: string, functionName: "minimumDeposit" | "maxSupplyCap" | "vaultMintAllowance" | "minimumRedeem" | "vaultRedeemAllowance") =>
      rpcClient.readContract({ address: address as `0x${string}`, abi: vaultLimitsReadAbi, functionName }) as Promise<bigint>
    try {
      const [minimumDeposit, maxSupplyCap, vaultMintAllowance, minimumRedeem, vaultRedeemAllowance] = await Promise.all([
        readLimit(refs.depositVault, "minimumDeposit"),
        readLimit(refs.depositVault, "maxSupplyCap"),
        readLimit(refs.depositVault, "vaultMintAllowance"),
        readLimit(refs.redemptionVault, "minimumRedeem"),
        readLimit(refs.redemptionVault, "vaultRedeemAllowance"),
      ])
      return {
        minimumDeposit: minimumDeposit.toString(),
        maxSupplyCap: maxSupplyCap.toString(),
        vaultMintAllowance: vaultMintAllowance.toString(),
        minimumRedeem: minimumRedeem.toString(),
        vaultRedeemAllowance: vaultRedeemAllowance.toString(),
      }
    } catch {
      return null
    }
  }
  // On-chain probe for 2c "register deployed vault". Read-only. Custody note: ProxyAdmin
  // ownership & impl-bytecode equivalence MUST be verified before any mainnet use.
  const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex
  const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex
  const registerReadAbi = parseAbi([
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function decimals() view returns (uint8)",
    "function paymentToken() view returns (address)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function owner() view returns (address)",
  ])
  const role = (name: string) => keccak256(toBytes(name))
  const slotAddress = (word: Hex | undefined): string | null => {
    if (!word || word === "0x") return null
    const address = `0x${word.slice(-40)}`
    return /^0x0{40}$/.test(address) ? null : address
  }
  const register = new EvmRegisterService({
    arco,
    loadRegistry: () => readRegistryFile(env.registryPath),
    probeProduct: async (product, registry) => {
      try {
        const roles = (registry as { roles?: Record<string, string | undefined> }).roles ?? {}
        const tier2 = (roles.tier2Operator ?? roles.pauser ?? registry.deployer) as `0x${string}`
        const address = (slot: (typeof PROXY_SLOTS)[number]) => product[slot].proxy as `0x${string}`
        const read = <T,>(target: `0x${string}`, functionName: string, args?: readonly unknown[]) =>
          rpcClient.readContract({ address: target, abi: registerReadAbi, functionName, args } as never) as Promise<T>

        const code = {} as RegisterProbe["code"]
        const proxyAdmins = {} as RegisterProbe["proxyAdmins"]
        const implementations = {} as RegisterProbe["implementations"]
        const implCodeHashes = {} as RegisterProbe["implCodeHashes"]
        for (const slot of PROXY_SLOTS) {
          const proxy = address(slot)
          const [bytecode, adminWord, implWord] = await Promise.all([
            rpcClient.getBytecode({ address: proxy }),
            rpcClient.getStorageAt({ address: proxy, slot: EIP1967_ADMIN_SLOT }),
            rpcClient.getStorageAt({ address: proxy, slot: EIP1967_IMPL_SLOT }),
          ])
          code[slot] = Boolean(bytecode && bytecode !== "0x")
          proxyAdmins[slot] = slotAddress(adminWord as Hex | undefined)
          const impl = slotAddress(implWord as Hex | undefined)
          implementations[slot] = impl
          implCodeHashes[slot] = impl
            ? await rpcClient.getBytecode({ address: impl as `0x${string}` }).then((implCode) => (implCode && implCode !== "0x" ? keccak256(implCode) : null))
            : null
        }

        const [symbol, name, decimals, depositPaymentToken, redemptionPaymentToken] = await Promise.all([
          read<string>(address("productToken"), "symbol"),
          read<string>(address("productToken"), "name"),
          read<number>(address("productToken"), "decimals"),
          read<string>(address("depositVault"), "paymentToken"),
          read<string>(address("redemptionVault"), "paymentToken"),
        ])
        const [feedAdmin, depositVaultAdmin, depositPauser, redemptionVaultAdmin, redemptionPauser, minter, burner] =
          await Promise.all([
            read<boolean>(address("priceFeed"), "hasRole", [role("FEED_ADMIN_ROLE"), tier2]),
            read<boolean>(address("depositVault"), "hasRole", [role("DEPOSIT_VAULT_ADMIN_ROLE"), tier2]),
            read<boolean>(address("depositVault"), "hasRole", [role("PAUSER_ROLE"), tier2]),
            read<boolean>(address("redemptionVault"), "hasRole", [role("REDEMPTION_VAULT_ADMIN_ROLE"), tier2]),
            read<boolean>(address("redemptionVault"), "hasRole", [role("PAUSER_ROLE"), tier2]),
            read<boolean>(address("productToken"), "hasRole", [role("MINTER_ROLE"), address("depositVault")]),
            read<boolean>(address("productToken"), "hasRole", [role("BURNER_ROLE"), address("redemptionVault")]),
          ])
        const proxyAdminOwner = registry.proxyAdmin?.proxy
          ? await read<string>(registry.proxyAdmin.proxy as `0x${string}`, "owner").catch(() => null)
          : null

        return {
          code,
          token: { symbol, name, decimals: Number(decimals) },
          depositPaymentToken,
          redemptionPaymentToken,
          roles: {
            feedAdmin,
            depositVaultAdmin,
            depositPauser,
            redemptionVaultAdmin,
            redemptionPauser,
            minterIsDepositVault: minter,
            burnerIsRedemptionVault: burner,
          },
          proxyAdmins,
          implementations,
          implCodeHashes,
          proxyAdminOwner,
        }
      } catch {
        return null
      }
    },
  })
  const readiness = new GiwaReadinessChecker({
    arco,
    rpcClient,
    registryPath: env.registryPath,
    cursorName: "giwa",
    maxLagBlocks: 100,
  })
  const app = await startManagedStocksServer({
    createRuntime: () => configuredStocksRuntime(envSource, env.databaseUrl),
    buildApp: stocks => {
      const sessions = stocks ? stocksSessionResolvers(env.authJwtSecret,
        env.corsAllowedOrigins.map(origin => new URL(origin).host), stocks.operators) : undefined
      return buildApp(
        {
          corsAllowedOrigins: env.corsAllowedOrigins,
          authNonceTtlSeconds: env.authNonceTtlSeconds,
          authJwtSecret: env.authJwtSecret,
          adminOperatorToken: env.adminOperatorToken,
          registryPath: env.registryPath,
        },
        {
          arco, registry, portfolio, readiness, market, monitoring, register, readPauseState, readVaultLimits, stocksMarketData,
          stocks: stocks ? {
            service: stocks.service,
            reconciliationCoverage: stocks.reconciliationCoverage,
            ...sessions,
          } : undefined,
          stocksExecution: stocks ? { service: stocks.execution, resolveActor: sessions!.resolveActor } : undefined,
          stocksSubmissions: stocks ? {
            service: new StocksSubmissionsService(stocks.service, stocks.submissionReceipts),
            resolveActor: sessions!.resolveActor,
          } : undefined,
        },
      )
    },
    // Dual-stack preserves existing localhost IPv4/IPv6 behavior.
    listen: app => app.listen({ host: "::", port: env.port }),
    closeDatabase,
    autodispatch,
    onApp: cliOwnsSignals ? installServerShutdown : undefined,
  })
  return { app, chainId: GIWA_CHAIN_ID }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(process.env, true).catch(() => {
    console.error("SERVER_START_FAILED")
    process.exit(1)
  })
}
