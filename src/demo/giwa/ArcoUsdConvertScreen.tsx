// Get ArcoUSD's screen (GetArcoUsd.tsx loads it on the first press): converts a stablecoin to ArcoUSD one for one, or
// ArcoUSD back to a stablecoin, on the Savings transfer screen titled Convert (SavingsTransferFlow `convert`).

import { useEffect, useMemo, useState } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import {
  ARCOUSD_OPTION,
  CONVERT_OPTIONS,
  convertChoices,
  converterFor,
  convertProduct,
  defaultConvertOption,
  type ArcoUsdConvert,
  type ConvertBalances,
  type ConvertDirection,
} from "./arcousd-convert"
import { readTokenBalance } from "./contracts"
import { SavingsTransferFlow } from "./SavingsTransferFlow"
import type { HexAddress } from "./types"
import { useGiwaProductOperation } from "./useGiwaProductOperation"
import { useGiwaWallet } from "./wallet"

/** One ArcoUSD is a dollar, as is each stablecoin it converts with. */
const PEG = { navBase: 1, baseUsd: 1, navUsd: 1, apy: null, impliedApy: null } as const

/**
 * The wallet's balance of every coin a conversion lists, ArcoUSD included. The same query keys as the operation hook's
 * payment balance and the Savings card's coins, so they all move together.
 */
function useConvertBalances(convert: ArcoUsdConvert, account: HexAddress | null): ConvertBalances {
  const sources = [
    ...CONVERT_OPTIONS.map((option) => ({ key: option.key, token: converterFor(convert, option.key)?.token ?? null, decimals: option.decimals })),
    { key: ARCOUSD_OPTION.key, token: convert.token, decimals: ARCOUSD_OPTION.decimals },
  ]
  const results = useQueries({
    queries: sources.map(({ token, decimals }) => ({
      queryKey: ["giwa", "payment-balance-one", account, token],
      queryFn: () => readTokenBalance(token!, account!, decimals),
      enabled: Boolean(account && token),
    })),
  })
  return Object.fromEntries(
    sources.map(({ key }, index) => {
      const raw = results[index]?.data
      const parsed = raw != null ? Number(raw) : null
      return [key, parsed !== null && Number.isFinite(parsed) ? parsed : null]
    }),
  )
}

/** The Convert screen: a stablecoin to ArcoUSD (`in`), or ArcoUSD back to the coin picked (`out`). */
export default function ArcoUsdConvertScreen({ convert, open, onClose }: { convert: ArcoUsdConvert; open: boolean; onClose: () => void }) {
  const wallet = useGiwaWallet()
  const queryClient = useQueryClient()
  const [direction, setDirection] = useState<ConvertDirection>("in")
  const [coinKey, setCoinKey] = useState(() => defaultConvertOption(convert).key)
  const coin = CONVERT_OPTIONS.find((option) => option.key === coinKey && converterFor(convert, option.key) !== null) ?? defaultConvertOption(convert)
  const converter = converterFor(convert, coin.key)!
  const product = useMemo(() => convertProduct(convert, coin, converter), [convert, coin, converter])
  const panel = useGiwaProductOperation(product)
  const balances = useConvertBalances(convert, wallet.address)

  // A conversion moves two coins, and ArcoUSD is read under the token key here: refresh every coin balance once one is
  // done (the Savings card and the pickers read them).
  const { phase } = panel
  const account = wallet.address
  useEffect(() => {
    if (phase === "success" && account) void queryClient.invalidateQueries({ queryKey: ["giwa", "payment-balance-one", account] })
  }, [phase, account, queryClient])

  return (
    <SavingsTransferFlow
      open={open}
      mode={direction === "in" ? "deposit" : "withdraw"}
      onClose={onClose}
      detail={{
        panel,
        market: { productId: product.productId, ...PEG },
        // Back to a coin on the Reserve takes at most its free buffer in that coin (a dollar each).
        instantLiquidityUsd: direction === "out" ? (converter.instantLiquidity ?? null) : null,
        baseUsd: PEG.baseUsd,
        vaultImage: undefined,
      }}
      paySymbol={coin.symbol}
      payIcon={coin.logo}
      payChain={coin.chain}
      assetPicker={{ choices: convertChoices(convert, balances, false), selected: coin.key, onSelect: setCoinKey }}
      convert={{
        onFlip: () => setDirection((current) => (current === "in" ? "out" : "in")),
        payPicker: {
          choices: convertChoices(convert, balances, true),
          selected: direction === "in" ? coin.key : ARCOUSD_OPTION.key,
          // ArcoUSD turns the conversion around (back to the coin in use); a coin converts that coin to ArcoUSD.
          onSelect: (key) => {
            if (key === ARCOUSD_OPTION.key) {
              setDirection("out")
              return
            }
            setCoinKey(key)
            setDirection("in")
          },
        },
      }}
      tokenSymbol={ARCOUSD_OPTION.symbol}
      tokenIcon={ARCOUSD_OPTION.logo}
      apyPercent={null}
      apyText="—"
      savingsUsd={null}
      recipient={wallet.address}
    />
  )
}
