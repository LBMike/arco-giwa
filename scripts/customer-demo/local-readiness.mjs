import { reconcileStocks } from '../../server/dist/stocks/reconciliation.js';
import { LOCAL_CUSTOMER_ADMIN, LOCAL_CUSTOMER_MANIFEST, LOCAL_CUSTOMER_TUSDC_MANIFEST } from '../../server/dist/stocks-runtime/local-customer.js';
import { setTimeout as delay } from 'node:timers/promises';

const retryDelays = [2000, 5000, 10000];
const failureHints = Object.freeze({
  LOCAL_OPERATOR_CONFIGURATION_INVALID: '로컬 운영자 설정을 확인하세요.',
  LOCAL_EXISTING_OPERATOR_PAUSE: '기존 운영자 중지가 유지되어 있습니다. 자동으로 해제하지 않습니다.',
  LOCAL_RUNTIME_CONFIGURATION_INVALID: '로컬 실행 설정이 검토한 배포와 일치하지 않습니다.',
  LOCAL_OBSERVER_NOT_READY: '거래 기록 검증 상태를 확인해야 합니다. 저장 기록은 유지됩니다.',
  LOCAL_OBSERVER_RETRY_EXHAUSTED: '거래 기록 조회가 반복해서 완료되지 않았습니다. 동기화 위치는 보존됩니다.',
  LOCAL_RECONCILIATION_MISMATCH: '기록과 체인 잔액이 일치하지 않아 거래를 시작하지 않았습니다.',
  LOCAL_RECONCILIATION_UNAVAILABLE: '잔액 대조에 필요한 체인 조회를 완료하지 못했습니다.',
  LOCAL_RECONCILIATION_INCOMPLETE: '잔액 대조를 위한 최신 동기화 범위를 확인하지 못했습니다.',
  LOCAL_RECONCILIATION_NOT_READY: '잔액 대조 결과 또는 동기화 최신성 검사를 통과하지 못했습니다.',
  LOCAL_TRADING_NOT_READY: '최종 거래 시작 조건을 확인하지 못했습니다.',
});

// Never include a raw exception, RPC response, database detail or configuration value.
export function localReadinessFailureHint(error) {
  const code = error instanceof Error && Object.hasOwn(failureHints, error.message) ? error.message : 'LOCAL_READINESS_UNAVAILABLE';
  return `[${code}] ${failureHints[code] ?? '거래 기록 동기화와 잔액 대조를 완료하지 못했습니다. 저장 기록은 유지됩니다.'}`;
}

export async function resumeInitialLocalTrading(runtime, { signal, report = () => {}, reconcile = reconcileStocks,
  reviewedManifestDigest = LOCAL_CUSTOMER_MANIFEST,
  sleep = (ms, abortSignal) => delay(ms, undefined, { signal: abortSignal }) } = {}) {
  if (reviewedManifestDigest !== LOCAL_CUSTOMER_MANIFEST
    && (!LOCAL_CUSTOMER_TUSDC_MANIFEST || reviewedManifestDigest !== LOCAL_CUSTOMER_TUSDC_MANIFEST)) throw Error('LOCAL_RUNTIME_CONFIGURATION_INVALID');
  const operator = runtime.operators[0];
  if (!runtime.control || runtime.operators.length !== 1 || operator.wallet !== LOCAL_CUSTOMER_ADMIN
    || !operator.permissions.includes('stocks:control')) throw Error('LOCAL_OPERATOR_CONFIGURATION_INVALID');
  const initial = await runtime.control.read();
  if (initial.paused && initial.version !== 0) throw Error('LOCAL_EXISTING_OPERATOR_PAUSE');
  const until = Date.now() + 60 * 60 * 1000;
  let lastReport = 0, retries = 0, batches = 0;
  for (;;) {
    if (signal?.aborted || Date.now() > until) throw Error('LOCAL_OBSERVER_NOT_READY');
    await runtime.tick();
    if (signal?.aborted || Date.now() > until) throw Error('LOCAL_OBSERVER_NOT_READY');
    const status = runtime.status();
    if (status.deploymentDigest !== reviewedManifestDigest || status.configuredPause || !status.autodispatch
      || status.runtimeState !== 'RUNNING') throw Error('LOCAL_RUNTIME_CONFIGURATION_INVALID');
    if (status.observerStatus === 'CURRENT') break;
    // These states never authorize trading. Retry observation with backoff, then
    // still require fresh CURRENT coverage and a complete matched reconciliation.
    if (['UNAVAILABLE_OR_REVIEW_REQUIRED', 'BUSY'].includes(status.observerStatus)) {
      if (retries >= retryDelays.length) throw Error('LOCAL_OBSERVER_RETRY_EXHAUSTED');
      const ms = retryDelays[retries++];
      report(`거래 기록 조회를 다시 확인합니다 (${retries}/${retryDelays.length}, ${ms / 1000}초 후). 동기화 위치는 유지됩니다.`);
      await sleep(ms, signal);
      continue;
    }
    if (status.observerStatus !== 'CATCHING_UP') throw Error('LOCAL_OBSERVER_NOT_READY');
    retries = 0;
    batches++;
    if (Date.now() - lastReport > 10000) { report(`이전 거래 기록을 동기화하고 있습니다. 이번 실행에서 ${batches}개 구간 확인.`); lastReport = Date.now(); }
  }
  report('거래 기록 동기화 완료. 체인 잔액과 기록을 대조합니다.');
  const matched = await reconcile(runtime.service, runtime.reconciliationCoverage);
  if (matched.status === 'MISMATCH') throw Error('LOCAL_RECONCILIATION_MISMATCH');
  if (matched.status === 'UNAVAILABLE') throw Error('LOCAL_RECONCILIATION_UNAVAILABLE');
  if (matched.status === 'INCOMPLETE') throw Error('LOCAL_RECONCILIATION_INCOMPLETE');
  if (signal?.aborted || matched.status !== 'MATCHED_AT_CUTOFF' || matched.differences?.length !== 0
    || matched.cutoff?.deploymentDigest !== reviewedManifestDigest
    || runtime.status().observerStatus !== 'CURRENT') throw Error('LOCAL_RECONCILIATION_NOT_READY');
  const current = await runtime.control.read();
  if (signal?.aborted || runtime.status().observerStatus !== 'CURRENT') throw Error('LOCAL_TRADING_NOT_READY');
  if (current.paused) {
    if (current.version !== 0) throw Error('LOCAL_EXISTING_OPERATOR_PAUSE');
    await runtime.control.change(operator, { paused:false, expectedVersion:0, idempotencyKey:'local-demo-012-first-resume',
      reason:'Initial local demo readiness and reconciliation verified' });
  }
  const paused = await runtime.control.isPaused();
  if (signal?.aborted || runtime.status().observerStatus !== 'CURRENT' || paused) throw Error('LOCAL_TRADING_NOT_READY');
  report('잔액 대조가 완료되어 로컬 테스트 거래를 시작할 수 있습니다.');
}
