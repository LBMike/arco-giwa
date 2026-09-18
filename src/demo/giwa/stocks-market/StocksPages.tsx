import { createContext, useCallback, useContext, useMemo } from "react"
import { Link } from "react-router-dom"
import { resolveApiBase } from "../api-base"
import { ARCO_API_BASE } from "../config"
import { GIWA_ADMIN_STOCKS_ROUTE, GIWA_STOCKS_ROUTE } from "../routes"
import { GiwaStocksAdminFeature } from "../stocks-admin"
import { StocksExecutionProvider, StocksExecutionSessionNotice, useStocksExecutionCapability, useStocksOrderExecutionSlot, type ExecutionClockSeam } from "../stocks-execution-host"
import { StocksSignIn, useGiwaStocksHost } from "../stocks-host"
import type { KnownHashStore } from "../stocks-known-hash-recovery"
import { GiwaStocksFeature, createGiwaStocksHttpClient, type GiwaStocksFeatureProps } from "../stocks-investor"
import type { ActiveWalletSource } from "../stocks-wallet-source"
import { createMarketClient } from "./client"
import type { MarketFetch } from "./contracts"
import { StocksMarketFeature } from "./StocksMarketFeature"
/** Explicit offline verification seam; normal runtime uses ARCO_API_BASE, browser fetch, real clocks and the wallet module's active source. */
export const StocksPageEnvironment = createContext<{ apiBase: string | null; fetch?: MarketFetch; executionClock?: ExecutionClockSeam; activeWalletSource?: () => ActiveWalletSource | null; knownHashes?: KnownHashStore }>({ apiBase: ARCO_API_BASE })
const link = "rounded-lg border border-[var(--color-arco-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
function StocksNavigation() { return <nav aria-label="Stocks navigation" className="flex flex-wrap gap-2"><Link className={link} to={GIWA_STOCKS_ROUTE}>Stocks 시장정보·모의 거래</Link><Link className={link} to={GIWA_ADMIN_STOCKS_ROUTE}>Stocks 관리자 조회</Link></nav> }
/** One validated API base for market, investor, admin and wallet execution, so a malformed setting fails the same way on every Stocks surface. */
function usePageApiBase(): string | null {
  const { apiBase } = useContext(StocksPageEnvironment)
  return useMemo(() => (apiBase === null ? null : resolveApiBase(apiBase, window.location.origin)), [apiBase])
}
const CAPABILITY_COPY: Readonly<Record<string, string>> = {
  READY: "입금·매도 예치는 수락된 주문 카드에서 진행합니다: 주문 확인 → 정확한 금액 승인 → 별도 버튼으로 입금·예치. 각 단계는 버튼을 누를 때만 지갑을 엽니다.",
  WALLET_SOURCE_UNSUPPORTED: "현재 연결된 지갑 방식은 거래 요청을 한 번만 보내도록 보장할 수 없어 입금·매도 예치를 지원하지 않습니다. 주문 상태 조회만 가능합니다.",
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
  return <StocksExecutionProvider apiBase={apiBase} fetch={environment.fetch as typeof globalThis.fetch | undefined} clock={environment.executionClock} activeSource={environment.activeWalletSource} knownHashes={environment.knownHashes}>
    <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksMarketFeature client={clients.market} /><StocksSignIn /><StocksExecutionSessionNotice />
      <section aria-label="NVDA testnet mock trading" className="w-full min-w-0 rounded-2xl border border-[var(--color-arco-border)] bg-[var(--color-arco-surface)]">
        <div className="border-b border-[var(--color-arco-border)] p-4 sm:p-6"><h2 className="text-lg font-medium">NVDA · 테스트넷 모의 거래</h2><p className="mt-2 text-sm text-[var(--color-arco-text-soft)]">테스트넷 모의 체결가: 서버 발급 견적 기준. 현재 고정 모의 가격 120이며 위 USD 시장시세와 별개입니다. 시장정보 종목 선택은 이 NVDA 주문에 적용되지 않습니다.</p><ExecutionCapabilityNote /></div>
        <InvestorWithExecution client={clients.investor} session={host.investor} hostWallet={session ? { address: session.walletAddress, chainId: session.chainId } : null} onSessionRejected={rejected} />
      </section>
    </div>
  </StocksExecutionProvider>
}
export function StocksAdminPage() {
  const environment = useContext(StocksPageEnvironment); const host = useGiwaStocksHost(); const apiBase = usePageApiBase()
  return <div className="w-full min-w-0 space-y-6"><StocksNavigation /><StocksSignIn />{apiBase ? <GiwaStocksAdminFeature apiBase={apiBase} session={host.admin} fetch={environment.fetch} onSignInRequired={() => { void host.signIn() }} /> : <p role="status">Stocks 관리자 API 연결 준비 중</p>}</div>
}
