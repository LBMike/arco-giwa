import { useDynamicContext } from "@dynamic-labs/sdk-react-core"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { formatEther, getAddress, isAddress, type Hex } from "viem"
import { useAccount, useSwitchChain, useWalletClient } from "wagmi"
import { GIWA_EXPLORER, GIWA_HEX_CHAIN_ID, GIWA_PUBLIC_RPC, GIWA_CHAIN_ID } from "./config"
import { publicGiwaClient, setDynamicWalletClient, setInjectedWalletSource } from "./contracts"
import type { HexAddress, UiPhase } from "./types"
import { dynamicSigningReady, useWalletConnectionEpoch } from "./stocks-host/wallet-lifecycle"
import type { ActiveWalletSource } from "./stocks-wallet-source/types"

type WalletContextValue = {
  address: HexAddress | null
  connected: boolean
  chainId: number | null
  nativeBalance: string | null
  /** SIWE scope changes even for an A→B→A or same-address reconnection. */
  sessionEpoch: string
  /** The captured source object (injected provider or Dynamic client) behind this epoch. */
  source: ActiveWalletSource | null
  signingReady: boolean
  phase: UiPhase
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
  switchToGiwa: () => Promise<void>
  refreshBalance: () => Promise<void>
}

const WalletContext = createContext<WalletContextValue | null>(null)

function chainIdFromHex(value: unknown) {
  return typeof value === "string" ? Number.parseInt(value, 16) : null
}

function chainIdFromNetwork(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value !== "string") return null
  return value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10)
}

function normalizeAccount(value: unknown) {
  if (typeof value === "string" && isAddress(value)) return getAddress(value)
  return null
}

async function requestChainId() {
  if (!window.ethereum) return null
  return chainIdFromHex(await window.ethereum.request({ method: "eth_chainId" }))
}

