/** LOCAL TEST ENTRY ONLY. Not imported by src/main.tsx or any production build entry.
 * Real Stocks routes and wallet controllers talk to the isolated API across origins.
 * This same-origin provider bridge forwards each request once; it never stores auth,
 * retries a wallet request, supplies execution evidence or rewrites API responses.
 */
import { StrictMode, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { StocksHostProvider } from '../../../src/demo/giwa/stocks-host/StocksHostProvider';
import { StocksPageEnvironment } from '../../../src/demo/giwa/stocks-market/StocksPages';
import { stocksRoutes } from '../../../src/demo/giwa/stocks-market/routes';
import type { ActiveWalletSource } from '../../../src/demo/giwa/stocks-wallet-source';
import { createLocalSessionReport } from '../session-report.mjs';
import '../../../src/index.css';
import '../../../src/demo/theme.css';

type Config = { apiBase: string; frontendOrigin: string; accounts: { holder: string; otherHolder: string; operator?: string }; account: string | null; capability: string; knownHashRecovery: boolean; operatorDiagnostics: boolean; ownerWorkspace: boolean };
type State = { account: string | null; holdWaiting: boolean; holdArmed: boolean; calls: number; sends: { outcome: string }[]; holderCash: string };
type Control = { action: 'account'; account: 'A' | 'B' | 'operator' } | { action: 'holdNextSend' | 'releaseHeld' | 'dropHeld' | 'stopProcessing' | 'startProcessing' | 'restartApi' | 'armShortSession' | 'topUpTestCash' };
type Request = { method: string; params?: unknown[] };
type Listener = (...args: unknown[]) => void;
const address = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string | null, b: string | null) => a?.toLowerCase() === b?.toLowerCase();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('LOCAL_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}
function configOf(value: unknown): Config {
  const row = object(value), accounts = object(row.accounts);
  if (typeof row.apiBase !== 'string' || typeof row.frontendOrigin !== 'string' || row.frontendOrigin !== location.origin || typeof row.capability !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(row.capability)) throw Error('LOCAL_CONFIG_INVALID');
  const api = new URL(row.apiBase);
  if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || !api.port || api.origin !== row.apiBase || api.origin === location.origin) throw Error('LOCAL_API_INVALID');
  if (typeof accounts.holder !== 'string' || !address.test(accounts.holder) || typeof accounts.otherHolder !== 'string' || !address.test(accounts.otherHolder)) throw Error('LOCAL_ACCOUNTS_INVALID');
  const operator = row.operatorDiagnostics === true && typeof accounts.operator === 'string' && address.test(accounts.operator) ? accounts.operator : undefined;
  if (row.operatorDiagnostics === true && !operator) throw Error('LOCAL_OPERATOR_INVALID');
  if (row.account !== null && (typeof row.account !== 'string' || ![accounts.holder.toLowerCase(), accounts.otherHolder.toLowerCase(), operator?.toLowerCase()].includes(row.account.toLowerCase()))) throw Error('LOCAL_ACCOUNT_INVALID');
  return { apiBase: row.apiBase, frontendOrigin: row.frontendOrigin, capability: row.capability, accounts: { holder: accounts.holder, otherHolder: accounts.otherHolder, operator }, account: row.account as string | null, knownHashRecovery: row.knownHashRecovery === true, operatorDiagnostics: row.operatorDiagnostics === true, ownerWorkspace: row.ownerWorkspace === true };
}
function stateOf(value: unknown, config: Config): State {
  const row = object(value);
  const snapshot = object(row.snapshot);
  if (typeof snapshot.holderCash !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(snapshot.holderCash)) throw Error('LOCAL_STATE_INVALID');
  if (row.account !== null && (typeof row.account !== 'string' || ![config.accounts.holder.toLowerCase(), config.accounts.otherHolder.toLowerCase(), config.accounts.operator?.toLowerCase()].includes(row.account.toLowerCase()))) throw Error('LOCAL_STATE_INVALID');
  if (typeof row.holdWaiting !== 'boolean' || typeof row.holdArmed !== 'boolean' || !Number.isSafeInteger(row.calls) || Number(row.calls) < 0 || !Array.isArray(row.sends)) throw Error('LOCAL_STATE_INVALID');
  const sends = row.sends.map(value => {
    const send = object(value);
    if (typeof send.outcome !== 'string') throw Error('LOCAL_STATE_INVALID');
    return { outcome: send.outcome };
  });
  return { account: row.account as string | null, holdWaiting: row.holdWaiting, holdArmed: row.holdArmed, calls: Number(row.calls), sends, holderCash: snapshot.holderCash };
}
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw Error('LOCAL_REQUEST_FAILED');
  return response.json();
}
const rootElement = document.getElementById('root');
if (!rootElement) throw Error('LOCAL_ROOT_MISSING');

