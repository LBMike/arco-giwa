// The /stocks page's host access for the trade panel: the steps before a Stocks request (wallet, network, sign-in). It is the
// host snapshot plus one fact the snapshot cannot carry. A wallet switch gives the host a fresh session: signed out, with no
// error. So the page remembers the wallet of the last authenticated session. This memory lasts for this page visit only; a
// full reload clears it. When a DIFFERENT wallet is now connected, the page reports WALLET_CHANGED. Neither address is ever
// passed on.
import { useMemo, useRef } from "react"
import { useGiwaStocksHost } from "../stocks-host"
import { useStocksWalletCommands } from "../stocks-host/wallet-commands"
import type { GiwaStocksAccess } from "../stocks-investor/access"

/** True when the host is signed out without an error of its own and the connected wallet is not the last signed-in one. */
export function walletChangedSinceSignIn({ status, error, connected, lastAuthenticated }: { status: GiwaStocksAccess["host"]; error: string | null; connected: string | null; lastAuthenticated: string | null }): boolean {
  return status === "signed-out" && error === null && connected !== null && lastAuthenticated !== null && connected.toLowerCase() !== lastAuthenticated.toLowerCase()
}

export function useStocksPageAccess(): GiwaStocksAccess {
  const host = useGiwaStocksHost()
  const commands = useStocksWalletCommands()
  const { walletStatus, canSignIn, signIn } = host
  const { status, error, session } = host.snapshot
  // Written only from an authenticated snapshot, so repeated or discarded renders store the same value.
  const lastAuthenticated = useRef<string | null>(null)
  if (status === "authenticated" && session) lastAuthenticated.current = session.walletAddress
  const hostError = walletChangedSinceSignIn({ status, error, connected: host.wallet.address, lastAuthenticated: lastAuthenticated.current }) ? "WALLET_CHANGED" : error
  const connect = commands?.connect, switchNetwork = commands?.switchNetwork
  // Every callback runs only from an explicit user action.
  return useMemo<GiwaStocksAccess>(() => ({
    wallet: walletStatus, host: status, hostError, canSignIn, signIn: () => { void signIn().catch(() => {}) },
    ...(connect ? { connectWallet: connect } : {}), ...(switchNetwork ? { switchNetwork } : {}),
  }), [walletStatus, status, hostError, canSignIn, signIn, connect, switchNetwork])
}
