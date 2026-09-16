// A disconnected runtime has no timer guarantee. Readiness therefore expires
// even if nobody invokes tick again after the last successful observation.
export class StocksObservationHealth {
  private lastCurrent: number | null = null;
  private state = 'STARTING';
  constructor(private readonly now: () => number = Date.now) {}
  record(state: string): void {
    this.state = state;
    this.lastCurrent = state === 'CURRENT' ? this.now() : null;
  }
  current(): boolean {
    const age = this.lastCurrent === null ? -1 : this.now() - this.lastCurrent;
    return this.state === 'CURRENT' && age >= 0 && age <= 60000;
  }
  status(): string { return this.state === 'CURRENT' && !this.current() ? 'STALE' : this.state; }
}
