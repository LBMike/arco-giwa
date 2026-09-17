import { encodeFunctionData, erc20Abi, getAddress, isAddress, type Address, type Hex } from "viem"
import { digest, ensure, StocksWalletError } from "../stocks-wallet/planner"
import type { ReviewedDeployment, Transaction, WalletIdentity, WalletPorts } from "../stocks-wallet/types"
import type { CapturedWalletSource } from "./types"

type SourcePorts = Pick<WalletPorts, "readWallet" | "readAllowance" | "requestTransaction" | "waitApprovalReceipt">
type Attestation = Readonly<{ source: CapturedWalletSource; manifestDigest: string; address: Address }>

const CHAIN_ID = 91342n
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/
const BLOCK_HASH = /^0x[0-9a-f]{64}$/
const WORD = /^0x[0-9a-fA-F]{64}$/
const CALL_DATA = /^0x([0-9a-fA-F]{2})+$/
const TRANSACTION_KEYS = "chainId,data,from,to,value"

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

/** The digest is recomputed: a caller-supplied digest alone does not bind the manifest used for the checkpoint. */
function reviewed(deployment: ReviewedDeployment | null): ReviewedDeployment {
  ensure(deployment?.status === "VERIFIED" && deployment.manifest && typeof deployment.manifest === "object", "DEPLOYMENT_NOT_REVIEWED")
  let recomputed: string | null = null
  try { recomputed = digest(deployment.manifest) } catch { /* refused below */ }
  ensure(typeof deployment.manifestDigest === "string" && recomputed === deployment.manifestDigest, "MANIFEST_DIGEST_MISMATCH")
  const { checkpointNumber, checkpointHash } = deployment.manifest
  ensure(typeof checkpointNumber === "string" && /^(0|[1-9]\d{0,77})$/.test(checkpointNumber), "DEPLOYMENT_NOT_REVIEWED")
  ensure(typeof checkpointHash === "string" && /^0x[\da-fA-F]{64}$/.test(checkpointHash) && !/^0x0{64}$/.test(checkpointHash), "DEPLOYMENT_NOT_REVIEWED")
  return deployment
}

function isZeroAddress(value: string) {
  return /^0x0{40}$/i.test(value)
}

