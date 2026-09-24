/** LOCAL TEST HARNESS ONLY. Actual React route -> native HTTP -> isolated PostgreSQL/local EVM.
 * This module changes neither clocks nor server order state. Every order/claim/wallet send starts
 * at a real UI button. Read-only snapshots supplement (never replace) rendered assertions.
 * Imported only by the explicitly gated local runner, never by production application code.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

type Row = Record<string, any>;
export type LocalUiStack = {
  apiBase: string; frontendOrigin: string; accounts: { holder: string; [name: string]: string };
  startProcessing(): Promise<unknown>; stopProcessing(): Promise<unknown>; restartApi(): Promise<unknown>;
  snapshot(): Promise<Row>; requests: Row[]; registerUiCleanup?(cleanup: () => Promise<void>): void;
};
export type LocalUiWallet = {
  provider: { request(input: { method: string; params?: unknown[] }): Promise<any> };
  readonly account: string | null; calls: Row[]; sends: Row[];
  setAccount(address: string | null): void;
  holdNextSend(): { arrived: Promise<Row>; release(): void; drop(): void };
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function runLocalUiScenario(stack: LocalUiStack, wallet: LocalUiWallet) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  const runtime = process.env.STOCKS_LOCAL_UI_DOM_RUNTIME;
  assert.ok(runtime && isAbsolute(runtime), 'STOCKS_LOCAL_UI_DOM_RUNTIME must name an existing absolute jsdom package.json');
  const api = new URL(stack.apiBase);
  assert.equal(api.protocol, 'http:'); assert.equal(api.hostname, '127.0.0.1'); assert.equal(api.pathname, '/');
  assert.equal(stack.frontendOrigin, 'http://stocks-local.test');
  assert.equal(wallet.account?.toLowerCase(), stack.accounts.holder.toLowerCase());
  const { JSDOM } = createRequire(runtime)('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: stack.frontendOrigin, pretendToBeVisual: true });
  const w = dom.window;
  const globals: Row = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement,
    SVGElement: w.SVGElement, Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent,
    MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent, InputEvent: w.InputEvent, MutationObserver: w.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const report: Row = { execution: 'LOCAL_UI_PG_EVM_ONLY', actualRoutes: true, strictMode: true, scenarios: [], http: [], walletSends: [] };
  let page: any;
  let uiClosed = false;
  let closing: Promise<void> | undefined;
  const pageCleanups: Array<() => Promise<void>> = [];
  function closeUi(): Promise<void> {
    if (closing) return closing;
    uiClosed = true;
    closing = (async () => {
      try { for (const cleanup of [...pageCleanups].reverse()) await cleanup(); }
      finally {
        dom.window.close();
        for (const [key, descriptor] of Object.entries(previous)) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
        }
      }
    })();
    return closing;
  }
  stack.registerUiCleanup?.(closeUi);
  const originalFetch = globalThis.fetch;
  // Do not log authorization headers or SIWE signatures. No response is substituted or altered.
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, api.origin, 'UI may only access its owned local API');
    const response = await originalFetch(input, init);
    const entry: Row = { method: init?.method ?? 'GET', path: url.pathname, status: response.status };
    if (/\/stocks\/(orders|sell-orders)$/.test(url.pathname) && entry.method === 'POST') {
      const result = await response.clone().json(); entry.order = result.data;
    }
    if (/\/stocks\/wallet-submissions\/(BUY|SELL)\//.test(url.pathname)) entry.journal = (await response.clone().json()).data;
    report.http.push(entry); return response;
  };
  function passed(name: string, data: Row = {}) {
    const result = { name, ...data }; report.scenarios.push(result);
    process.stdout.write(`STOCKS_LOCAL_UI_STEP ${JSON.stringify(result)}\n`);
  }
  try {
    // DOM globals must exist before these imports (React's event capability detection is import-time).
    const { act, createElement: h, StrictMode, useLayoutEffect } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { createMemoryRouter, RouterProvider, Outlet } = await import('react-router-dom');
    const { stocksRoutes } = await import('../../src/demo/giwa/stocks-market/routes');
    const { StocksPageEnvironment } = await import('../../src/demo/giwa/stocks-market/StocksPages');
    const { StocksHostProvider } = await import('../../src/demo/giwa/stocks-host/StocksHostProvider');
    const inputValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!;
    let mountNumber = 0;
    async function mount(options: { sessionSeconds?: number } = {}) {
      assert.ok(!uiClosed, 'Local UI is closing');
      const element = document.createElement('div'); document.body.append(element);
      const root = createRoot(element);
      const router = createMemoryRouter(stocksRoutes(h(Outlet)), { initialEntries: ['/stocks'] });
      let mounted = true;
      const unmount = async () => {
        if (!mounted) return; mounted = false;
        await act(async () => root.unmount()); router.dispose(); element.remove();
      };
      pageCleanups.push(unmount);
      const source = { mode: 'injected' as const, provider: wallet.provider };
      const environment = { apiBase: stack.apiBase, fetch: observedFetch, activeWalletSource: () => source };
      const sessionFetch: typeof fetch = options.sessionSeconds === undefined ? observedFetch : async (input, init) => {
        const response = await observedFetch(input, init);
        if (String(input).endsWith('/api/v1/auth/verify') && response.ok) {
          const body = await response.json();
          // Test-only browser lease restriction: real server JWT remains unchanged (900 seconds).
          return new Response(JSON.stringify({ ...body, expiresIn: options.sessionSeconds }), { status: response.status, headers: { 'content-type': 'application/json' } });
        }
        return response;
      };
      const dependencies = { fetch: sessionFetch, signMessage: ({ message, account }: { message: string; account: string }) => wallet.provider.request({ method: 'personal_sign', params: [message, account] }) };
      let view = { address: wallet.account, epoch: `local-ui:${++mountNumber}` };
      const commits: Row[] = [];
      function CommitProbe({ children }: { children: any }) {
        useLayoutEffect(() => { commits.push({ address: view.address, epoch: view.epoch, text: element.textContent ?? '' }); });
        return children;
      }
      const tree = () => h(StrictMode, null, h(CommitProbe, { children:
        h(StocksHostProvider, { context: { walletAddress: view.address, chainId: 91342, frontendOrigin: stack.frontendOrigin, apiBase: stack.apiBase, walletEpoch: view.epoch }, dependencies, walletSource: source,
          children: h(StocksPageEnvironment.Provider, { value: environment }, h(RouterProvider, { router })) }) }));
      await act(async () => { root.render(tree()); await sleep(0); });
      assert.ok(!uiClosed, 'Local UI stopped during mount');
      const current = {
        element, commits,
        async accountChanged(address: string) {
          await act(async () => {
            wallet.setAccount(address); view = { address, epoch: `local-ui:${++mountNumber}` };
            root.render(tree()); await sleep(0);
          });
          return commits.find(row => row.epoch === view.epoch);
        },
        text: () => element.textContent ?? '',
        panel: () => element.querySelector<HTMLElement>('[data-testid="stocks-wallet-panel"]'),
        status: () => current.panel()?.dataset.status,
        action: (name: string) => current.panel()?.querySelector<HTMLButtonElement>(`button[data-action="${name}"]`) ?? null,
        hash: () => element.querySelector('[data-testid="stocks-wallet-tx-hash"]')?.textContent ?? null,
        button: (label: string | RegExp, scope: ParentNode = element) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(b => typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')) ?? null,
        async wait<T>(read: () => T, label: string, timeout = 15000): Promise<NonNullable<T>> {
          const deadline = performance.now() + timeout;
          for (;;) {
            const value = read(); if (value) return value as NonNullable<T>;
            if (performance.now() >= deadline) throw Error(`UI timeout: ${label}; status=${current.status()}; text=${current.text().slice(-7000)}`);
            await act(async () => sleep(25));
          }
        },
        async click(target: HTMLElement | null, label: string, double = false) {
          assert.ok(target, `Missing UI control: ${label}`);
          assert.ok(!(target instanceof w.HTMLButtonElement) || !(target as HTMLButtonElement).disabled, `Disabled UI control: ${label}`);
          await act(async () => { target.click(); if (double) target.click(); await sleep(0); });
        },
        async settle(ms: number) { await act(async () => sleep(ms)); },
        async signIn() {
          await current.wait(() => current.button('Sign in to Stocks') && !current.button('Sign in to Stocks')!.disabled, 'sign-in available');
          await current.click(current.button('Sign in to Stocks'), 'Sign in');
          await current.wait(() => current.text().includes('Signed in to Stocks.'), 'real SIWE login');
          await current.wait(() => element.querySelector('[data-testid="giwa-stocks-session"]')?.textContent?.startsWith('Signed in as'), 'investor same session');
        },
        async tab(name: 'stocks' | 'orders' | 'portfolio') {
          await current.click(element.querySelector(`#giwa-stocks-tab-${name}`), `${name} tab`);
        },
        async place(side: 'BUY' | 'SELL', quantity: string) {
          await current.tab('stocks');
          if (!element.querySelector('input[inputmode="decimal"]')) {
            await current.wait(() => element.querySelector('button[aria-label="View NVDA"]') || current.button('Start a new order'), 'NVDA catalog or prior accepted order');
            const view = element.querySelector<HTMLElement>('button[aria-label="View NVDA"]');
            if (view) await current.click(view, 'View NVDA');
          }
          if (current.button('Start a new order')) await current.click(current.button('Start a new order'), 'Start a new order');
          const input = await current.wait(() => element.querySelector<HTMLInputElement>('input[inputmode="decimal"]'), 'quantity');
          await current.click(element.querySelector(`[data-side="${side}"]`), side);
          await act(async () => { inputValue.call(input, quantity); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
          await current.wait(() => current.button('Get quote') && !current.button('Get quote')!.disabled, 'Get quote');
          await current.click(current.button('Get quote'), 'Get quote');
          const label = side === 'BUY' ? 'Place buy order' : 'Place sell order';
          await current.wait(() => current.button(label) && !current.button(label)!.disabled, label);
          const before = report.http.length;
          await current.click(current.button(label), label, true);
          await current.wait(() => element.querySelector('[data-testid="stocks-attempt-accepted"] [data-testid="stocks-order-card"]'), 'accepted order');
          const entries = report.http.slice(before).filter((r: Row) => r.method === 'POST' && r.path === `/api/v1/stocks/${side === 'BUY' ? 'orders' : 'sell-orders'}`);
          assert.equal(entries.length, 1, 'double activation creates one order');
          assert.ok(entries[0].order?.id); return entries[0].order;
        },
        async select(side: 'BUY' | 'SELL', quantity: string) {
          await current.tab('orders');
          const row = await current.wait(() => [...element.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith(side === 'BUY' ? 'Buy' : 'Sell') && b.textContent.includes(`${quantity} NVDA`)), 'order row');
          await current.click(row, 'select durable order');
          await current.wait(() => current.panel(), 'selected execution panel');
        },
        async check() {
          await current.wait(() => current.action('prepare') && !current.action('prepare')!.disabled, 'Check order enabled');
          await current.click(current.action('prepare'), 'Check order');
        },
        async armed(name: string) {
          const first = performance.now();
          await current.wait(() => current.action(name) && !current.action(name)!.disabled, `${name} armed`, 5000);
          return Math.round(performance.now() - first);
        },
        async refreshStatus() {
          const card = element.querySelector('[data-testid="stocks-order-card"]');
          const refresh = current.button('Refresh status', card ?? element) ?? current.button('Refresh order status');
          if (refresh && !refresh.disabled) await current.click(refresh, 'Refresh order status');
        },
        unmount,
      };
      return current;
    }
    async function approve(side: string) {
      const before = wallet.sends.length;
      await page.check(); await page.wait(() => page.status() === 'APPROVAL_REQUIRED', 'exact approval required');
      assert.equal(page.action('approve')?.disabled, true, 'initial approval paint remains unarmed');
      const armedMs = await page.armed('approve'); assert.ok(armedMs >= 650, 'real 800ms arming delay, allowing observation lag');
      await page.click(page.action('approve'), 'Approve exact amount', true);
      await page.wait(() => ['APPROVAL_SUBMITTED', 'READY_TRANSFER'].includes(page.status()), 'approval answer', 15000);
      // Real chain finality can initially be pending. Each retry is a separate explicit Check click,
      // never a wallet retry or a server-state mutation, and real timers remain unmodified.
      const until = performance.now() + 35000;
      while (page.status() !== 'READY_TRANSFER') {
        assert.equal(page.status(), 'APPROVAL_SUBMITTED', page.text());
        assert.ok(performance.now() < until, 'approval did not finalize within the local receipt window');
        await page.settle(1200); await page.check();
        await page.wait(() => ['APPROVAL_SUBMITTED', 'READY_TRANSFER'].includes(page.status()), 'trusted approval check');
      }
      assert.equal(wallet.sends.length, before + 1, 'double-click approval issues exactly one wallet request');
      await page.settle(100); assert.equal(wallet.sends.length, before + 1, 'approval never automatically transfers');
      passed(`${side}: approval finalized; separate transfer required`, { armedMs, walletSends: wallet.sends.length });
    }
    async function transfer(side: string) {
      const before = wallet.sends.length;
      await page.armed('submit'); await page.click(page.action('submit'), 'Deposit / escrow', true);
      await page.wait(() => page.status() === 'SUBMITTED' && page.hash(), 'transfer recorded', 15000);
      assert.equal(wallet.sends.length, before + 1, 'double-click transfer issues one wallet request');
      const hash = page.hash(); assert.match(hash, /^0x[0-9a-f]{64}$/i);
      passed(`${side}: submitted by separate UI click`, { hash, walletSends: wallet.sends.length }); return hash;
    }
    async function complete(side: 'BUY' | 'SELL', orderId: string) {
      const deadline = performance.now() + 55000;
      let snapshot: Row = {};
      for (;;) {
        await act(async () => { snapshot = await stack.snapshot(); });
        const row = snapshot[side === 'BUY' ? 'buyOrders' : 'sellOrders'].find((r: Row) => r.id === orderId);
        if (row?.state === 'COMPLETED') break;
        assert.ok(performance.now() < deadline, `${side} did not complete: ${JSON.stringify({ state: row?.state, runtime: snapshot.runtimeStatus, workerErrors: snapshot.workerErrors })}`);
        await page.refreshStatus(); await page.settle(500);
      }
      await page.refreshStatus(); await page.wait(() => page.text().includes('Completed'), 'actual server COMPLETED rendered');
      passed(`${side}: native processing completed`, { orderId, holderStock: snapshot.chain.holderStock });
      return snapshot;
    }
    async function holdings(expected: string) {
      await page.tab('portfolio');
      const scope = await page.wait(() => page.element.querySelector('[aria-labelledby="giwa-stocks-portfolio-title"]'), 'portfolio');
      await page.wait(() => page.button('Refresh', scope) && !page.button('Refresh', scope).disabled, 'portfolio refresh');
      await page.click(page.button('Refresh', scope), 'Refresh portfolio');
      await page.wait(() => [...scope.querySelectorAll('[data-testid="stocks-holding"]')].some((row: any) => row.textContent.includes(`Total (wallet + escrow)${expected} NVDA`) && row.textContent.includes(`In wallet${expected} NVDA`)), `actual UI holdings ${expected}`);
      passed('UI portfolio matches finalized chain holdings', { quantity: expected, text: scope.textContent });
    }

    const initial = await stack.snapshot();
    assert.equal(String(initial.chain.holderStock), '0', 'fresh local holder starts without stock');
    page = await mount(); await page.signIn();
    assert.equal(wallet.sends.length, 0, 'mount/login never sends a transaction');
    const buy = await page.place('BUY', '2');
    assert.equal(buy.quantity, '2000000000'); await approve('BUY');
    // Pause only processing, not UI or clocks; retain transfer in its durable pending state for restart/read proof.
    await stack.stopProcessing();
    const buyHash = await transfer('BUY');
    const beforeRestartSends = wallet.sends.length;
    await page.unmount(); await stack.restartApi();
    page = await mount(); await page.signIn(); await page.select('BUY', '2'); await page.check();
    await page.wait(() => page.status() === 'SUBMITTED' && page.hash() === buyHash, 'restart restores original durable transfer hash');
    assert.equal(wallet.sends.length, beforeRestartSends, 'restart/remount/read never resends');
    passed('API restart + StrictMode remount restores durable same hash', { orderId: buy.id, hash: buyHash, walletSends: wallet.sends.length });
    await stack.startProcessing(); const buySnapshot = await complete('BUY', buy.id);
    assert.equal(String(buySnapshot.chain.holderStock), '2000000000'); await holdings('2');
    const sell = await page.place('SELL', '0.5'); assert.equal(sell.quantity, '500000000');
    await approve('SELL'); const sellHash = await transfer('SELL');
    const sellSnapshot = await complete('SELL', sell.id);
    assert.equal(String(sellSnapshot.chain.holderStock), '1500000000'); await holdings('1.5');
    assert.equal(wallet.sends.length, 4, 'two approvals and two separate transfers total');
    assert.equal(report.http.filter((r: Row) => r.method === 'POST' && /\/stocks\/(orders|sell-orders)$/.test(r.path)).length, 2);
    assert.equal(report.http.filter((r: Row) => r.method === 'POST' && r.path.endsWith('/wallet-submissions/claims')).length, 4);
    assert.ok(wallet.calls.every((r: Row) => !['eth_sendRawTransaction', 'wallet_sendTransaction'].includes(r.method)));
    report.happy = { buyOrderId: buy.id, sellOrderId: sell.id, buyHash, sellHash, snapshot: sellSnapshot };

    const submissions = (snapshot: Row, orderId: string, stage: string) => snapshot.claims.filter((row: Row) => row.orderId === orderId && row.stage === stage);
    async function dbWait(read: (snapshot: Row) => any, label: string, timeout = 10000): Promise<Row> {
      const until = performance.now() + timeout;
      for (;;) {
        let snapshot: Row = {}; await act(async () => { snapshot = await stack.snapshot(); });
        if (read(snapshot)) return snapshot;
        assert.ok(performance.now() < until, `Database condition timed out: ${label}`); await page.settle(50);
      }
    }
    async function heldApproval() {
      await page.check(); await page.wait(() => page.status() === 'APPROVAL_REQUIRED', 'approval before held response');
      await page.armed('approve'); const hold = wallet.holdNextSend();
      await page.click(page.action('approve'), 'Approval held at actual provider response');
      const arrived = await hold.arrived; assert.match(arrived.hash, /^0x[0-9a-f]{64}$/i);
      assert.equal(page.status(), 'SIGNING'); return { hold, arrived };
    }

    // 1. A real approval is already accepted by the local node when identity switches to B.
    const swapOrder = await page.place('BUY', '0.25');
    const swapped = await heldApproval(); const swapSends = wallet.sends.length;
    const firstB = await page.accountChanged(stack.accounts.otherHolder);
    assert.ok(firstB, 'parent layout effect captured B first commit');
    assert.ok(!firstB.text.includes(swapOrder.id)); assert.ok(!firstB.text.includes(swapOrder.orderKey));
    assert.ok(!firstB.text.includes(swapped.arrived.hash)); assert.equal(page.panel(), null);
    await act(async () => { swapped.hold.release(); await sleep(0); });
    const storedAfterSwap = await dbWait(snapshot => submissions(snapshot, swapOrder.id, 'APPROVAL')[0]?.txHash === swapped.arrived.hash, 'late A hash original claim');
    const swapClaim = submissions(storedAfterSwap, swapOrder.id, 'APPROVAL')[0];
    assert.equal(swapClaim.status, 'SUBMITTED'); assert.equal(swapClaim.wallet.toLowerCase(), stack.accounts.holder.toLowerCase());
    assert.ok(!page.text().includes(swapped.arrived.hash)); assert.equal(wallet.sends.length, swapSends);
    assert.equal(wallet.sends.filter(r => r.transaction.from.toLowerCase() === stack.accounts.otherHolder.toLowerCase()).length, 0);
    await page.unmount(); wallet.setAccount(stack.accounts.holder); page = await mount(); await page.signIn();
    await page.select('BUY', '0.25'); const inspectStart = report.http.length; await page.check();
    await page.wait(() => page.status() === 'READY_TRANSFER' || page.status() === 'APPROVAL_SUBMITTED', 'same-owner recorded approval restored');
    const inspect = report.http.slice(inspectStart).find((r: Row) => r.path.endsWith(`/wallet-submissions/BUY/${swapOrder.id}`));
    assert.ok(inspect?.journal?.approval); assert.equal(inspect.journal.approval.txHash, swapped.arrived.hash);
    assert.equal(inspect.journal.approval.claimId, swapClaim.claimId); assert.equal(wallet.sends.length, swapSends);
    passed('Account A→B first commit isolates A; original gate records late hash; A remount reads without resend', { orderId: swapOrder.id, claimId: swapClaim.claimId, hash: swapped.arrived.hash, firstB, walletSends: swapSends });

    // 2. Lost wallet response after actual escrow. Never feed the instrumentation hash back into UI.
    const lostSell = await page.place('SELL', '0.25'); await approve('SELL response-loss');
    await stack.stopProcessing(); await page.armed('submit'); const lost = wallet.holdNextSend();
    await page.click(page.action('submit'), 'Escrow with dropped wallet response');
    const lostAnswer = await lost.arrived; assert.match(lostAnswer.hash, /^0x[0-9a-f]{64}$/i);
    const lostSends = wallet.sends.length;
    await act(async () => { lost.drop(); await sleep(0); });
    await page.wait(() => page.status() === 'UNKNOWN', 'lost wallet answer is unknown'); assert.equal(page.hash(), null);
    const lostBefore = await dbWait(snapshot => submissions(snapshot, lostSell.id, 'TRANSFER')[0]?.status === 'UNKNOWN', 'UNKNOWN durable claim');
    const lostClaim = submissions(lostBefore, lostSell.id, 'TRANSFER')[0]; assert.equal(lostClaim.txHash, null);
    await stack.startProcessing(); const lossCompleted = await complete('SELL', lostSell.id);
    assert.equal(String(lossCompleted.chain.holderStock), '1250000000'); await holdings('1.25');
    await page.unmount(); await stack.restartApi(); page = await mount(); await page.signIn(); await page.tab('orders');
    const lostRow = await page.wait(() => [...page.element.querySelectorAll('button')].find((b: any) => b.textContent.startsWith('Sell') && b.textContent.includes('0.25 NVDA')), 'completed lost-response sell row');
    await page.click(lostRow, 'Completed sell after restart');
    await page.wait(() => page.text().includes('Completed') && page.text().includes(lostSell.id), 'server completed without UI hash recovery');
    assert.equal(page.hash(), null); assert.equal(wallet.sends.length, lostSends);
    const lostAfter = await stack.snapshot(); const sameLost = submissions(lostAfter, lostSell.id, 'TRANSFER');
    assert.equal(sameLost.length, 1); assert.equal(sameLost[0].claimId, lostClaim.claimId); assert.equal(sameLost[0].intentKey, lostClaim.intentKey);
    assert.equal(sameLost[0].transactionDigest, lostClaim.transactionDigest); assert.equal(sameLost[0].txHash, null);
    passed('Lost escrow response: UNKNOWN/no UI hash → native observer COMPLETED → restart without resend', { orderId: lostSell.id, claimId: lostClaim.claimId, instrumentationOnlyHash: lostAnswer.hash, walletSends: lostSends, quantity: '1.25' });

    // 3. Real elapsed-time session and quote expiry. Only the browser auth lease is shortened;
    // native JWT, quote 60-second deadline, deployment 15-second lease and clocks are untouched.
    await page.unmount(); page = await mount({ sessionSeconds: 30 }); await page.signIn();
    // The earlier unfunded 0.25 BUY left a real 30-USDC allowance. This new order
    // requires 60 USDC so it genuinely needs another approval; do not reset chain allowance.
    const expiring = await page.place('BUY', '0.5'); const expiry = await heldApproval();
    const heldAt = performance.now(); const expirySends = wallet.sends.length;
    const outcomesBeforeExpiry = report.http.filter((r: Row) => r.path.endsWith('/wallet-submissions/outcomes')).length;
    async function realWaitUntil(until: number, label: string) {
      while (performance.now() < until) {
        await page.settle(Math.min(5000, Math.max(1, until - performance.now())));
        process.stdout.write(`STOCKS_LOCAL_UI_WAIT ${JSON.stringify({ label, elapsedMs: Math.round(performance.now() - heldAt), remainingMs: Math.max(0, Math.round(until - performance.now())) })}\n`);
      }
    }
    await realWaitUntil(heldAt + 16000, 'actual deployment evidence lease expired');
    assert.equal(page.status(), 'SIGNING', 'dispatched prompt survives real evidence expiry');
    passed('Held actual approval stays SIGNING after real 16-second evidence expiry', { elapsedMs: Math.round(performance.now() - heldAt), walletSends: wallet.sends.length });
    await realWaitUntil(heldAt + 31000, 'actual browser session lease expired');
    await page.wait(() => page.text().includes('A wallet request from your last Stocks session'), 'expiry notice');
    assert.equal(page.panel(), null);
    await act(async () => { expiry.hold.release(); await sleep(100); });
    assert.equal(report.http.filter((r: Row) => r.path.endsWith('/wallet-submissions/outcomes')).length, outcomesBeforeExpiry);
    const expiryBefore = await stack.snapshot(); const expiryClaim = submissions(expiryBefore, expiring.id, 'APPROVAL')[0];
    assert.equal(expiryClaim.status, 'REQUEST_MAY_START'); assert.equal(expiryClaim.txHash, null);
    const notice = page.text(); assert.match(notice, /Do not send the approval, deposit or escrow again from this or any other app or wallet/);
    passed('Real 31-second browser expiry refuses late outcome before HTTP', { orderId: expiring.id, browserExpiresIn: 30, unchangedJwtSeconds: 900, elapsedMs: Math.round(performance.now() - heldAt), walletSends: expirySends });
    const remainingQuoteMs = Math.max(0, Date.parse(expiring.quoteExpiresAt) + 100 - Date.now());
    await realWaitUntil(performance.now() + remainingQuoteMs, 'actual original quote deadline');
    assert.ok(Date.now() >= Date.parse(expiring.quoteExpiresAt) + 100);
    await page.unmount(); page = await mount(); await page.signIn(); await page.select('BUY', '0.5');
    assert.match(page.text(), /quote deadline for this order has passed/);
    assert.ok(!page.action('prepare') || page.action('prepare').disabled); assert.ok(!page.action('approve') || page.action('approve').disabled); assert.ok(!page.action('submit') || page.action('submit').disabled);
    assert.equal(page.hash(), null); assert.equal(wallet.sends.length, expirySends);
    const finalSnapshot = await stack.snapshot();
    const finalExpiry = submissions(finalSnapshot, expiring.id, 'APPROVAL'); assert.equal(finalExpiry.length, 1); assert.equal(finalExpiry[0].claimId, expiryClaim.claimId); assert.equal(finalExpiry[0].txHash, null);
    assert.equal(finalSnapshot.reconciliation.status, 'MATCHED_AT_CUTOFF');
    assert.ok(finalSnapshot.jobs.every((job: Row) => job.status === 'DONE'));
    assert.deepEqual(finalSnapshot.workerErrors.processing, []); assert.deepEqual(finalSnapshot.workerErrors.reviewJobs, []);
    assert.equal(String(finalSnapshot.chain.holderCash), '1850000000'); assert.equal(String(finalSnapshot.chain.vaultCash), '150000000');
    assert.equal(String(finalSnapshot.chain.holderStock), '1250000000'); assert.equal(String(finalSnapshot.chain.stockSupply), '1250000000'); assert.equal(String(finalSnapshot.chain.escrowStock), '0');
    passed('Original 60-second quote expired; full-session relogin cannot resend; DB/chain reconciliation matches', { orderId: expiring.id, quoteExpiresAt: expiring.quoteExpiresAt, checkedAt: new Date().toISOString(), walletSends: expirySends, finalQuantity: '1.25', reconciliation: finalSnapshot.reconciliation.status });
    report.walletSends = wallet.sends; report.final = { buyOrderId: buy.id, sellOrderId: sell.id, lostSellOrderId: lostSell.id, swapOrderId: swapOrder.id, expiredOrderId: expiring.id, buyHash, sellHash, snapshot: finalSnapshot };
    assert.equal(wallet.sends.length, 8); assert.equal(finalSnapshot.claims.length, 8);
    return report;
  } finally {
    await closeUi();
  }
}
