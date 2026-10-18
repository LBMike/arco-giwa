import { useMemo, useRef, useState } from "react"
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
  receivedTokenAmount,
  submitProductOperation,
  submitRouterBuy,
  toBaseUnits,
  waitForSuccessfulReceipt,
} from "./contracts"
import { pauseStateOf } from "./catalog"
import { fundBuyRoute, isFundProduct, RESERVE_REFILL_NOTICE, selectedPayAsset } from "./arcousd-buy"
import { GIWA_LIVE_REFETCH } from "./config"
import { vaultAddressForOperation, type ProductOperation } from "./operation-routing"
import {
  displayAmount,
  initialOperationSteps,
  isRequestOperation,
  runOperationFlow,
  type OperationFlow,
  type OperationReview,
  type StepOutcome,
} from "./operation-flow"
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

const BUSY_PHASES: readonly UiPhase[] = ["approving", "simulating", "submitting", "confirming"]

function requiredAddress(value: HexAddress | null | undefined, label: string): HexAddress {
  if (!value) throw new Error(`${label} address is missing`)
  return value
}

// Container hook for the invest/redeem panel: every per-product read, the operation state, and the
// approve/submit/claim handlers, returning exactly the props GiwaInvestPanel needs. A press of the
// primary action opens the transaction modal (`flow`, rendered once per page by GiwaOperationModal),
// which runs the approval when needed and then the operation; the panel keeps its INLINE status
// (error / successLabel / txHashes) as well.
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
  const [flow, setFlow] = useState<OperationFlow | null>(null)
  const flowSeq = useRef(0)
  // The flow the user closed while it was running: what it already sent may finish, but it asks the wallet for nothing more.
  const closedFlow = useRef<number | null>(null)
  // The pay asset a running (or failed) flow was started with (Router buys).
  const flowPayKey = useRef<string | null>(null)

  const walletEnabled = Boolean(wallet.address)
  const paymentDecimals = product.paymentAsset?.decimals ?? 18

  // ArcoUSD: a fund the ArcoRouter may buy is paid with any Reserve stablecoin or ArcoUSD, through
  // the Router (which then holds the allowance), and is blocked while the buy gate is closed. Any
  // other product — or no Router yet, or this read failing — keeps the direct vault deposit.
  const reserveQuery = useQuery({
    queryKey: ["giwa", "arcousd", "reserve"],
    queryFn: () => giwaApi.arcousd.reserve(),
    ...GIWA_LIVE_REFETCH,
  })
  const route = useMemo(() => fundBuyRoute(product, reserveQuery.data), [product, reserveQuery.data])
  // Until the first answer a fund's route is unknown: its buy waits ("Loading…") instead of
  // assuming the direct path. If the API cannot answer at all there is no Router address to use,
  // so the fund keeps the direct vault deposit (which never touches the Reserve).
  const routeUnknown = isFundProduct(product) && reserveQuery.isPending
  const [payAssetKey, setPayAssetKey] = useState<string | null>(null)
  const payAsset = selectedPayAsset(route, payAssetKey)
  const routed = route.kind === "router"
  // What the invest side pays with and who must be allowed to pull it.
  const payToken: HexAddress | null = (routed ? payAsset?.address : product.paymentAssetAddress) ?? null
  const payDecimals = routed ? (payAsset?.decimals ?? 18) : paymentDecimals
  const spender: HexAddress | null = (route.kind === "router" ? route.router : product.depositVaultAddress) ?? null

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
  // The selected Router pay asset's balance (the fund's own payment-asset balance above still backs
  // the redeem side, which always pays out in it).
  const payBalanceQuery = useQuery({
    queryKey: ["giwa", "payment-balance-one", wallet.address, payToken],
    queryFn: () => readTokenBalance(payToken!, wallet.address!, payDecimals),
    enabled: Boolean(routed && wallet.address && payToken),
  })
  const productBalanceQuery = useQuery({
    queryKey: ["giwa", "product-balance", wallet.address, product.productTokenAddress],
    queryFn: () => readTokenBalance(product.productTokenAddress!, wallet.address!, 18),
    enabled: Boolean(wallet.address && product.productTokenAddress),
  })
  // Shared between the query and the post-approve setQueryData — MUST stay identical, or the
  // cache write after approval is silently ignored and the stale-read guard stops working.
  const allowanceQueryKey = ["giwa", "allowance", wallet.address, payToken, spender]
  const allowanceQuery = useQuery({
    queryKey: allowanceQueryKey,
    queryFn: () => readAllowance(payToken!, wallet.address!, spender!, payDecimals),
    enabled: Boolean(wallet.address && payToken && spender),
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
  const amountDecimals = usesPaymentAmount ? payDecimals : 18
  const amountBase = useMemo(() => toBaseUnits(amount, amountDecimals), [amount, amountDecimals])
  const activeVault = vaultAddressForOperation(product, operation)
  const allowanceRequired = Boolean(usesPaymentAmount && allowanceQuery.data && spender && allowanceQuery.data.raw < amountBase)
  // Not read yet (e.g. right after switching the pay asset): the flow approves rather than skip a
  // step the buy may need.
  const allowanceUnknown = Boolean(usesPaymentAmount && wallet.address && payToken && spender && allowanceQuery.data === undefined)

  const phase: UiPhase =
    wallet.phase === "disconnected" || wallet.phase === "wrong-network" || wallet.phase === "missing-gas"
      ? wallet.phase
      : !product.paymentAssetAddress || !product.paymentAsset
        ? "missing-payment-token"
        : usesPaymentAmount && routeUnknown && operationPhase === "ready"
          ? "loading-registry"
        : operationPhase !== "ready"
          ? operationPhase
          : allowanceRequired
            ? "allowance-required"
            : operationPhase

  // Per-vault function pause (catalog pauseState): deposit entry paths and redeem entry
  // paths are paused as pairs; claimRedeem is never blocked so requested redemptions
  // stay claimable.
  // A Router fund also stops buying while the ArcoUSD buy gate is closed (reserve buffer short,
  // a pause on the buy path, or the reserve unreadable).
  const pause = pauseStateOf(product)
  const pausedNotice =
    (operation === "deposit" || operation === "requestDeposit") && pause.depositPaused
      ? "Deposits are temporarily paused"
      : (operation === "deposit" || operation === "requestDeposit") && route.kind === "router" && route.gateClosed
        ? RESERVE_REFILL_NOTICE
        : (operation === "redeemInstant" || operation === "requestRedeem") && pause.withdrawPaused
          ? "Withdrawals are temporarily paused"
          : null

  async function refreshReads() {
    await wallet.refreshBalance()
    await Promise.all([
      allowanceQuery.refetch(),
      paymentBalanceQuery.refetch(),
      ...(routed ? [payBalanceQuery.refetch()] : []),
      productBalanceQuery.refetch(),
      redemptionsQuery.refetch(),
      faucetQuery.refetch(),
    ])
  }

  async function waitForReceipts(hashes: HexAddress[]) {
    setOperationPhase("confirming")
    let last: Awaited<ReturnType<typeof waitForSuccessfulReceipt>> | null = null
    for (const hash of hashes) {
      last = await waitForSuccessfulReceipt(hash)
    }
    await refreshReads()
    return last
  }

  // The GIWA testnet RPC can serve the PRE-approve allowance right after the tx confirms; poll
  // until the read reflects the approval so the UI never flips to "Invest" on a stale value
  // (bounded: ~8 tries x 750ms, then proceed without a cache write).
  async function waitForAllowanceAtLeast(minimum: bigint) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const allowance = await readAllowance(payToken!, wallet.address!, spender!, payDecimals)
      if (allowance.raw >= minimum) return allowance
      await sleep(750)
    }
    return null
  }

  // `onSent` fires when the wallet has sent the transaction (the modal's step turns from "in your wallet" to pending).
  async function approveDepositVault(onSent?: () => void): Promise<StepOutcome> {
    if (!wallet.address) return { ok: false, message: "Connect your wallet first." }
    setOperationError(null)
    setSuccessLabel(null)
    setTxHashes([])
    try {
      if (!payToken || !spender) throw new Error("Registry address is missing")
      setOperationPhase("approving")
      // Unlimited approval: one approve covers every future deposit into this vault (or, for a
      // Router fund, every buy paid in this asset).
      const hash = await approveVault({
        account: wallet.address,
        token: payToken,
        vault: spender,
        amount: maxUint256,
      })
      setTxHashes([hash])
      onSent?.()
      await afterConfirmedReceipt(hash, refreshReads)
      // Phase stays "approving" (button disabled) until the allowance is confirmed on-chain.
      const confirmed = await waitForAllowanceAtLeast(amountBase)
      if (confirmed) queryClient.setQueryData(allowanceQueryKey, confirmed)
      setSuccessLabel("Approval confirmed")
      setOperationPhase("success")
      return { ok: true, hash }
    } catch (err) {
      const message = readableError(err)
      setOperationPhase("failed")
      setOperationError(message)
      return { ok: false, message }
    }
  }

  async function submitOperation(nextOperation = operation, nextRequestId = requestId, onSent?: () => void): Promise<StepOutcome> {
    if (!wallet.address) return { ok: false, message: "Connect your wallet first." }
    const account = wallet.address
    setOperationError(null)
    setSuccessLabel(null)
    setTxHashes([])
    try {
      setOperationPhase("simulating")
      const buying = nextOperation === "deposit" || nextOperation === "requestDeposit"
      const hash =
        buying && route.kind === "router"
          ? await submitRouterBuy({
              account,
              router: route.router,
              payAsset: requiredAddress(payAsset?.address, "Pay asset"),
              amount: amountBase,
              depositVault: requiredAddress(product.depositVaultAddress, "Deposit vault"),
              request: nextOperation === "requestDeposit",
            })
          : await submitProductOperation({
              account,
              product,
              operation: nextOperation,
              amount: amountBase,
              requestId: BigInt(nextRequestId || "0"),
            })
      setTxHashes([hash])
      onSent?.()
      const receipt = await waitForReceipts([hash])
      const label = confirmLabel(nextOperation)
      setSuccessLabel(label)
      setOperationPhase(nextOperation === "requestRedeem" ? "pending-redemption" : "success")
      // What actually arrived, read from the receipt's Transfer logs: shares on a deposit, the payment asset on an
      // instant redemption. A request pays nothing yet.
      const credited =
        nextOperation === "deposit"
          ? { token: product.productTokenAddress, decimals: 18 }
          : nextOperation === "redeemInstant"
            ? { token: product.paymentAssetAddress, decimals: paymentDecimals }
            : null
      const received = credited === null ? null : receivedTokenAmount(receipt, credited.token, account, credited.decimals)
      return { ok: true, hash, received: received === null ? null : displayAmount(received) }
    } catch (err) {
      const message = readableError(err)
      setOperationPhase("failed")
      setOperationError(message)
      return { ok: false, message }
    }
  }

  function updateFlow(id: number, update: (current: OperationFlow) => OperationFlow) {
    setFlow((current) => (current !== null && current.id === id ? update(current) : current))
  }

  // One press of the primary action: the modal opens and runs the approval (when the vault may not take the amount
  // yet), then the operation, one wallet request at a time.
  function startFlow(review: OperationReview) {
    if (!wallet.address || BUSY_PHASES.includes(operationPhase)) return
    const buying = review.operation === "deposit" || review.operation === "requestDeposit"
    // Never start a buy the panel would refuse (closed gate, paused vault, route unknown).
    if (buying && (pausedNotice || routeUnknown)) return
    const id = flowSeq.current + 1
    flowSeq.current = id
    closedFlow.current = null
    flowPayKey.current = payAsset?.key ?? null
    const withApproval = (allowanceRequired || allowanceUnknown) && buying
    setFlow({ id, review, steps: initialOperationSteps(withApproval), outcome: null, open: true })
    void runOperationFlow({
      approve: withApproval ? (onSent) => approveDepositVault(onSent) : null,
      submit: (onSent) => submitOperation(review.operation, requestId, onSent),
      stopped: () => closedFlow.current === id,
      step: (step, state) =>
        updateFlow(id, (current) => ({ ...current, steps: current.steps.map((entry) => (entry.id === step ? { ...entry, state } : entry)) })),
      finish: (outcome) => updateFlow(id, (current) => ({ ...current, outcome })),
      requested: isRequestOperation(review.operation),
    })
  }

  // Closing a finished flow forgets it. Closing a running one hides it: a transaction already sent still finishes (the
  // panel shows the result inline), but no new wallet request starts.
  function closeFlow() {
    if (flow === null) return
    const id = flow.id
    if (flow.outcome === null) {
      closedFlow.current = id
      updateFlow(id, (current) => ({ ...current, open: false }))
    } else {
      setFlow((current) => (current !== null && current.id === id ? null : current))
    }
  }

  // Retry repeats the same buy only if nothing it depends on changed meanwhile: a gate that closed
  // or a pay asset that is no longer the one the modal names closes the modal instead, so the
  // panel (with its notice or the current asset) is what the user acts on next.
  function retryFlow() {
    if (flow === null || flow.outcome?.kind !== "failed") return
    const buying = flow.review.operation === "deposit" || flow.review.operation === "requestDeposit"
    if (buying && (pausedNotice || routeUnknown || (payAsset?.key ?? null) !== flowPayKey.current)) {
      setFlow(null)
      return
    }
    startFlow(flow.review)
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
    // ArcoRouter fund buys: the pay-asset choices (empty when not routed), the selected one and
    // its balance.
    routed,
    payAssets: route.kind === "router" ? route.payAssets : [],
    payAsset,
    payBalance: routed ? (payBalanceQuery.data ?? "--") : undefined,
    onPayAssetChange: (key: string) => {
      setPayAssetKey(key)
      setOperationError(null)
      setSuccessLabel(null)
      if (!BUSY_PHASES.includes(operationPhase)) setOperationPhase("ready")
    },
    flow,
    onStart: startFlow,
    onFlowClose: closeFlow,
    onFlowRetry: retryFlow,
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
