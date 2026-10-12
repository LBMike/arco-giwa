import { useState } from "react"
import { BrandMark } from "../components/BrandMark"
import { GiwaNetworkIcon } from "./components"
import { FundMark } from "./FundMark"
import {
  AmountBlock,
  AmountField,
  INVEST_CTA,
  INVEST_CTA_READY,
  INVEST_PANEL_CARD,
  INVEST_TAB,
  INVEST_TAB_ACTIVE,
  INVEST_TAB_INACTIVE,
  INVEST_TAB_TRACK,
  InfoRow,
} from "./invest-panel-ui"
import type { ListedFund } from "./listed-funds"

type Tab = "invest" | "redeem" | "pending"

// The deployed vaults' Invest / Redeem panel for a fund that has no GIWA contract yet: the same
// tabs and fields with the fund's terms, and the action reads "Coming soon".
export function ListedFundInvestPanel({ fund }: { fund: ListedFund }) {
  const [tab, setTab] = useState<Tab>("invest")
  const usdc = { symbol: "USDC", icon: <BrandMark src="/logos/usdc.svg" label="USDC" size={18} /> }
  const token = { symbol: fund.symbol, icon: <FundMark fund={fund} size={18} /> }
  const pay = tab === "redeem" ? token : usdc
  const receive = tab === "redeem" ? usdc : token

  return (
    <div className={`lg:sticky lg:top-[104px] ${INVEST_PANEL_CARD}`} data-testid="listed-fund-panel">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] px-2.5 py-1 text-xs text-[var(--color-arco-text-soft)]">
          <GiwaNetworkIcon size={14} />
          GIWA
        </span>
      </div>

      <div className={`mt-3 grid grid-cols-3 ${INVEST_TAB_TRACK}`}>
        {(["invest", "redeem", "pending"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={`${INVEST_TAB} capitalize ${tab === item ? INVEST_TAB_ACTIVE : INVEST_TAB_INACTIVE}`}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "pending" ? (
          <p className="py-6 text-center text-sm text-[var(--color-arco-muted)]">No pending redemptions.</p>
        ) : (
          <>
            <AmountBlock>
              <AmountField
                caption={tab === "redeem" ? "Amount to redeem" : "You pay"}
                symbol={pay.symbol}
                icon={pay.icon}
                value="0"
                display
                balance="--"
                subValue="~$0.00"
                copyButton={false}
              />
              <AmountField
                caption="You receive"
                symbol={receive.symbol}
                icon={receive.icon}
                value="0"
                display
                balance="--"
                subValue="~$0.00"
                copyButton={false}
              />
            </AmountBlock>
            <div className="mt-3">
              <InfoRow label="Minimum investment" value={fund.minInvestment} />
              <InfoRow label="Redemption Timeline" value={`${fund.redemptionDays} Days`} />
              <InfoRow label="Management fee" value={fund.fees.management != null ? `${fund.fees.management}%` : "—"} />
            </div>
          </>
        )}
      </div>

      <button type="button" disabled className={`${INVEST_CTA} ${INVEST_CTA_READY}`}>
        Coming soon
      </button>
    </div>
  )
}
