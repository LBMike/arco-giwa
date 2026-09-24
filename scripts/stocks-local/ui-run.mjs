import assert from 'node:assert/strict';
import { createLocalUiStack } from './ui-stack.mjs';
import { createLocalWallet } from './local-wallet.mjs';
import { verifyUiEvidence } from './ui-evidence.mjs';

export async function runStack(options) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  let wallet, closePromise, uiCleanup, closed = false;
  // Register the acquisition promise before awaiting it, including partial startup.
  const setup = createLocalUiStack(options);
  const close = () => closePromise ??= (async () => {
    closed = true; wallet?.close();
    const stack = await setup.catch(() => null);
    try { await uiCleanup?.(); } finally { await stack?.close(); }
  })();
  options.registerCleanup?.(close);
  try {
    const stack = await setup;
    assert.ok(!closed, 'LOCAL_UI_CLOSED_DURING_STARTUP');
    wallet = await createLocalWallet({ ...options, ...stack });
    assert.ok(!closed, 'LOCAL_UI_CLOSED_DURING_STARTUP');
    stack.registerUiCleanup = fn => { assert.ok(!closed); uiCleanup = fn; };
    process.stdout.write(`${JSON.stringify({ kind: 'LOCAL_UI_READY', ownerPid: process.pid, apiBase: stack.apiBase, rpcUrl: options.rpcUrl })}\n`);
    if (process.env.STOCKS_LOCAL_UI_FAILURE_PROBE === '1') throw new Error('LOCAL_UI_EXPECTED_FAILURE_PROBE');
    // Loaded only by the fixed UI harness mode under node --import tsx.
    const { runLocalUiScenario } = await import('./ui-driver.tsx');
    assert.ok(!closed, 'LOCAL_UI_CLOSED_DURING_STARTUP');
    const report = await runLocalUiScenario(stack, wallet);
    report.dispatchEvidence = await verifyUiEvidence(stack, wallet);
    report.result = 'PASS';
    return report;
  } finally { await close(); }
}
