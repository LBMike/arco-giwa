import { createContext, useCallback, useContext, useMemo } from "react"
import { Link } from "react-router-dom"
import { ARCO_API_BASE } from "../config"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"
import { GiwaStocksAdminFeature } from "../stocks-admin"
import { StocksSignIn, useGiwaStocksHost } from "../stocks-host"
import { GiwaStocksFeature, createGiwaStocksHttpClient } from "../stocks-investor"
import { createMarketClient } from "./client"
import type { MarketFetch } from "./contracts"
import { StocksMarketFeature } from "./StocksMarketFeature"
/** Explicit offline verification seam; normal runtime uses ARCO_API_BASE and browser fetch. */
export const StocksPageEnvironment = createContext<{ apiBase: string | null; fetch?: MarketFetch }>({ apiBase: ARCO_API_BASE })
const link = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
function StocksNavigation() { return <nav aria-label="Stocks navigation" className="flex flex-wrap gap-2"><Link className={link} to={GIWA_STOCKS_ROUTE}>Stocks 시장정보·모의 거래</Link><Link className={link} to={GIWA_ADMIN_STOCKS_ROUTE}>Stocks 관리자 조회</Link></nav> }
export function StocksPage() {
  const environment = useContext(StocksPageEnvironment)
  const host = useGiwaStocksHost()
  const clients = useMemo(() => {
    if (!environment.apiBase) return { market: null, investor: null }
    try { return { market: createMarketClient(environment.apiBase, environment.fetch), investor: createGiwaStocksHttpClient({ baseUrl: environment.apiBase, fetch: environment.fetch }) } }
    catch { return { market: null, investor: null } }
  }, [environment.apiBase, environment.fetch])
  const sessionId = host.snapshot.session?.id
  const invalidate = host.invalidate
  // The ID is captured in this render's callback. A late rejection cannot invalidate a newer session.
  const rejected = useCallback(() => { if (sessionId) invalidate(sessionId) }, [sessionId, invalidate])
  const session = host.snapshot.session
  return <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksMarketFeature client={clients.market} /><StocksSignIn />
    <section aria-label="NVDA testnet mock trading" className="w-full min-w-0 rounded-2xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">
      <div className="border-b border-[var(--color-arco-border)] p-4 sm:p-6"><h2 className="text-lg font-medium">NVDA · 테스트넷 모의 거래</h2><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">테스트넷 모의 체결가: 서버 발급 견적 기준. 현재 고정 모의 가격 120이며 위 USD 시장시세와 별개입니다. 시장정보 종목 선택은 이 NVDA 주문에 적용되지 않습니다.</p><p className="mt-2 text-xs text-[var(--color-arco-text-soft)]">입금·매도 예치 지갑 연결은 준비 중입니다. 주문 접수는 실제 입금·체결·지급 완료를 의미하지 않습니다.</p></div>
      <GiwaStocksFeature client={clients.investor} session={host.investor} hostWallet={session ? { address: session.walletAddress, chainId: session.chainId } : null} onSessionRejected={rejected} />
    </section>
  </div>
}
export function StocksAdminPage() {
  const environment = useContext(StocksPageEnvironment); const host = useGiwaStocksHost()
  return <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksSignIn />{environment.apiBase ? <GiwaStocksAdminFeature apiBase={environment.apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={() => { void host.signIn() }} /> : <p role="status">Stocks 관리자 API 연결 준비 중</p>}</div>
}