export function GiwaWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<HexAddress | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [nativeBalance, setNativeBalance] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectionEpoch, setConnectionEpoch] = useState(0)
  const requestGeneration = useRef(0)
  const accountGeneration = useRef(0)
  const injectedProvider = typeof window === "undefined" ? undefined : window.ethereum
  const sourceEpoch = useWalletConnectionEpoch([connectionEpoch, injectedProvider])
  const retireConnection = useCallback((accountChanged = true) => {
    requestGeneration.current++
    if (accountChanged) accountGeneration.current++
    setConnectionEpoch(value => value + 1)
  }, [])

  useEffect(() => {
    setInjectedWalletSource()
    return () => { requestGeneration.current++; accountGeneration.current++; setInjectedWalletSource() }
  }, [])

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setNativeBalance(null)
      return
    }
    const balance = await publicGiwaClient.getBalance({ address })
    setNativeBalance(formatEther(balance))
  }, [address])

  const connect = useCallback(async () => {
    setError(null)
    retireConnection()
    const generation = requestGeneration.current
    const accountVersion = accountGeneration.current
    setChainId(null)
    try {
      if (!window.ethereum) throw new Error("No injected wallet is available")
      const accounts = await window.ethereum.request<string[]>({ method: "eth_requestAccounts" })
      const nextAddress = normalizeAccount(accounts[0])
      if (!nextAddress) throw new Error("Wallet did not return an EVM address")
      const nextChain = await requestChainId()
      if (accountVersion !== accountGeneration.current) return
      setAddress(nextAddress)
      // A chain event during connection is newer than this RPC response.
      if (generation === requestGeneration.current) setChainId(nextChain)
    } catch (err) {
      if (accountVersion === accountGeneration.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [retireConnection])

  const disconnect = useCallback(() => {
    retireConnection()
    setChainId(null)
    setAddress(null)
    setNativeBalance(null)
    setError(null)
  }, [retireConnection])

  const switchToGiwa = useCallback(async () => {
    setError(null)
    try {
      if (!window.ethereum) throw new Error("No injected wallet is available")
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: GIWA_HEX_CHAIN_ID }],
        })
      } catch (err: any) {
        if (err?.code !== 4902) throw err
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: GIWA_HEX_CHAIN_ID,
              chainName: "GIWA Sepolia",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [GIWA_PUBLIC_RPC],
              blockExplorerUrls: [GIWA_EXPLORER],
            },
          ],
        })
      }
      setChainId(await requestChainId())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    const provider = injectedProvider
    if (!provider?.on) return undefined
    const onAccounts = (accounts: unknown) => {
      retireConnection()
      const generation = requestGeneration.current
      const next = Array.isArray(accounts) ? normalizeAccount(accounts[0]) : null
      setAddress(next)
      setChainId(null)
      if (next) void requestChainId().then(value => {
        if (generation === requestGeneration.current) setChainId(value)
      }).catch(() => {})
    }
    const onChain = (value: unknown) => { retireConnection(false); setChainId(chainIdFromHex(value)) }
    const onDisconnect = () => { retireConnection(); setAddress(null); setChainId(null) }
    provider.on("accountsChanged", onAccounts)
    provider.on("chainChanged", onChain)
    provider.on("disconnect", onDisconnect)
    return () => {
      requestGeneration.current++
      accountGeneration.current++
      provider.removeListener?.("accountsChanged", onAccounts)
      provider.removeListener?.("chainChanged", onChain)
      provider.removeListener?.("disconnect", onDisconnect)
    }
  }, [retireConnection, injectedProvider])

  useEffect(() => {
    refreshBalance().catch(() => setNativeBalance(null))
  }, [refreshBalance])

  const source = useMemo<ActiveWalletSource>(() => ({ mode: "injected", provider: injectedProvider ?? null }), [injectedProvider])

  const phase: UiPhase = !address
    ? "disconnected"
    : chainId !== GIWA_CHAIN_ID
      ? "wrong-network"
      : nativeBalance === "0"
        ? "missing-gas"
        : "ready"

  const value = useMemo(
    () => ({
      address,
      connected: Boolean(address),
      chainId,
      nativeBalance,
      sessionEpoch: `injected:${sourceEpoch}`,
      source,
      signingReady: Boolean(injectedProvider && address && chainId === GIWA_CHAIN_ID),
      phase,
      error,
      connect,
      disconnect,
      switchToGiwa,
      refreshBalance,
    }),
    [address, chainId, sourceEpoch, source, injectedProvider, connect, disconnect, error, nativeBalance, phase, refreshBalance, switchToGiwa],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function DynamicGiwaWalletProvider({ children }: { children: ReactNode }) {
  const dynamic = useDynamicContext()
  const account = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { data: dynamicWalletClient } = useWalletClient({ chainId: GIWA_CHAIN_ID })
  return <DynamicGiwaWalletStateProvider dynamic={dynamic} account={account} switchChainAsync={switchChainAsync} dynamicWalletClient={dynamicWalletClient}>{children}</DynamicGiwaWalletStateProvider>
}

/** The SDK boundary is kept thin so account/chain/source lifecycle can be tested without a live SDK. */
function DynamicGiwaWalletStateProvider({ children, dynamic, account, switchChainAsync, dynamicWalletClient }: {
  children: ReactNode
  dynamic: Pick<ReturnType<typeof useDynamicContext>, "handleLogOut" | "network" | "primaryWallet" | "sdkHasLoaded" | "setShowAuthFlow">
  account: Pick<ReturnType<typeof useAccount>, "address" | "chainId" | "status">
  switchChainAsync: (args: { chainId: number }) => Promise<unknown>
  dynamicWalletClient: (Parameters<typeof setDynamicWalletClient>[0] & { account?: { address?: string }; chain?: { id: number } }) | undefined
}) {
  const { handleLogOut, network, primaryWallet, sdkHasLoaded, setShowAuthFlow } = dynamic
  const [nativeBalance, setNativeBalance] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localLogout, setLocalLogout] = useState(false)
  const [logoutEpoch, setLogoutEpoch] = useState(0)

  const selectedAddress = useMemo(
    () => normalizeAccount(account.address ?? primaryWallet?.address),
    [account.address, primaryWallet?.address],
  )
  const address = localLogout ? null : selectedAddress
  const chainId = account.chainId ?? chainIdFromNetwork(network)
  const connectionEpoch = useWalletConnectionEpoch([account.address, account.chainId, account.status, primaryWallet?.id, primaryWallet?.address, network, dynamicWalletClient, logoutEpoch])
  const signingReady = dynamicSigningReady(address, chainId, account.status, primaryWallet?.address, dynamicWalletClient)
  useEffect(() => {
    if (!account.address && !primaryWallet?.address) setLocalLogout(false)
  }, [account.address, primaryWallet?.address])

  useEffect(() => {
    setDynamicWalletClient(address && chainId === GIWA_CHAIN_ID ? dynamicWalletClient ?? null : null)
    return () => setDynamicWalletClient(null)
  }, [address, chainId, dynamicWalletClient])

  const refreshBalance = useCallback(async () => {
    if (!address) {
      setNativeBalance(null)
      return
    }
    const balance = await publicGiwaClient.getBalance({ address })
    setNativeBalance(formatEther(balance))
  }, [address])

  const connect = useCallback(async () => {
    setError(null)
    if (!sdkHasLoaded) {
      setError("Dynamic wallet modal is still loading")
      return
    }
    setShowAuthFlow(true)
  }, [sdkHasLoaded, setShowAuthFlow])

  const disconnect = useCallback(() => {
    setLocalLogout(true)
    setLogoutEpoch(value => value + 1)
    setNativeBalance(null)
    setError(null)
    setDynamicWalletClient(null)
    void handleLogOut()
  }, [handleLogOut])

  const switchToGiwa = useCallback(async () => {
    setError(null)
    try {
      if (primaryWallet) {
        await primaryWallet.switchNetwork(GIWA_CHAIN_ID)
        return
      }
      await switchChainAsync({ chainId: GIWA_CHAIN_ID })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [primaryWallet, switchChainAsync])

  useEffect(() => {
    refreshBalance().catch(() => setNativeBalance(null))
  }, [refreshBalance])

  const source = useMemo<ActiveWalletSource>(() => ({ mode: "dynamic", client: signingReady ? dynamicWalletClient ?? null : null }), [signingReady, dynamicWalletClient])

  const phase: UiPhase = !address
    ? "disconnected"
    : chainId !== GIWA_CHAIN_ID
      ? "wrong-network"
      : nativeBalance === "0"
        ? "missing-gas"
        : "ready"

  const value = useMemo(
    () => ({
      address,
      connected: Boolean(address),
      chainId,
      nativeBalance,
      sessionEpoch: `dynamic:${connectionEpoch}`,
      source,
      signingReady,
      phase,
      error,
      connect,
      disconnect,
      switchToGiwa,
      refreshBalance,
    }),
    [address, chainId, connectionEpoch, source, signingReady, connect, disconnect, error, nativeBalance, phase, refreshBalance, switchToGiwa],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useGiwaWallet() {
  const context = useContext(WalletContext)
  if (!context) throw new Error("useGiwaWallet must be used inside GiwaWalletProvider")
  return context
}

export function explorerTx(txHash: Hex | string) {
  return `${GIWA_EXPLORER}/tx/${txHash}`
}

export function explorerAddress(address: string) {
  return `${GIWA_EXPLORER}/address/${address}`
}
