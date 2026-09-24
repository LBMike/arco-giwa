/** Install once for the owned pool's whole lifetime, including startup and shutdown.
 * pg emits idle-client errors outside query promises. Never log the error/client:
 * they can contain connection credentials. A replacement runtime is resolved at
 * event time so a local backend reload keeps the current admission gate protected.
 */
export function watchStocksPoolErrors(
  pool: { on(event: 'error', listener: () => void): unknown },
  currentRuntime: () => { notifyDatabaseFailure(): void } | undefined,
): void {
  pool.on('error', () => { currentRuntime()?.notifyDatabaseFailure(); });
}
