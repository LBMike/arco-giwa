import { useCallback, useContext, useId, useMemo } from "react"
import { Link } from "react-router-dom"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"
import { GiwaStocksAdminFeature } from "../stocks-admin"
import { StocksExecutionProvider, StocksExecutionSessionNotice, useStocksExecutionCapability, useStocksOrderExecutionSlot } from "../stocks-execution-host"
import { StocksSignIn, useGiwaStocksHost } from "../stocks-host"
import { GiwaStocksFeature, createGiwaStocksHttpClient, type GiwaStocksFeatureProps } from "../stocks-investor"
import { createMarketClient } from "./client"
import { StocksPageEnvironment, usePageApiBase } from "./environment"
import { useStocksPageAccess } from "./page-access"
import { StocksMarketFeature, type StocksAsideView } from "./StocksMarketFeature"
/** Re-exported under the same name for the verification pages and DOM suites that import it from here. */
export { StocksPageEnvironment }
const link = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
function StocksNavigation() { return <nav aria-label="Stocks navigation" className="flex flex-wrap gap-2"><Link className={link} to={GIWA_STOCKS_ROUTE}>Stocks 시장정보·모의 거래</Link><Link className={link} to={GIWA_ADMIN_STOCKS_ROUTE}>Stocks 관리자 조회</Link></nav> }
const CAPABILITY_COPY: Readonly<Record<string, string>> = {
  READY: "입금·매도 예치는 수락된 주문 카드에서 진행합니다: 주문 확인 → 정확한 금액 승인 → 별도 버튼으로 입금·예치. 각 단계는 버튼을 누를 때만 지갑을 엽니다.",
  WALLET_SOURCE_UNSUPPORTED: "현재 연결된 지갑 방식은 거래 요청을 한 번만 보내도록 보장할 수 없어 이 앱에서 입금·매도 예치를 지원하지 않습니다. 주문은 만들 수 있지만 이 지갑으로는 입금·예치할 수 없고, 주문 상태만 확인할 수 있습니다.",
  WALLET_SOURCE_MISSING: "브라우저 지갑이 연결되지 않아 입금·매도 예치를 진행할 수 없습니다.",
  WALLET_NOT_CONNECTED: "브라우저 지갑이 연결되지 않아 입금·매도 예치를 진행할 수 없습니다.",
  WALLET_MISMATCH: "연결된 지갑이 로그인한 Stocks 계정과 달라 입금·매도 예치를 진행할 수 없습니다.",
  SESSION_REQUIRED: "입금·매도 예치는 주문한 지갑으로 Stocks에 로그인한 뒤 진행할 수 있습니다.",
  API_BASE_NOT_CONFIGURED: "Stocks API 연결 설정이 올바르지 않아 입금·매도 예치를 진행할 수 없습니다.",
}
function ExecutionCapabilityNote() {
  const capability = useStocksExecutionCapability()
  const code = capability === null ? "API_BASE_NOT_CONFIGURED" : capability.status === "READY" ? "READY" : capability.code
  const text = CAPABILITY_COPY[code] ?? "입금·매도 예치 지갑 연결 상태를 확인하는 중입니다."
  return <p className="mt-2 text-xs text-[var(--color-arco-text-soft)]" data-testid="stocks-execution-capability">{text} 주문 접수·지갑 요청·거래 해시는 실제 입금·체결·지급 완료를 의미하지 않으며, 주문 결과는 서버 주문 상태로만 표시됩니다.</p>
}
function InvestorWithExecution(props: GiwaStocksFeatureProps) {
  const renderOrderExecution = useStocksOrderExecutionSlot()
  return <GiwaStocksFeature {...props} renderOrderExecution={renderOrderExecution} />
}
/** A non-NVDA detail: market data only. No order panel is opened for it and nothing is requested on its behalf. */
function ViewOnlyCard({ symbol }: { symbol: string }) {
  const id = useId()
  return <section aria-labelledby={id} className="w-full min-w-0 rounded-3xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] p-4 sm:p-6">
    <h2 id={id} className="text-lg font-medium">조회 전용</h2>
    <p role="status" className="mt-2 text-sm text-[var(--color-arco-text-soft)]">{symbol}은 시장정보 조회만 지원합니다. 현재 모의 주문은 NVDA만 지원하며 이 종목을 NVDA 주문으로 전환하지 않습니다.</p>
  </section>
}
export function StocksPage() {
  const environment = useContext(StocksPageEnvironment)
  const apiBase = usePageApiBase()
  const host = useGiwaStocksHost()
  const clients = useMemo(() => {
    if (!apiBase) return { market: null, investor: null }
    try { return { market: createMarketClient(apiBase, environment.fetch), investor: createGiwaStocksHttpClient({ baseUrl: apiBase, fetch: environment.fetch }) } }
    catch { return { market: null, investor: null } }
  }, [apiBase, environment.fetch])
  const sessionId = host.snapshot.session?.id
  const invalidate = host.invalidate
  // The ID is captured in this render's callback. A late rejection cannot invalidate a newer session.
  const rejected = useCallback(() => { if (sessionId) invalidate(sessionId) }, [sessionId, invalidate])
  const session = host.snapshot.session
  // The steps before a Stocks request, for the order panel to offer (WALLET_CHANGED after a wallet switch; no address).
  const access = useStocksPageAccess()
  // Keyed siblings at one tree position: switching list ↔ detail reorders them without remounting the investor controller.
  const aside = ({ selection, unverified }: StocksAsideView) => {
    const symbol = selection.symbol
    // Detail mode: only the heading above the order panel (it starts near the top of the column); the full explanation follows it.
    const explain = <><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">테스트넷 모의 체결가: 서버 발급 견적 기준. 현재 고정 모의 가격 120이며 위 USD 시장시세와 별개입니다. 시장정보 종목 선택은 이 NVDA 주문에 적용되지 않습니다.</p><ExecutionCapabilityNote /></>
    const trade = <section key="trade" aria-label="NVDA testnet mock trading" className="w-full min-w-0 rounded-3xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] [&>:last-child]:rounded-b-3xl">
      <div className="border-b border-[var(--color-arco-border)] p-4 sm:p-6"><h2 className="text-lg font-medium">NVDA · 테스트넷 모의 거래</h2>{symbol === null ? explain : null}</div>
      <InvestorWithExecution client={clients.investor} session={host.investor} hostWallet={session ? { address: session.walletAddress, chainId: session.chainId } : null} onSessionRejected={rejected} access={access} detailOpen={symbol === "NVDA"} onDetailChange={open => { if (open) selection.openDetail("NVDA", "investor"); else selection.closeDetail() }} />
      {symbol !== null ? <div className="border-t border-[var(--color-arco-border)] p-4 sm:p-6">{explain}</div> : null}
    </section>
    const signInRegion = <div key="sign-in" className="min-w-0 empty:hidden"><StocksSignIn /></div>
    const notice = <div key="session-notice" className="min-w-0 empty:hidden"><StocksExecutionSessionNotice /></div>
    if (symbol === null) return [signInRegion, notice, trade]
    return [symbol !== "NVDA" && !unverified ? <ViewOnlyCard key="view-only" symbol={symbol} /> : null, trade, signInRegion, notice]
  }
  return <StocksExecutionProvider apiBase={apiBase} fetch={environment.fetch as typeof globalThis.fetch | undefined} clock={environment.executionClock} activeSource={environment.activeWalletSource} knownHashes={environment.knownHashes}>
    <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksMarketFeature client={clients.market} ordersClient={clients.investor} aside={aside} /></div>
  </StocksExecutionProvider>
}
/**
 * The operator sign-in shortcut is offered while the shared host can sign in, and stays while that sign-in is pending (a second
 * press joins the same attempt), so a keyboard user keeps focus on it. StocksSignIn above states why sign-in is impossible.
 */
export function StocksAdminPage() {
  const environment = useContext(StocksPageEnvironment); const host = useGiwaStocksHost(); const apiBase = usePageApiBase()
  return <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksSignIn />{apiBase ? <GiwaStocksAdminFeature apiBase={apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={host.canSignIn || host.snapshot.status === "signing-in" ? () => { void host.signIn() } : undefined} /> : <><h1 className="sr-only">Stocks operations</h1><p role="status">Stocks 관리자 API 연결 준비 중</p></>}</div>
}
