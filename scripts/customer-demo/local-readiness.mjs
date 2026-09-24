import { reconcileStocks } from '../../server/dist/stocks/reconciliation.js';
import { LOCAL_CUSTOMER_ADMIN, LOCAL_CUSTOMER_MANIFEST } from '../../server/dist/stocks-runtime/local-customer.js';

export async function resumeInitialLocalTrading(runtime, { signal, report = () => {}, reconcile = reconcileStocks } = {}) {
  const operator = runtime.operators[0];
  if (!runtime.control || runtime.operators.length !== 1 || operator.wallet !== LOCAL_CUSTOMER_ADMIN
    || !operator.permissions.includes('stocks:control')) throw Error('LOCAL_OPERATOR_CONFIGURATION_INVALID');
  const initial = await runtime.control.read();
  if (initial.paused && initial.version !== 0) throw Error('LOCAL_EXISTING_OPERATOR_PAUSE');
  const until = Date.now() + 60 * 60 * 1000;
  let lastReport = 0;
  for (;;) {
    if (signal?.aborted || Date.now() > until) throw Error('LOCAL_OBSERVER_NOT_READY');
    await runtime.tick();
    const status = runtime.status();
    if (status.deploymentDigest !== LOCAL_CUSTOMER_MANIFEST || status.configuredPause || !status.autodispatch
      || status.runtimeState !== 'RUNNING') throw Error('LOCAL_RUNTIME_CONFIGURATION_INVALID');
    if (status.observerStatus === 'CURRENT') break;
    if (status.observerStatus !== 'CATCHING_UP') throw Error('LOCAL_OBSERVER_NOT_READY');
    if (Date.now() - lastReport > 10000) { report('이전 거래 기록을 동기화하고 있습니다.'); lastReport = Date.now(); }
  }
  const matched = await reconcile(runtime.service, runtime.reconciliationCoverage);
  if (signal?.aborted || matched.status !== 'MATCHED_AT_CUTOFF' || matched.differences?.length !== 0
    || matched.cutoff?.deploymentDigest !== LOCAL_CUSTOMER_MANIFEST
    || runtime.status().observerStatus !== 'CURRENT') throw Error('LOCAL_RECONCILIATION_NOT_READY');
  const current = await runtime.control.read();
  if (signal?.aborted || runtime.status().observerStatus !== 'CURRENT') throw Error('LOCAL_TRADING_NOT_READY');
  if (current.paused) {
    if (current.version !== 0) throw Error('LOCAL_EXISTING_OPERATOR_PAUSE');
    await runtime.control.change(operator, { paused:false, expectedVersion:0, idempotencyKey:'local-demo-012-first-resume',
      reason:'Initial local demo readiness and reconciliation verified' });
  }
  if (signal?.aborted || runtime.status().observerStatus !== 'CURRENT' || await runtime.control.isPaused()) throw Error('LOCAL_TRADING_NOT_READY');
  report('잔액 대조가 완료되어 로컬 테스트 거래를 시작할 수 있습니다.');
}
