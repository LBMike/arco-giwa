import { EthereumWalletConnectors } from "@dynamic-labs/ethereum"
import { DynamicContextProvider, mergeNetworks } from "@dynamic-labs/sdk-react-core"
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useMemo, type ReactNode } from "react"
import { createConfig, http, WagmiProvider } from "wagmi"
import {
  GIWA_CHAIN_ID,
  GIWA_PROVIDER_HIERARCHY,
  GIWA_PUBLIC_RPC,
  DYNAMIC_ENVIRONMENT_ID,
  dynamicGiwaNetwork,
  giwaSepolia,
} from "./config"
import { DynamicGiwaWalletProvider, GiwaWalletProvider } from "./wallet"
import { GiwaStocksHost } from "./stocks-host/GiwaStocksHost"

const giwaWagmiConfig = createConfig({
  chains: [giwaSepolia],
  transports: {
    [GIWA_CHAIN_ID]: http(GIWA_PUBLIC_RPC),
  },
})

export function GiwaPreprodProviders({ children }: { children: ReactNode }) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
    [],
  )

  if (DYNAMIC_ENVIRONMENT_ID) {
    return (
      <GiwaProviderBoundary dynamicEnabled>
        <DynamicContextProvider
          settings={{
            appName: "Arco GIWA Preprod",
            environmentId: DYNAMIC_ENVIRONMENT_ID,
            walletConnectors: [EthereumWalletConnectors],
            walletConnectPreferredChains: [`eip155:${GIWA_CHAIN_ID}`],
            overrides: {
              evmNetworks: (networks) => mergeNetworks([dynamicGiwaNetwork], networks),
            },
          }}
        >
          <WagmiProvider config={giwaWagmiConfig}>
            <QueryClientProvider client={queryClient}>
              <DynamicWagmiConnector suppressChainMismatchError>
                <DynamicGiwaWalletProvider><GiwaStocksHost>{children}</GiwaStocksHost></DynamicGiwaWalletProvider>
              </DynamicWagmiConnector>
            </QueryClientProvider>
          </WagmiProvider>
        </DynamicContextProvider>
      </GiwaProviderBoundary>
    )
  }

  return (
    <GiwaProviderBoundary dynamicEnabled={false}>
      <QueryClientProvider client={queryClient}>
        <GiwaWalletProvider><GiwaStocksHost>{children}</GiwaStocksHost></GiwaWalletProvider>
      </QueryClientProvider>
    </GiwaProviderBoundary>
  )
}

function GiwaProviderBoundary({ children, dynamicEnabled }: { children: ReactNode; dynamicEnabled: boolean }) {
  return (
    <div
      data-provider-hierarchy={GIWA_PROVIDER_HIERARCHY.join(" > ")}
      data-dynamic-env={dynamicEnabled ? "configured" : "injected-wallet-fallback"}
      data-giwa-chain={dynamicGiwaNetwork.chainId}
    >
      {children}
    </div>
  )
}
