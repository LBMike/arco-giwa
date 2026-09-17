import { OBSERVER_STATES, type ObserverStatus } from '../stocks-runtime-status/contracts.js';

export type ObservationSnapshot = {
  observerStatus: ObserverStatus; current: boolean;
  lastObservationAt: string | null; lastCurrentAt: string | null;
  lastCurrentAgeMs: number | null; freshnessLimitMs: 60000;
  observedAt: string | null;
};

// Freshness expires without timer activity. Both clocks constrain the interval;
// clock reversals/expiry latch stale until a new valid CURRENT observation.
export class StocksObservationHealth {
  private lastObservation: number | null = null;
  private lastCurrent: { wall: number; mono: number } | null = null;
  private previousWall = -Infinity;
  private previousMono = -Infinity;
  private stale = false;
  private state: ObserverStatus = 'STARTING';
  constructor(private readonly now: () => number = Date.now, private readonly monotonicNow: () => number = () => performance.now()) {}
  private clock() {
    const wall = this.now(), mono = this.monotonicNow();
    const wallValid = Number.isSafeInteger(wall) && wall >= 0 && wall <= 8640000000000000;
    const monoValid = Number.isFinite(mono) && mono >= 0;
    const valid = wallValid && monoValid && wall >= this.previousWall && mono >= this.previousMono;
    if (!valid) this.stale = true;
    if (wallValid) this.previousWall = Math.max(this.previousWall, wall);
    if (monoValid) this.previousMono = Math.max(this.previousMono, mono);
    return { wall, mono, valid, wallValid };
  }
  record(state: string): void {
    if (this.state === 'STOPPED') return;
    const clock = this.clock();
    this.state = OBSERVER_STATES.includes(state as ObserverStatus) ? state as ObserverStatus : 'UNAVAILABLE_OR_REVIEW_REQUIRED';
    if (this.state === 'STOPPED') return;
    this.lastObservation = clock.wallValid ? clock.wall : null;
    if (this.state === 'CURRENT') {
      if (clock.valid) { this.lastCurrent = { wall: clock.wall, mono: clock.mono }; this.stale = false; }
      else this.state = 'UNAVAILABLE_OR_REVIEW_REQUIRED';
    }
  }
  snapshot(): ObservationSnapshot {
    const clock = this.clock();
    const wallAge = this.lastCurrent ? clock.wall - this.lastCurrent.wall : -1;
    const monoAge = this.lastCurrent ? clock.mono - this.lastCurrent.mono : -1;
    const age = clock.valid && wallAge >= 0 && monoAge >= 0 ? Math.ceil(Math.max(wallAge, monoAge)) : null;
    if (this.state === 'CURRENT' && (age === null || age > 60000)) this.stale = true;
    const observerStatus = this.state === 'CURRENT' && this.stale ? 'STALE' : this.state;
    return {
      observerStatus, current: observerStatus === 'CURRENT',
      lastObservationAt: this.lastObservation === null ? null : new Date(this.lastObservation).toISOString(),
      lastCurrentAt: this.lastCurrent === null ? null : new Date(this.lastCurrent.wall).toISOString(),
      lastCurrentAgeMs: age, freshnessLimitMs: 60000,
      observedAt: clock.wallValid ? new Date(clock.wall).toISOString() : null,
    };
  }
  current(): boolean { return this.snapshot().current; }
  status(): ObserverStatus { return this.snapshot().observerStatus; }
}
