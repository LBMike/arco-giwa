import { FeaturedFunds } from "./FeaturedFunds"
import { FundsList } from "./FundsList"
import { FUNDS_LINEUP } from "./funds-lineup"

// The Funds page: Featured Funds on top, then the list with its All Funds / Credit / Equity tabs. Both show the same
// lineup (funds-lineup.ts), so the page needs no live reads; each fund's own page carries its details.
export default function GiwaInvestorPage() {
  return (
    <div className="w-full space-y-12">
      <FeaturedFunds funds={FUNDS_LINEUP} />
      <FundsList funds={FUNDS_LINEUP} />
    </div>
  )
}
