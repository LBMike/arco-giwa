import { useDynamicContext } from "@dynamic-labs/sdk-react-core"
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { formatEther, getAddress, isAddress, type Hex } from "viem"
import { useAccount, useSwitchChain, useWalletClient } from "wagmi"
import { GIWA_EXPLORER, GIWA_HEX_CHAIN_ID, GIWA_PUBLIC_RPC, GIWA_CHAIN_ID } from "./config"
import { publicGiwaClient, setDynamicWalletClient, setInjectedWalletSource } from "./contracts"
import type { HexAddress, UiPhase } from "./types"

type WalletContextValue = {
  address: HexAddress | null
  connected: boolean
  chainId: number | null
  nativeBalance: string | null
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

  useEffect(() => {
    setInjectedWalletSource()
    return () => setInjectedWalletSource()
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
    try {
      if (!window.ethereum) throw new Error("No injected wallet is available")
      const accounts = await window.ethereum.request<string[]>({ method: "eth_requestAccounts" })
      const nextAddress = normalizeAccount(accounts[0])
      if (!nextAddress) throw new Error("Wallet did not return an EVM address")
      setAddress(nextAddress)
      setChainId(await requestChainId())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const disconnect = useCallback(() => {
    setAddress(null)
    setNativeBalance(null)
    setError(null)
  }, [])

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
    if (!window.ethereum?.on) return undefined
    const onAccounts = (accounts: unknown) => {
      const next = Array.isArray(accounts) ? normalizeAccount(accounts[0]) : null
      setAddress(next)
    }
    const onChain = (value: unknown) => setChainId(chainIdFromHex(value))
    window.ethereum.on("accountsChanged", onAccounts)
    window.ethereum.on("chainChanged", onChain)
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccounts)
      window.ethereum?.removeListener?.("chainChanged", onChain)
    }
  }, [])

  useEffect(() => {
    refreshBalance().catch(() => setNativeBalance(null))
  }, [refreshBalance])

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
      phase,
      error,
      connect,
      disconnect,
      switchToGiwa,
      refreshBalance,
    }),
    [address, chainId, connect, disconnect, error, nativeBalance, phase, refreshBalance, switchToGiwa],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function DynamicGiwaWalletProvider({ children }: { children: ReactNode }) {
  const { handleLogOut, network, primaryWallet, sdkHasLoaded, setShowAuthFlow } = useDynamicContext()
  const account = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { data: dynamicWalletClient } = useWalletClient({ chainId: GIWA_CHAIN_ID })
  const [nativeBalance, setNativeBalance] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const address = useMemo(
    () => normalizeAccount(account.address ?? primaryWallet?.address),
    [account.address, primaryWallet?.address],
  )
  const chainId = account.chainId ?? chainIdFromNetwork(network)

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
      phase,
      error,
      connect,
      disconnect,
      switchToGiwa,
      refreshBalance,
    }),
    [address, chainId, connect, disconnect, error, nativeBalance, phase, refreshBalance, switchToGiwa],
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
