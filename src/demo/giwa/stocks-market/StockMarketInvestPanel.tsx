import { useState } from "react"
import { AmountBlock, AmountField, InfoRow, INVEST_CTA, INVEST_CTA_READY } from "../invest-panel-ui"
import { StockInvestSurface, type StockInvestTab } from "../stocks-investor/StockInvestSurface"
import { isDecimalKeystroke, parseHumanDecimal, formatBaseUnits } from "../stocks-investor/decimal"
import type { GiwaStocksAccess } from "../stocks-investor/access"
import type { Quote } from "./contracts"
import { StockLogo } from "./StockLogo"
import { priceLabel } from "./display"

/** Display estimate only, rounded down to the output asset's scale. Never used by the order client. */
export function stockDisplayEstimate(amount: string, price: string | null, sell: boolean): string | null {
  const input = parseHumanDecimal(amount, sell ? 9 : 6)
  const rate = price === null ? null : parseHumanDecimal(price, 18)
  if (!input.ok || !rate?.ok) return null
  const units = sell ? BigInt(input.baseUnits) * BigInt(rate.baseUnits) / 10n ** 21n : BigInt(input.baseUnits) * 10n ** 21n / BigInt(rate.baseUnits)
  if (units > 10n ** 30n) return null
  return formatBaseUnits(units.toString(), sell ? 6 : 9)
}

/** Compact UI output; the exact estimate remains separate from presentation and is never submitted. */
export function stockEstimateLabel(value: string | null): string {
  if (value === null) return "—"
  const [whole, fraction = ""] = value.split(".")
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0")) + (Number(fraction[2] ?? "0") >= 5 ? 1n : 0n)
  if (cents === 0n && /[1-9]/.test(value)) return "<0.01"
  return formatBaseUnits(cents.toString(), 2)
}

/** Selected-symbol presentation for instruments with no order API. No NVDA fallback, wallet signing or order submission. */
export function StockMarketInvestPanel({ symbol, quote, access }: { symbol: string; quote: Quote | null; access: GiwaStocksAccess }) {
  const [tab, setTab] = useState<StockInvestTab>("BUY")
  const [amount, setAmount] = useState("")
  const price = quote?.symbol === symbol && quote.status === "AVAILABLE" ? quote.price : null
  const sell = tab === "SELL"
  const estimate = stockDisplayEstimate(amount, price, sell)
  const stockIcon = <span className="inline-flex size-[18px] shrink-0 [&>span]:size-[18px] [&>span]:text-[9px]"><StockLogo symbol={symbol} size={32} /></span>
  const cashIcon = <img src="/logos/usdc.svg" alt="" width={18} height={18} />
  const connect = access.wallet === "disconnected" ? access.connectWallet : undefined
  return <StockInvestSurface symbol={symbol} tab={tab} onTab={value => { if (value !== tab) setAmount(""); setTab(value) }}>
    {tab === "ORDERS" ? <p className="py-8 text-center text-sm text-[var(--color-arco-muted)]">Orders for {symbol} will appear here.</p> : <>
      <AmountBlock>
        <AmountField ariaLabel={sell ? `${symbol} quantity to sell` : `USDC amount to buy ${symbol}`} caption={sell ? "You sell" : "You pay"} symbol={sell ? symbol : "USDC"} icon={sell ? stockIcon : cashIcon} value={amount} onChange={setAmount} filter={value => isDecimalKeystroke(value, sell ? 9 : 6)} balance="--" copyButton={false} inputProps={{ maxLength: 40 }} />
        <AmountField caption="You receive" symbol={sell ? "USDC" : symbol} icon={sell ? cashIcon : stockIcon} value={stockEstimateLabel(estimate)} display balance="--" copyButton={false} subValue={estimate !== null ? "Estimated" : undefined} />
      </AmountBlock>
      <div className="mt-3">
        <InfoRow label="Market price" value={`${priceLabel(price)} / ${symbol}`} />
        <InfoRow label="Transaction Fees" value="—" />
      </div>
      <button type="button" className={`${INVEST_CTA} ${INVEST_CTA_READY}`} disabled={!connect} onClick={connect}>{connect ? "Connect Wallet" : "Trading coming soon"}</button>
    </>}
  </StockInvestSurface>
}