async function start() {
  const bootstrap = await fetch('/__local/config', { credentials: 'omit', cache: 'no-store', redirect: 'error' }).then(json);
  const config = configOf(bootstrap);
  const headers = Object.freeze({ 'content-type': 'application/json', 'X-Stocks-Local-Capability': config.capability });
  function readState() {
    return fetch('/__local/state', { headers: { 'X-Stocks-Local-Capability': config.capability }, credentials: 'omit', cache: 'no-store', redirect: 'error' }).then(json).then(value => stateOf(value, config));
  }
  const initial = await readState();
  const listeners = new Map<string, Set<Listener>>();
  const allowed = new Set(['eth_chainId', 'eth_accounts', 'eth_getBlockByNumber', 'eth_call', 'eth_sendTransaction', 'personal_sign']);
  const provider = Object.freeze({
    request({ method, params = [] }: Request): Promise<unknown> {
      if (!allowed.has(method) || !Array.isArray(params)) throw Object.assign(Error('LOCAL_WALLET_METHOD_DENIED'), { code: -32602 });
      // IMPORTANT: start exactly one native fetch synchronously, before returning a Promise.
      // In particular a delayed answer must not result in a new request or account rebind.
      const pending = fetch('/__local/wallet', { method: 'POST', headers, body: JSON.stringify({ method, params }), credentials: 'omit', cache: 'no-store', redirect: 'error' });
      return pending.then(json).then(value => {
        const row = object(value);
        if (row.error) {
          const error = object(row.error);
          throw Object.assign(Error('LOCAL_WALLET_REQUEST_FAILED'), { code: typeof error.code === 'number' ? error.code : -32603 });
        }
        if (!Object.prototype.hasOwnProperty.call(row, 'result')) throw Error('LOCAL_WALLET_RESPONSE_INVALID');
        return row.result;
      });
    },
    on(event: string, listener: Listener) {
      const group = listeners.get(event) ?? new Set<Listener>(); group.add(listener); listeners.set(event, group);
      return provider;
    },
    removeListener(event: string, listener: Listener) { listeners.get(event)?.delete(listener); return provider; },
  });
  // Stable provider, source, environment and dependencies across counter refreshes and account changes.
  const source: ActiveWalletSource = { mode: 'injected', provider };
  const environment = { apiBase: config.apiBase, fetch: window.fetch.bind(window), activeWalletSource: () => source };
  const dependencies = { fetch: environment.fetch, async signMessage({ message, account }: { message: string; account: string }) {
    const signature = await provider.request({ method: 'personal_sign', params: [message, account] });
    if (typeof signature !== 'string') throw Error('LOCAL_SIGNATURE_INVALID'); return signature;
  } };
  if (location.pathname !== '/stocks' && location.pathname !== '/admin/stocks') history.replaceState(null, '', '/stocks');
  const router = createBrowserRouter(stocksRoutes(<Outlet />));
  const buttonStyle: CSSProperties = { minHeight: 40, padding: '8px 12px', border: '1px solid var(--color-arco-border)', borderRadius: 8, color: 'var(--color-arco-ink)', background: 'var(--color-arco-surface)', cursor: 'pointer', fontSize: 13 };

  function App() {
    const [view, setView] = useState({ account: initial.account, epoch: 1 });
    const [state, setState] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [stopped, setStopped] = useState(false);
    const [message, setMessage] = useState('새로고침하면 Stocks 로그인은 해제됩니다. 자동 로그인·자동 전송은 없습니다.');
    function acceptState(next: State) {
      if (!same(next.account, view.account)) {
        // Retire the old captured source BEFORE rendering the new host account.
        for (const listener of [...(listeners.get('accountsChanged') ?? [])]) listener(next.account ? [next.account] : []);
        setView(previous => ({ account: next.account, epoch: previous.epoch + 1 }));
      }
      setState(next);
    }
    async function refresh() {
      if (busy) return; setBusy(true);
      try { acceptState(await readState()); setMessage('테스트 서버의 현재 상태를 읽었습니다.'); }
      catch { setMessage('LOCAL_STATE_READ_FAILED'); }
      finally { setBusy(false); }
    }
    async function control(body: Control) {
      if (busy) return; setBusy(true);
      try {
        await fetch('/__local/control', { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error' }).then(json);
        acceptState(await readState()); setMessage(body.action === 'topUpTestCash' ? 'Account A 테스트 현금 보충을 확인했습니다. 기존 거래 기록은 유지됩니다.' : `테스트 제어 완료: ${body.action}`);
      } catch { setMessage(body.action === 'topUpTestCash' ? 'LOCAL_CONTROL_FAILED · 보충 결과를 확인하지 못했습니다. 현재 테스트 잔액을 확인하세요. 자동 재전송은 하지 않습니다.' : 'LOCAL_CONTROL_FAILED'); }
      finally { setBusy(false); }
    }
    async function exportSummary() {
      if (busy || stopped || !config.ownerWorkspace) return;
      setBusy(true);
      try {
        const current = await fetch('/__local/state', { headers: { 'X-Stocks-Local-Capability': config.capability }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) }).then(json);
        const currentView = stateOf(current, config);
        const report = createLocalSessionReport(bootstrap, current);
        const link = document.createElement('a');
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
        try {
          link.href = url; link.download = `stocks-local-summary-${report.capturedAt.replace(/[:.]/g, '-')}.json`;
          document.body.appendChild(link); link.click();
        } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
        acceptState(currentView);
        setMessage('Account A 최신 주문 요약의 JSON 다운로드를 요청했습니다. 매수·매도 각각 최대 100건의 식별번호·상태와 잔액이며, 복원용 백업은 아닙니다.');
      } catch { setMessage('LOCAL_EXPORT_FAILED · 요약을 저장하지 못했습니다. 로컬 실행 상태를 확인한 뒤 다시 시도하세요.'); }
      finally { setBusy(false); }
    }
    async function finish() {
      if (busy || stopped) return;
      setBusy(true);
      try {
        await fetch('/__local/finish', { method: 'POST', headers, body: JSON.stringify({ ok: true }), credentials: 'omit', cache: 'no-store', redirect: 'error' }).then(json);
        setStopped(true);
        setMessage('로컬 실행을 종료했습니다. 다시 시작하려면 npm run stocks:dev 를 실행하세요.');
      } catch { setMessage('종료 응답을 확인하지 못했습니다. 실행 터미널의 상태를 확인하세요.'); }
      finally { setBusy(false); }
    }
    const buttons: { label: string; body: Control }[] = [
      { label: 'Account A', body: { action: 'account', account: 'A' } }, { label: 'Account B', body: { action: 'account', account: 'B' } },
      { label: 'Hold next response', body: { action: 'holdNextSend' } }, { label: 'Release held response', body: { action: 'releaseHeld' } },
      { label: 'Drop held response', body: { action: 'dropHeld' } }, { label: 'Pause processing', body: { action: 'stopProcessing' } },
      { label: 'Resume processing', body: { action: 'startProcessing' } }, { label: 'Restart API', body: { action: 'restartApi' } },
    ];
    if (config.operatorDiagnostics) buttons.push({ label: 'Operator (sign-in only)', body: { action: 'account', account: 'operator' } });
    if (config.knownHashRecovery) buttons.push({ label: 'Next login: 30s JWT (test only)', body: { action: 'armShortSession' } });
    if (config.ownerWorkspace) buttons.push({ label: 'Account A 현금 2,000까지 보충', body: { action: 'topUpTestCash' } });
    return <div className="arco-demo" style={{ width: '100%', maxWidth: 1280, minHeight: '100vh', margin: '0 auto', padding: '16px', boxSizing: 'border-box', overflowWrap: 'anywhere', background: 'var(--color-arco-page)', color: 'var(--color-arco-ink)' }}>
      <aside aria-label="Local test controls" data-testid="local-test-controls" style={{ width: '100%', padding: 16, marginBottom: 24, border: '1px solid var(--color-arco-border)', borderRadius: 16, background: 'var(--color-arco-surface-muted)' }}>
        <h1 style={{ fontSize: 16, fontWeight: 600 }}>LOCAL TEST ONLY · PostgreSQL + local EVM</h1>
        <p style={{ fontSize: 13, marginTop: 6 }}>로컬 테스트 자산 전용 · 아래 도구는 운영 화면의 기능이 아닙니다. 계정 변경과 응답 유실을 검증합니다.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {buttons.map(({ label, body }) => <button key={label} type="button" style={buttonStyle} disabled={busy || stopped} data-local-action={body.action === 'account' ? `account-${body.account}` : body.action} onClick={() => { void control(body); }}>{label}</button>)}
          <button type="button" style={buttonStyle} disabled={busy || stopped} data-local-action="refresh" onClick={() => { void refresh(); }}>Refresh test state</button>
          {config.ownerWorkspace && <button type="button" style={buttonStyle} disabled={busy || stopped} data-local-action="export-summary" onClick={() => { void exportSummary(); }}>테스트 거래 요약 저장</button>}
          {config.ownerWorkspace && <button type="button" style={buttonStyle} disabled={busy || stopped} data-local-action="finish" onClick={() => { void finish(); }}>로컬 실행 종료</button>}
        </div>
        {config.ownerWorkspace && <p style={{ marginTop: 10, fontSize: 13 }}>Account A 테스트 현금 (최근 조회): <span data-testid="local-test-cash">{(Number(state.holderCash) / 1_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</span> ARCO_TEST_USDC · Refresh test state로 갱신</p>}
        <p data-testid="local-test-state" style={{ marginTop: 10, fontSize: 13 }}>
          Account {same(state.account, config.accounts.holder) ? 'A' : same(state.account, config.accounts.otherHolder) ? 'B' : config.accounts.operator && same(state.account, config.accounts.operator) ? 'Operator' : 'disconnected'}
          {' · '}Wallet calls: <span data-testid="local-wallet-calls">{state.calls}</span>
          {' · '}Sends: <span data-testid="local-wallet-sends">{state.sends.length}</span>
          {' · '}Held: <span data-testid="local-wallet-held">{state.holdWaiting ? 'waiting' : state.holdArmed ? 'armed' : 'none'}</span>
        </p>
        <p role="status" data-testid="local-test-message" style={{ marginTop: 6, fontSize: 12 }}>{message}</p>
      </aside>
      {!stopped && <main>
        <StocksHostProvider context={{ walletAddress: view.account, chainId: 91342, frontendOrigin: config.frontendOrigin, apiBase: config.apiBase, walletEpoch: `browser-local:${view.epoch}` }} dependencies={dependencies} walletSource={source}>
          <StocksPageEnvironment.Provider value={environment}><RouterProvider router={router} /></StocksPageEnvironment.Provider>
        </StocksHostProvider>
      </main>}
    </div>;
  }
  createRoot(rootElement!).render(<StrictMode><App /></StrictMode>);
}
void start().catch(() => {
  rootElement.textContent = '로컬 테스트 화면을 열 수 없습니다. LOCAL_BROWSER_START_FAILED';
});