/** Read-only wallet ports over one captured injected source. Provider messages are never surfaced. */
export function createWalletSourcePorts(input: { source: CapturedWalletSource; deployment: () => ReviewedDeployment | null }): SourcePorts {
  const { source } = input
  let attestation: Attestation | null = null

  function current() {
    ensure(source.isCurrent(), "WALLET_CHANGED")
  }

  async function call(method: string, params: readonly unknown[]) {
    current()
    try { return await source.request({ method, params }) } catch { throw new StocksWalletError("REQUEST_FAILED") }
  }

  async function checkChain() {
    const value = await call("eth_chainId", [])
    ensure(typeof value === "string" && QUANTITY.test(value), "INVALID_RESPONSE")
    ensure(BigInt(value) === CHAIN_ID, "WALLET_NETWORK_INSTANCE_MISMATCH")
  }

  async function checkAccount() {
    const accounts = await call("eth_accounts", [])
    ensure(Array.isArray(accounts), "INVALID_RESPONSE")
    ensure(accounts.length > 0, "WALLET_CHANGED")
    const first = accounts[0]
    ensure(typeof first === "string" && isAddress(first) && !isZeroAddress(first), "INVALID_RESPONSE")
    ensure(same(first, source.address), "WALLET_CHANGED")
  }

  /** Same attestation as the server's RPC port: the checkpoint block binds networkInstance to this chain's history. */
  async function checkCheckpoint(deployment: ReviewedDeployment): Promise<Hex> {
    const number = `0x${BigInt(deployment.manifest.checkpointNumber).toString(16)}`
    const block = await call("eth_getBlockByNumber", [number, false])
    ensure(block !== null, "WALLET_NETWORK_INSTANCE_MISMATCH")
    ensure(typeof block === "object" && !Array.isArray(block), "INVALID_RESPONSE")
    const { number: observedNumber, hash } = block as Record<string, unknown>
    ensure(observedNumber === number, "INVALID_RESPONSE")
    ensure(typeof hash === "string" && BLOCK_HASH.test(hash) && !/^0x0{64}$/.test(hash), "INVALID_RESPONSE")
    ensure(hash === deployment.manifest.checkpointHash.toLowerCase(), "WALLET_NETWORK_INSTANCE_MISMATCH")
    return hash as Hex
  }

  async function checkNetwork(deployment: ReviewedDeployment) {
    await checkChain()
    await checkAccount()
    return checkCheckpoint(deployment)
  }

  function unchanged(deployment: ReviewedDeployment) {
    current()
    ensure(input.deployment()?.manifestDigest === deployment.manifestDigest, "CONTEXT_CHANGED")
  }

  async function attest(): Promise<WalletIdentity> {
    const deployment = reviewed(input.deployment())
    current()
    const checkpointHash = await checkNetwork(deployment)
    await checkChain()
    await checkAccount()
    unchanged(deployment)
    attestation = Object.freeze({ source, manifestDigest: deployment.manifestDigest, address: source.address })
    return { address: source.address, chainId: 91342, connectionEpoch: source.epoch, deploymentDigest: deployment.manifestDigest, networkInstance: deployment.manifest.networkInstance, checkpointHash }
  }

  async function readWallet() {
    try { return await attest() } catch (error) {
      attestation = null
      throw error instanceof StocksWalletError ? error : new StocksWalletError("INVALID_RESPONSE")
    }
  }

  function allowancePair(deployment: ReviewedDeployment, token: string, spender: string) {
    const m = deployment.manifest
    return (same(token, m.cashToken) && same(spender, m.fundingVault)) || (same(token, m.stockToken) && same(spender, m.redemptionEscrow))
  }

  async function allowance(request: Parameters<WalletPorts["readAllowance"]>[0]) {
    const { token, owner, spender, signal } = request
    const deployment = reviewed(input.deployment())
    ensure(request.chainId === 91342, "ALLOWANCE_SCOPE_MISMATCH")
    ensure(typeof owner === "string" && same(owner, source.address), "WALLET_CHANGED")
    ensure(typeof token === "string" && typeof spender === "string" && allowancePair(deployment, token, spender), "ALLOWANCE_SCOPE_MISMATCH")
    ensure(!signal.aborted, "CONTEXT_CHANGED")
    await checkNetwork(deployment)
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(owner), getAddress(spender)] })
    const result = await call("eth_call", [{ to: token, data }, "latest"])
    ensure(typeof result === "string" && WORD.test(result), "INVALID_RESPONSE")
    ensure(!signal.aborted, "CONTEXT_CHANGED")
    current()
    await checkChain()
    await checkAccount()
    ensure(!signal.aborted, "CONTEXT_CHANGED")
    unchanged(deployment)
    return BigInt(result).toString(10)
  }

  async function readAllowance(request: Parameters<WalletPorts["readAllowance"]>[0]) {
    try { return await allowance(request) } catch (error) {
      throw error instanceof StocksWalletError ? error : new StocksWalletError("INVALID_RESPONSE")
    }
  }

  function checkTransaction(tx: Transaction) {
    ensure(tx !== null && typeof tx === "object" && Object.keys(tx).sort().join() === TRANSACTION_KEYS, "TRANSACTION_MISMATCH")
    ensure(tx.chainId === 91342 && tx.value === "0", "TRANSACTION_MISMATCH")
    ensure(typeof tx.data === "string" && CALL_DATA.test(tx.data), "TRANSACTION_MISMATCH")
    const deployment = reviewed(input.deployment())
    const m = deployment.manifest
    ensure(typeof tx.to === "string" && [m.cashToken, m.stockToken, m.fundingVault, m.redemptionEscrow].some(target => same(target, tx.to)), "TRANSACTION_MISMATCH")
    current()
    ensure(attestation !== null && attestation.source === source && attestation.manifestDigest === deployment.manifestDigest, "WALLET_NOT_ATTESTED")
    ensure(typeof tx.from === "string" && same(tx.from, source.address) && same(tx.from, attestation.address), "WALLET_CHANGED")
  }

  /**
   * Not async: every check is synchronous, then exactly one raw eth_sendTransaction is issued before returning.
   * The provider's promise is returned unchanged, so a late hash is never discarded here.
   */
  function requestTransaction(tx: Transaction): Promise<unknown> {
    checkTransaction(tx)
    return source.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: "0x0" }] })
  }

  return {
    readWallet,
    readAllowance,
    requestTransaction,
    // Approval confirmation belongs to the server gate's reconcile; this port is deliberately inactive.
    waitApprovalReceipt: () => Promise.reject(new StocksWalletError("RECEIPT_PORT_INACTIVE")),
  }
}
