import type { FastifyInstance } from 'fastify';

export type ManagedStocksRuntime = { tick(): Promise<void>; stop?(): void; close(): Promise<void> };
export type StocksScheduler = (tick: () => void) => { cancel(): void };
const schedule: StocksScheduler = tick => {
  const timer = setInterval(tick, 2000);
  timer.unref();
  return { cancel: () => clearInterval(timer) };
};
export function closeOnce(action: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= Promise.resolve().then(action);
}

export function attachStocksLifecycle(app: FastifyInstance, runtime: ManagedStocksRuntime, enabled: boolean, scheduler: StocksScheduler = schedule) {
  let stopped = false;
  let started: Promise<void> | undefined;
  let timer: ReturnType<StocksScheduler> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timer?.cancel();
    runtime.stop?.();
  };
  const close = closeOnce(async () => {
    stop();
    try { await runtime.close(); }
    finally { await started?.catch(() => {}); }
  });
  app.addHook('preClose', async () => { stop(); });
  app.addHook('onClose', close);
  return {
    close,
    start() {
      return started ??= (async () => {
        if (!enabled || stopped) return;
        await runtime.tick();
        // Closing while the initial tick waits must never create a new timer.
        if (!stopped) timer = scheduler(() => {
          if (stopped) return;
          void runtime.tick().catch(() => {
            app.log.error({ code: 'STOCKS_DISPATCH_STOPPED' });
            void close().catch(() => app.log.error({ code: 'STOCKS_CLOSE_FAILED' }));
          });
        });
      })();
    },
  };
}

// Resource acquisition through listen/first tick is one ownership boundary.
// The supplied runtime and database closers run once on every partial failure.
export async function startManagedStocksServer<R extends ManagedStocksRuntime>(options: {
  createRuntime(): Promise<R | null>;
  buildApp(runtime: R | null): FastifyInstance;
  listen(app: FastifyInstance): Promise<unknown>;
  closeDatabase(): Promise<void>;
  onApp?(app: FastifyInstance): void;
  autodispatch: boolean;
  scheduler?: StocksScheduler;
}): Promise<FastifyInstance> {
  let runtime: R | null = null;
  let app: FastifyInstance | null = null;
  const closeRuntime = closeOnce(async () => { await runtime?.close(); });
  const closeDatabase = closeOnce(options.closeDatabase);
  try {
    runtime = await options.createRuntime();
    app = options.buildApp(runtime);
    // Fastify closes hooks in reverse order. Install CLI listener-removal first
    // so repeated signals remain intercepted until both resources are drained.
    options.onApp?.(app);
    app.addHook('onClose', closeDatabase);
    const lifecycle = runtime ? attachStocksLifecycle(app, { tick: () => runtime!.tick(), stop: () => runtime!.stop?.(), close: closeRuntime }, options.autodispatch, options.scheduler) : null;
    await options.listen(app);
    await lifecycle?.start();
    return app;
  } catch (error) {
    try { await app?.close(); } catch { /* retain original startup failure */ }
    await Promise.allSettled([closeRuntime(), closeDatabase()]);
    throw error;
  }
}

type SignalHost = Pick<NodeJS.Process, 'on' | 'off'> & { exitCode?: number | string | null };
// Install before resource hooks (startManagedStocksServer enforces this order).
// Only the executable entrypoint owns process signals; importing startServer
// does not install listeners. Repeated signals share the same close promise.
export function installServerShutdown(app: FastifyInstance, host: SignalHost = process): void {
  const remove = () => { host.off('SIGINT', onSignal); host.off('SIGTERM', onSignal); };
  const close = closeOnce(async () => {
    try { await app.close(); }
    catch { host.exitCode = 1; }
    finally { remove(); }
  });
  const onSignal = () => { void close(); };
  host.on('SIGINT', onSignal);
  host.on('SIGTERM', onSignal);
  app.addHook('onClose', async () => { remove(); });
}
