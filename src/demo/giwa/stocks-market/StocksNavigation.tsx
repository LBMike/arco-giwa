import { Link } from "react-router-dom"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"

const link = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
/** Shared by the customer /stocks page and the legacy /admin/stocks page, in its own module so neither loads the other. */
export function StocksNavigation() { return <nav aria-label="Stocks navigation" className="flex flex-wrap gap-2"><Link className={link} to={GIWA_STOCKS_ROUTE}>Stocks market data and mock trading</Link><Link className={link} to={GIWA_ADMIN_STOCKS_ROUTE}>Stocks admin view</Link></nav> }
