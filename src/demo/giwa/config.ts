import { defineChain } from "viem"

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}

export const GIWA_CHAIN_ID = 91342

// Live-read refetch policy for the GIWA market / catalog / price-history queries: poll
// every 20s while the tab is focused (never in the background) + refetch on window focus,
// so Price/APY/Performance auto-update after an admin NAV post without a manual reload.
export const GIWA_LIVE_REFETCH = {
  refetchInterval: 20_000,
  refetchOnWindowFocus: true,
  refetchIntervalInBackground: false,
} as const
export const GIWA_HEX_CHAIN_ID = `0x${GIWA_CHAIN_ID.toString(16)}`
export const GIWA_NETWORK_NAME = "GIWA Sepolia"
export const GIWA_PUBLIC_RPC =
  viteEnv.VITE_PUBLIC_GIWA_RPC || "https://sepolia-rpc.giwa.io"
export const GIWA_EXPLORER =
  viteEnv.VITE_GIWA_EXPLORER || "https://sepolia-explorer.giwa.io"
export const GIWA_FAUCET_URL = "https://faucet.giwa.io"
export const ARCO_API_BASE =
  viteEnv.VITE_ARCO_API_BASE || "http://localhost:8080"
export const DYNAMIC_ENVIRONMENT_ID =
  viteEnv.VITE_DYNAMIC_ENVIRONMENT_ID || ""
// Explicit presentation setting used by the integrated local product preview.
// Changes layout/copy only; authentication and transaction checks remain active.
export const GIWA_CUSTOMER_PRESENTATION = viteEnv.VITE_CUSTOMER_PRESENTATION === "true"
export const GIWA_STOCKS_DEMO_MARKET = viteEnv.VITE_STOCKS_DEMO_MARKET === "true"
// Comma-separated operator wallet addresses allowed to SEE the GIWA admin page.
// Visibility gate only — real enforcement is server requireOperator + on-chain FEED_ADMIN_ROLE.
export const GIWA_ADMIN_ADDRESSES_RAW = viteEnv.VITE_GIWA_ADMIN_ADDRESSES || ""
// Build-time address of the separate admin console (docs/admin-console.md). Set, the customer app's /admin, /admin/*
// and /admin/stocks redirect there and the build leaves the legacy admin pages out of the bundle; unset (local demo),
// the legacy in-app admin stays. Read as import.meta.env?.… rather than through viteEnv so that the build inlines the
// value and drops the routes it rules out.
export const GIWA_ADMIN_CONSOLE_URL: string | undefined =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_ADMIN_CONSOLE_URL || undefined

export const giwaSepolia = defineChain({
  id: GIWA_CHAIN_ID,
  name: GIWA_NETWORK_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [GIWA_PUBLIC_RPC] },
    public: { http: [GIWA_PUBLIC_RPC] },
  },
  blockExplorers: {
    default: { name: "GIWA Explorer", url: GIWA_EXPLORER },
  },
  testnet: true,
})

export const dynamicGiwaNetwork = {
  blockExplorerUrls: [GIWA_EXPLORER],
  chainId: GIWA_CHAIN_ID,
  chainName: GIWA_NETWORK_NAME,
  iconUrls: [],
  name: GIWA_NETWORK_NAME,
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  networkId: GIWA_CHAIN_ID,
  rpcUrls: [GIWA_PUBLIC_RPC],
  vanityName: GIWA_NETWORK_NAME,
}

export const GIWA_PROVIDER_HIERARCHY = [
  "DynamicContextProvider",
  "WagmiProvider",
  "QueryClientProvider",
  "DynamicWagmiConnector",
] as const
