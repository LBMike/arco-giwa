import { useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { maxUint256 } from "viem"
import { giwaApi } from "./api"
import {
  afterConfirmedReceipt,
  approveVault,
  readAllowance,
  readableError,
  readGreenlistEnforced,
  readPriceFeedState,
  readTokenBalance,
  submitProductOperation,
  toBaseUnits,
  waitForSuccessfulReceipt,
} from "./contracts"
import { pauseStateOf } from "./catalog"
import { vaultAddressForOperation, type ProductOperation } from "./operation-routing"
import { fromAnswer } from "./price-policy"
import type { GiwaCatalogItem, HexAddress, UiPhase } from "./types"
import { useGiwaWallet } from "./wallet"

const DEFAULT_OPERATION: ProductOperation = "deposit"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function confirmLabel(operation: ProductOperation): string {
  switch (operation) {
    case "deposit":
      return "Invest confirmed"
    case "requestDeposit":
      return "Deposit request confirmed"
    case "redeemInstant":
      return "Redeem confirmed"
    case "requestRedeem":
      return "Redemption requested"
    case "claimRedeem":
      return "Redemption claimed"
    default:
      return "Transaction confirmed"
  }
}

// Container hook for the invest/redeem panel: every per-product read, the operation state, and the
// approve/submit/claim handlers, returning exactly the props GiwaInvestPanel needs. Feedback is
// INLINE status only (error / successLabel / txHashes) — no toasts, matching current behavior.
export function useGiwaProductOperation(product: GiwaCatalogItem) {
  const wallet = useGiwaWallet()
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState("1")
  const [requestId, setRequestId] = useState("1")
  const [operation, setOperation] = useState<ProductOperation>(DEFAULT_OPERATION)
  const [txHashes, setTxHashes] = useState<string[]>([])
  const [operationPhase, setOperationPhase] = useState<UiPhase>("ready")
  const [operationError, setOperationError] = useState<string | null>(null)
  const [successLabel, setSuccessLabel] = useState<string | null>(null)

  const walletEnabled = Boolean(wallet.address)
  const paymentDecimals = product.paymentAsset?.decimals ?? 18

  const redemptionsQuery = useQuery({
    queryKey: ["giwa", "redemptions", wallet.address],
    queryFn: () => giwaApi.redemptions(wallet.address!),
    enabled: walletEnabled,
  })
  const faucetQuery = useQuery({
    queryKey: ["giwa", "faucet", wallet.address],
    queryFn: () => giwaApi.faucetStatus(wallet.address!),
    enabled: walletEnabled,
  })
  const paymentBalanceQuery = useQuery({
    queryKey: ["giwa", "payment-balance-one", wallet.address, product.paymentAssetAddress],
    queryFn: () => readTokenBalance(product.paymentAssetAddress!, wallet.address!, paymentDecimals),
    enabled: Boolean(wallet.address && product.paymentAssetAddress),
  })
  const productBalanceQuery = useQuery({
    queryKey: ["giwa", "product-balance", wallet.address, product.productTokenAddress],
    queryFn: () => readTokenBalance(product.productTokenAddress!, wallet.address!, 18),
    enabled: Boolean(wallet.address && product.productTokenAddress),
  })
  // Shared between the query and the post-approve setQueryData — MUST stay identical, or the
  // cache write after approval is silently ignored and the stale-read guard stops working.
  const allowanceQueryKey = ["giwa", "allowance", wallet.address, product.paymentAssetAddress, product.depositVaultAddress]
  const allowanceQuery = useQuery({
    queryKey: allowanceQueryKey,
    queryFn: () => readAllowance(product.paymentAssetAddress!, wallet.address!, product.depositVaultAddress!, paymentDecimals),
    enabled: Boolean(wallet.address && product.paymentAssetAddress && product.depositVaultAddress),
  })
  const greenlistEnforcedQuery = useQuery({
    queryKey: ["giwa", "greenlist-enforced", product.productTokenAddress],
    queryFn: () => readGreenlistEnforced(product.productTokenAddress!),
    enabled: Boolean(product.productTokenAddress),
    retry: 0,
  })
  const priceFeedQuery = useQuery({
    queryKey: ["giwa", "price-feed", product.priceFeedAddress],
    queryFn: () => readPriceFeedState(product.priceFeedAddress!),
    enabled: Boolean(product.priceFeedAddress),
  })
  const sharePrice = priceFeedQuery.data ? fromAnswer(priceFeedQuery.data.answer) : null

  const usesPaymentAmount = operation === "deposit" || operation === "requestDeposit"
  const amountDecimals = usesPaymentAmount ? paymentDecimals : 18
  const amountBase = useMemo(() => toBaseUnits(amount, amountDecimals), [amount, amountDecimals])
  const activeVault = vaultAddressForOperation(product, operation)
  const allowanceRequired = Boolean(
    usesPaymentAmount && allowanceQuery.data && product.depositVaultAddress && allowanceQuery.data.raw < amountBase,
  )

  const phase: UiPhase =
    wallet.phase === "disconnected" || wallet.phase === "wrong-network" || wallet.phase === "missing-gas"
      ? wallet.phase
      : !product.paymentAssetAddress || !product.paymentAsset
        ? "missing-payment-token"
        : operationPhase !== "ready"
          ? operationPhase
          : allowanceRequired
            ? "allowance-required"
            : operationPhase

  // Per-vault function pause (catalog pauseState): deposit entry paths and redeem entry
  // paths are paused as pairs; claimRedeem is never blocked so requested redemptions
  // stay claimable.
  const pause = pauseStateOf(product)
  const pausedNotice =
    (operation === "deposit" || operation === "requestDeposit") && pause.depositPaused
      ? "Deposits are temporarily paused"
      : (operation === "redeemInstant" || operation === "requestRedeem") && pause.withdrawPaused
        ? "Withdrawals are temporarily paused"
        : null

  async function refreshReads() {
    await wallet.refreshBalance()
    await Promise.all([
      allowanceQuery.refetch(),
      paymentBalanceQuery.refetch(),
      productBalanceQuery.refetch(),
      redemptionsQuery.refetch(),
      faucetQuery.refetch(),
    ])
  }

  async function waitForReceipts(hashes: HexAddress[]) {
    setOperationPhase("confirming")
    for (const hash of hashes) {
      await waitForSuccessfulReceipt(hash)
    }
    await refreshReads()
  }

  // The GIWA testnet RPC can serve the PRE-approve allowance right after the tx confirms; poll
  // until the read reflects the approval so the UI never flips to "Invest" on a stale value
  // (bounded: ~8 tries x 750ms, then proceed without a cache write).
  async function waitForAllowanceAtLeast(minimum: bigint) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const allowance = await readAllowance(product.paymentAssetAddress!, wallet.address!, product.depositVaultAddress!, paymentDecimals)
      if (allowance.raw >= minimum) return allowance
      await sleep(750)
    }
    return null
  }

  async function approveDepositVault() {
    if (!wallet.address) return
    setOperationError(null)
    setSuccessLabel(null)
    setTxHashes([])
    try {
      if (!product.paymentAssetAddress || !product.depositVaultAddress) throw new Error("Registry address is missing")
      setOperationPhase("approving")
      // Unlimited approval: one approve covers every future deposit into this vault.
      const hash = await approveVault({
        account: wallet.address,
        token: product.paymentAssetAddress,
        vault: product.depositVaultAddress,
        amount: maxUint256,
      })
      setTxHashes([hash])
      await afterConfirmedReceipt(hash, refreshReads)
      // Phase stays "approving" (button disabled) until the allowance is confirmed on-chain.
      const confirmed = await waitForAllowanceAtLeast(amountBase)
      if (confirmed) queryClient.setQueryData(allowanceQueryKey, confirmed)
      setSuccessLabel("Approval confirmed")
      setOperationPhase("success")
    } catch (err) {
      setOperationPhase("failed")
      setOperationError(readableError(err))
    }
  }

  async function submitOperation(nextOperation = operation, nextRequestId = requestId) {
    if (!wallet.address) return
    setOperationError(null)
    setSuccessLabel(null)
    setTxHashes([])
    try {
      setOperationPhase("simulating")
      const hash = await submitProductOperation({
        account: wallet.address,
        product,
        operation: nextOperation,
        amount: amountBase,
        requestId: BigInt(nextRequestId || "0"),
      })
      setTxHashes([hash])
      await waitForReceipts([hash])
      const label = confirmLabel(nextOperation)
      setSuccessLabel(label)
      setOperationPhase(nextOperation === "requestRedeem" ? "pending-redemption" : "success")
    } catch (err) {
      setOperationPhase("failed")
      setOperationError(readableError(err))
    }
  }

  function claimRedemption(nextRequestId: string) {
    setOperation("claimRedeem")
    setRequestId(nextRequestId)
    void submitOperation("claimRedeem", nextRequestId)
  }

  return {
    product,
    price: sharePrice,
    operation,
    amount,
    requestId,
    paymentBalance: paymentBalanceQuery.data ?? "--",
    productBalance: productBalanceQuery.data ?? "--",
    allowance: allowanceQuery.data?.display ?? "--",
    allowanceRequired,
    greenlistEnforced: greenlistEnforcedQuery.data ?? false,
    activeVault,
    phase,
    pausedNotice,
    error: operationError,
    txHashes,
    successLabel,
    pendingRedemptions: redemptionsQuery.data ?? [],
    onOperationChange: (next: ProductOperation) => {
      setOperation(next)
      setOperationError(null)
      setSuccessLabel(null)
      setOperationPhase("ready")
    },
    onAmountChange: setAmount,
    onRequestIdChange: setRequestId,
    onApprove: () => void approveDepositVault(),
    onSubmit: () => void submitOperation(),
    // Redeem fallback: when instant liquidity can't cover the payout, the panel routes here
    // to submit a redemption REQUEST instead of reverting. On the redeem tab `amountBase` is
    // already 18-dec shares, so requestRedeem receives the correct sharesIn.
    onRequestRedeem: () => void submitOperation("requestRedeem"),
    onClaim: claimRedemption,
    onConnect: () => void wallet.connect(),
    onSwitchNetwork: () => void wallet.switchToGiwa(),
  }
}
