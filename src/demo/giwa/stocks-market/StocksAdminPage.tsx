import { useContext } from "react"
import { GiwaStocksAdminFeature } from "../stocks-admin"
import { StocksSignIn, useGiwaStocksHost } from "../stocks-host"
import { GiwaStocksTradingControlFeature } from "../stocks-trading-control"
import { StocksPageEnvironment, usePageApiBase } from "./environment"
import { StocksNavigation } from "./StocksNavigation"
/**
 * The legacy in-app Stocks operator page (/admin/stocks), in its own module so the customer /stocks chunk carries no
 * admin code and a build with VITE_ADMIN_CONSOLE_URL leaves it out entirely (see ./routes).
 *
 * The operator sign-in shortcut is offered while the shared host can sign in, and stays while that sign-in is pending (a second
 * press joins the same attempt), so a keyboard user keeps focus on it. StocksSignIn above states why sign-in is impossible.
 */
export function StocksAdminPage() {
  const environment = useContext(StocksPageEnvironment); const host = useGiwaStocksHost(); const apiBase = usePageApiBase()
  // Trading control (003F) uses the same signed session, API base and transport as the read-only console below it.
  const onSignInRequired = host.canSignIn || host.snapshot.status === "signing-in" ? () => { void host.signIn() } : undefined
  return <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksSignIn />{apiBase ? <><GiwaStocksTradingControlFeature apiBase={apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={onSignInRequired} /><GiwaStocksAdminFeature apiBase={apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={onSignInRequired} /></> : <><h1 className="sr-only">Stocks operations</h1><p role="status">Stocks 관리자 API 연결 준비 중</p></>}</div>
}
