// Real ReactDOM regression suite. Supply GIWA_ADMIN_DOM_RUNTIME as an absolute
// package.json path from an existing jsdom installation; no dependency install.
// node --import tsx --test src/demo/giwa/stocks-admin/scope-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const domRequire = process.env.GIWA_ADMIN_DOM_RUNTIME ? createRequire(process.env.GIWA_ADMIN_DOM_RUNTIME) : require;
const { JSDOM } = domRequire('jsdom');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://review.invalid' });
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act, useLayoutEffect, createElement: h, StrictMode } = React;
const { GiwaStocksAdminFeature } = await import('./GiwaStocksAdminFeature.tsx');
const { StocksAdminStore } = await import('./store.ts');
const { createFixtureTransport, fixtureRoute, fixtureResponse, FIXTURE_NOW, FIXTURE_IDS } = await import('./fixtures.ts');
const initial = { apiBase: 'https://api-a.invalid', session: { id: 'A', accessToken: 'fake-A' }, deploymentKey: 'deployment-A', initialSection: 'orders', now: () => FIXTURE_NOW };
const container = document.getElementById('root');
function Host({ props, observe }) {
  useLayoutEffect(() => { observe?.(container.textContent); }, [observe]);
  return h(GiwaStocksAdminFeature, props);
}
for (const change of ['logout', 'session-B', 'api-base', 'deployment']) {
  test(`scope transition ${change} hides old data on the first commit`, async () => {
    const root = createRoot(container);
    const transport = createFixtureTransport(fixtureRoute());
    const props = { ...initial, fetch: transport.fetch };
    let captured;
    try {
      await act(async () => root.render(h(Host, { props })));
      assert.ok(container.textContent.includes(FIXTURE_IDS.buyCompleted));
      const next = { ...props };
      if (change === 'logout') next.session = null;
      if (change === 'session-B') next.session = { id: 'B', accessToken: 'fake-B' };
      if (change === 'api-base') next.apiBase = 'https://api-b.invalid';
      if (change === 'deployment') next.deploymentKey = 'deployment-B';
      await act(async () => root.render(h(Host, { props: next, observe: text => { captured = text; } })));
      assert.equal(captured.includes(FIXTURE_IDS.buyCompleted), false);
      assert.equal(captured.includes('giwa-stocks-testnet-v2'), false, 'old environment must also disappear');
      if (change === 'logout') assert.ok(captured.includes('Operator session required'));
    } finally { await act(async () => root.unmount()); }
  });
}

for (const lateStatus of [200, 401, 403]) {
  test(`A–B–A gives A a fresh owner and ignores old ${lateStatus} responses`, async () => {
    const root = createRoot(container);
    const pending = [];
    const fetch = (url, init) => new Promise(resolve => pending.push({ url, init, resolve }));
    const props = { ...initial, fetch };
    const orders = fixtureRoute()('/api/v1/admin/stocks/orders');
    try {
      await act(async () => root.render(h(Host, { props })));
      assert.equal(pending.length, 1);
      await act(async () => root.render(h(Host, { props: { ...props, session: { id: 'B', accessToken: 'fake-B' } }, observe: () => {
        assert.equal(pending[0].init.signal.aborted, true, 'retire A before parent layout');
      } })));
      assert.equal(pending.length, 2);
      await act(async () => pending[1].resolve(fixtureResponse(orders)));
      assert.ok(container.textContent.includes(FIXTURE_IDS.buyCompleted));
      let captured;
      await act(async () => root.render(h(Host, { props, observe: text => { captured = text; } })));
      assert.equal(captured.includes(FIXTURE_IDS.buyCompleted), false, 'new A must not reuse B or first A');
      assert.equal(pending.length, 3);
      await act(async () => pending[0].resolve(fixtureResponse(lateStatus === 200 ? orders : { status: lateStatus, body: { error: 'OLD_SESSION' } })));
      assert.equal(container.textContent.includes(FIXTURE_IDS.buyCompleted), false);
      assert.equal(container.textContent.includes('Session missing or expired'), false);
      assert.equal(container.textContent.includes('No Stocks read permission'), false);
      await act(async () => pending[2].resolve(fixtureResponse(orders)));
      assert.ok(container.textContent.includes(FIXTURE_IDS.buyCompleted));
    } finally { await act(async () => root.unmount()); }
  });
}

test('retired store callbacks cannot restart reads during the new scope first layout', async () => {
  const root = createRoot(container);
  const transport = createFixtureTransport(fixtureRoute());
  const activate = StocksAdminStore.prototype.activate;
  let owned;
  StocksAdminStore.prototype.activate = function () { owned = this; return activate.call(this); };
  try {
    await act(async () => root.render(h(Host, { props: { ...initial, fetch: transport.fetch } })));
    const old = owned;
    const count = transport.calls.length;
    await act(async () => root.render(h(Host, { props: { ...initial, session: null, fetch: transport.fetch }, observe: () => {
      old.load('orders'); old.selectOrder(FIXTURE_IDS.buyCompleted); old.refreshDetail(); old.retryAccess();
      assert.equal(transport.calls.length, count);
    } })));
  } finally {
    await act(async () => root.unmount());
    StocksAdminStore.prototype.activate = activate;
  }
});

test('same-id token refresh retains data and supplies the new token before parent layout actions', async () => {
  const root = createRoot(container);
  const transport = createFixtureTransport(fixtureRoute());
  const props = { ...initial, fetch: transport.fetch };
  try {
    await act(async () => root.render(h(Host, { props })));
    await act(async () => root.render(h(Host, { props: { ...props, session: { id: 'A', accessToken: 'refreshed-A' } }, observe: text => {
      assert.ok(text.includes(FIXTURE_IDS.buyCompleted));
      const refresh = [...container.querySelectorAll('button')].find(button => button.textContent.includes('Refresh'));
      assert.ok(refresh);
      refresh.click();
      assert.equal(transport.calls.at(-1).init.headers.authorization, 'Bearer refreshed-A');
    } })));
  } finally { await act(async () => root.unmount()); }
});

test('StrictMode replay and unmount retire requests while the surviving owner loads', async () => {
  const root = createRoot(container);
  const pending = [];
  const fetch = (url, init) => new Promise(resolve => pending.push({ url, init, resolve }));
  let unmounted = false;
  try {
    await act(async () => root.render(h(StrictMode, null, h(Host, { props: { ...initial, fetch } }))));
    assert.ok(pending.length >= 2, 'StrictMode must exercise cleanup/setup');
    const current = pending.at(-1);
    assert.equal(current.init.signal.aborted, false);
    for (const old of pending.slice(0, -1)) {
      assert.equal(old.init.signal.aborted, true);
      await act(async () => old.resolve(fixtureResponse({ status: 403, body: { error: 'OLD_SESSION' } })));
    }
    await act(async () => current.resolve(fixtureResponse(fixtureRoute()('/api/v1/admin/stocks/orders'))));
    assert.ok(container.textContent.includes(FIXTURE_IDS.buyCompleted));
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent.includes('Refresh')).click());
    const last = pending.at(-1);
    await act(async () => root.unmount()); unmounted = true;
    assert.equal(last.init.signal.aborted, true);
    await act(async () => last.resolve(fixtureResponse(fixtureRoute()('/api/v1/admin/stocks/orders'))));
    assert.equal(container.textContent, '');
  } finally { if (!unmounted) await act(async () => root.unmount()); }
});
test.after(() => dom.window.close());
