// Fixed, explicitly opted-in local Chrome scenario. No product entry or live configuration.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, isAbsolute } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createLocalBrowserHost } from './browser-server.mjs';
import { createLocalUiStack } from './ui-stack.mjs';
import { createLocalWallet } from './local-wallet.mjs';
import { verifyUiEvidence } from './ui-evidence.mjs';
import { runBrowserScenario } from './browser-driver.mjs';

export async function runStack(options) {
  assert.equal(process.env.STOCKS_LOCAL_STACK_ONLY, '1');
  const runtime = process.env.STOCKS_LOCAL_BROWSER_RUNTIME;
  const executablePath = process.env.STOCKS_LOCAL_CHROME;
  const evidence = process.env.STOCKS_LOCAL_BROWSER_EVIDENCE;
  assert.ok(runtime && isAbsolute(runtime), 'Explicit installed Playwright package.json required');
  assert.ok(executablePath && isAbsolute(executablePath), 'Explicit installed Chrome executable required');
  assert.ok(evidence && isAbsolute(evidence), 'Explicit local evidence directory required');
  const probe = process.env.STOCKS_LOCAL_BROWSER_PROBE ?? '';
  assert.ok(['', 'ready', 'held', 'failure'].includes(probe));
  const scenario = process.env.STOCKS_LOCAL_BROWSER_CASE ?? '';
  assert.ok(['', 'known-hash', 'known-hash-ui', 'operator-diagnostics'].includes(scenario), 'Choose a fixed browser case');
  assert.ok(!scenario || !probe, 'Recovery and lifecycle probes are separate cases');
  const { chromium } = createRequire(runtime)('playwright');
  let host, stack, wallet, browserServer, browser, closePromise, closed = false;
  const check = () => assert.ok(!closed, 'LOCAL_BROWSER_CLOSED_DURING_STARTUP');
  const setup = (async () => {
    await mkdir(evidence, { recursive: true }); check();
    host = await createLocalBrowserHost({ root: resolve(import.meta.dirname, '../..'), resourceDir: options.resourceDir }); check();
    stack = await createLocalUiStack({ ...options, frontendOrigin: host.origin, knownHashRecovery: scenario === 'known-hash' || scenario === 'known-hash-ui', operatorDiagnostics: scenario === 'operator-diagnostics' }); check();
    wallet = await createLocalWallet({ ...options, ...stack, operatorLogin: scenario === 'operator-diagnostics' }); check();
    host.attach({ stack, wallet });
    browserServer = await chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1',
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--disable-background-networking', '--no-first-run', '--disable-default-apps'] }); check();
    browser = await chromium.connect(browserServer.wsEndpoint()); check();
    return { host, stack, wallet, browser };
  })();
  const close = () => closePromise ??= (async () => {
    closed = true; wallet?.close();
    const invoke = fn => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
    // Acquisition itself can be awaiting Chrome. Fence resources already acquired
    // now, and collect late acquisitions again after setup exits through check().
    const earlyStops = Promise.allSettled([invoke(() => host?.close()), invoke(() => stack?.close())]);
    await setup.catch(() => {});
    wallet?.close();
    // Fence HTTP dispatch and stop runtime iteration BEFORE waiting for Chrome.
    // These closers start synchronously; a slow browser cannot keep work alive.
    const stops = [() => host?.close(), () => stack?.close(), () => browser?.close(), () => browserServer?.close()]
      .map(invoke);
    const lateStops = Promise.allSettled(stops);
    const failures = [...await earlyStops, ...await lateStops]
      .filter(result => result.status === 'rejected').map(result => result.reason);
    const chrome = browserServer?.process();
    const chromeExited = !chrome || chrome.exitCode !== null || chrome.signalCode !== null;
    if (!chromeExited) failures.push(Error('LOCAL_CHROME_SHUTDOWN_UNCONFIRMED'));
    if (failures.length) throw new AggregateError(failures, 'LOCAL_BROWSER_CLOSE_FAILED');
    console.log(JSON.stringify({ kind: 'LOCAL_BROWSER_RESOURCES_STOPPED', chromePid: chrome?.pid,
      chromeExited, bridgeClosed: true, apiClosed: true }));
  })();
  options.registerCleanup?.(close);
  try {
    await setup; check();
    console.log(JSON.stringify({ kind: 'LOCAL_BROWSER_READY', ownerPid: process.pid, apiBase: stack.apiBase,
      rpcUrl: options.rpcUrl, origin: host.origin, chromePid: browserServer.process().pid }));
    if (probe === 'failure') throw Error('LOCAL_BROWSER_EXPECTED_FAILURE');
    if (probe === 'ready') await new Promise(() => {});
    const report = await runBrowserScenario({ host, stack, wallet, browser, evidence, probe, scenario });
    report.dispatchEvidence = await verifyUiEvidence(stack, wallet);
    if (scenario === 'operator-diagnostics') {
      const { runOperatorDiagnosticsScenario } = await import('./operator-diagnostics-driver.mjs');
      report.operatorDiagnostics = await runOperatorDiagnosticsScenario({ host, stack, wallet, browser, evidence });
    }
    report.result = 'PASS';
    await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally { await close(); }
}
