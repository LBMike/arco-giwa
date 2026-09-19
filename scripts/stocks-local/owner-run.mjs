import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createLocalBrowserHost } from './browser-server.mjs';
import { createLocalUiStack } from './ui-stack.mjs';
import { createLocalWallet } from './local-wallet.mjs';

// The actual product screens remain unchanged. This mode supplies only a local
// test wallet and owned backend, and never launches an automated trading driver.
export async function runStack(options) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  assert.equal(process.env.STOCKS_LOCAL_OWNER, '1');
  let host, stack, wallet, closed = false, closing;
  const check = () => assert.ok(!closed, 'LOCAL_OWNER_CLOSED_DURING_STARTUP');
  const setup = (async () => {
    host = await createLocalBrowserHost({ root: resolve(import.meta.dirname, '../..'), resourceDir: options.resourceDir }); check();
    stack = await createLocalUiStack({ ...options, frontendOrigin: host.origin,
      knownHashRecovery: true, operatorControls: true }); check();
    wallet = await createLocalWallet({ ...options, ...stack, operatorLogin: true }); check();
    host.attach({ stack, wallet });
  })();
  const close = () => closing ??= (async () => {
    closed = true;
    wallet?.close();
    const invoke = fn => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
    const early = Promise.allSettled([invoke(() => host?.close()), invoke(() => stack?.close())]);
    await setup.catch(() => {});
    wallet?.close();
    const late = Promise.allSettled([invoke(() => host?.close()), invoke(() => stack?.close())]);
    const failed = [...await early, ...await late].filter(row => row.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(row => row.reason), 'LOCAL_OWNER_CLOSE_FAILED');
    console.log(JSON.stringify({ kind: 'LOCAL_OWNER_RESOURCES_STOPPED', bridgeClosed: true, apiClosed: true }));
  })();
  options.registerCleanup?.(close);
  try {
    await setup; check();
    const investorUrl = `${host.origin}/stocks`, adminUrl = `${host.origin}/admin/stocks`;
    console.log(JSON.stringify({ kind: 'LOCAL_OWNER_READY', ownerPid: process.pid,
      origin: host.origin, apiBase: stack.apiBase, rpcUrl: options.rpcUrl, investorUrl, adminUrl,
      initialPaused: true, testCash: '2000', persistentAcrossRestart: false }));
    console.log(`\n투자자 화면: ${investorUrl}\n운영자 화면: ${adminUrl}\n` +
      '운영자 화면에서 Operator (sign-in only) → Sign in → 거래 재개 후 Account A로 매수·매도하세요.\n' +
      '테스트 현금 2,000 / NVDA 고정 모의 가격 120. 실제 자산이 아닙니다.\n' +
      '코드 수정 후 새로고침하세요. 서버 코드는 종료 후 다시 실행하세요. Ctrl+C로 소유 서비스를 정리합니다.\n');
    const result = await host.finished;
    assert.equal(result.ok, true, 'LOCAL_OWNER_SESSION_ENDED_WITHOUT_FINISH');
    return { result: 'LOCAL_SESSION_CLOSED', execution: 'LOCAL_OWNER_WORKSPACE_ONLY' };
  } finally { await close(); }
}
