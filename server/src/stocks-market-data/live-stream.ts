/**
 * Shares one upstream market snapshot read across a bounded set of consumers.
 * Transport adapters (for example SSE) own connection and wire-format handling.
 * The read result must be JSON-serializable; serialization also isolates listeners.
 */
export interface SnapshotStreamHub<T> {
  subscribe(listener: (snapshot: T) => void | Promise<void>): () => void;
  refreshNow(): Promise<void>;
  subscriberCount(): number;
  close(): void;
}

export interface SnapshotStreamOptions<T> {
  read: () => Promise<T>;
  intervalMs?: number;
  maxSubscribers?: number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
  onError?: (error: unknown) => void;
}

interface Subscriber<T> {
  listener: (snapshot: T) => void | Promise<void>;
  busy: boolean;
}

const defaultSchedule = (tick: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

export function createSnapshotStreamHub<T>({
  read,
  intervalMs = 30_000,
  maxSubscribers = 64,
  schedule = defaultSchedule,
  onError,
}: SnapshotStreamOptions<T>): SnapshotStreamHub<T> {
  if (typeof read !== 'function' || typeof schedule !== 'function' ||
    !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
    !Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1) {
    throw new Error('INVALID_SNAPSHOT_STREAM_CONFIG');
  }

  const subscribers = new Set<Subscriber<T>>();
  let stopTimer: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let inFlightGeneration = -1;
  let latest: string | null = null;
  let generation = 0;
  let closed = false;

  const reportError = (error: unknown): void => {
    try { onError?.(error); } catch { /* an observer must not break the hub */ }
  };

  const stop = (): void => {
    generation++;
    latest = null;
    const cancel = stopTimer;
    stopTimer = null;
    try { cancel?.(); } catch (error) { reportError(error); }
  };

  const remove = (subscriber: Subscriber<T>): void => {
    if (!subscribers.delete(subscriber)) return;
    if (subscribers.size === 0) stop();
  };

  const deliver = (subscriber: Subscriber<T>, serialized: string): void => {
    if (!subscribers.has(subscriber) || subscriber.busy) return;
    try {
      const result = subscriber.listener(JSON.parse(serialized) as T);
      if (result && typeof result.then === 'function') {
        subscriber.busy = true;
        void Promise.resolve(result).then(
          () => { subscriber.busy = false; },
          error => { subscriber.busy = false; reportError(error); remove(subscriber); },
        );
      }
    } catch (error) {
      reportError(error);
      remove(subscriber);
    }
  };

  const refreshNow = (): Promise<void> => {
    if (closed || subscribers.size === 0) return Promise.resolve();
    if (inFlight) {
      const current = inFlight;
      // A prior read may still be finishing after all old clients disconnected.
      // Wait for it, then start a fresh read for the new subscriber generation.
      return inFlightGeneration === generation ? current : current.then(() => refreshNow());
    }
    const readGeneration = generation;
    const run = (async () => {
      try {
        const serialized = JSON.stringify(await read());
        if (typeof serialized !== 'string') throw new Error('INVALID_SNAPSHOT_STREAM_RESULT');
        if (closed || subscribers.size === 0 || generation !== readGeneration) return;
        latest = serialized;
        for (const subscriber of [...subscribers]) deliver(subscriber, serialized);
      } catch (error) {
        if (!closed && subscribers.size > 0 && generation === readGeneration) reportError(error);
      }
    })();
    inFlight = run;
    inFlightGeneration = readGeneration;
    void run.then(() => { if (inFlight === run) inFlight = null; });
    return run;
  };

  return {
    subscribe(listener) {
      if (closed) throw new Error('SNAPSHOT_STREAM_CLOSED');
      if (typeof listener !== 'function') throw new Error('INVALID_SNAPSHOT_STREAM_LISTENER');
      if (subscribers.size >= maxSubscribers) throw new Error('SNAPSHOT_STREAM_CAPACITY');
      const first = subscribers.size === 0;
      const subscriber: Subscriber<T> = { listener, busy: false };
      subscribers.add(subscriber);
      if (first) {
        generation++;
        try { stopTimer = schedule(() => { void refreshNow(); }, intervalMs); }
        catch (error) { subscribers.delete(subscriber); stop(); throw error; }
        void refreshNow();
      } else if (latest !== null) {
        deliver(subscriber, latest);
      }
      return () => remove(subscriber);
    },
    refreshNow,
    subscriberCount: () => subscribers.size,
    close() {
      if (closed) return;
      closed = true;
      subscribers.clear();
      stop();
    },
  };
}
