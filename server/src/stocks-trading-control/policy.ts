import { ensure, type Operator } from '../stocks/contracts.js';
import type { OperatorControlStatus, TradingControlCommand, TradingControlPort, TradingControlState } from './contracts.js';

export const CONTROL_SNAPSHOT_MAX_AGE_MS = 5000;
type Clock = { wall: number; mono: number };
type Observation = { state: TradingControlState; clock: Clock };

// No authorization cache: every admission check reads the shared database.
// The short-lived snapshot is only for the existing synchronous diagnostics API.
export class StocksTradingControlPolicy implements TradingControlPort {
  // Revisions are durable ordering evidence; read-start order is not DB order.
  // A contradictory revision stays unavailable until a higher revision appears.
  private highest: { version: number; paused: boolean | null } | null = null;
  private cached: Observation | null = null;
  constructor(private readonly source: TradingControlPort, private readonly deploymentDigest: string,
    private readonly now: () => number = Date.now, private readonly monotonicNow: () => number = () => performance.now()) {}

  private clock() { return { wall: this.now(), mono: this.monotonicNow() }; }
  private fresh(start: Clock) {
    const clock = this.clock(), wallAge = clock.wall - start.wall, monoAge = clock.mono - start.mono;
    return [clock.wall, clock.mono, wallAge, monoAge].every(Number.isFinite)
      && wallAge >= 0 && monoAge >= 0 && Math.max(wallAge, monoAge) <= CONTROL_SNAPSHOT_MAX_AGE_MS;
  }
  private observe(observation: Observation) {
    const { state, clock } = observation;
    ensure(state && !Array.isArray(state) && state.deploymentDigest === this.deploymentDigest && typeof state.paused === 'boolean'
      && Number.isSafeInteger(state.version) && state.version >= 0 && state.version <= 2147483647
      && (state.version !== 0 || state.paused), 'TRADING_CONTROL_UNAVAILABLE', 503);
    if (this.highest && state.version < this.highest.version) return;
    if (this.highest && state.version === this.highest.version) {
      if (state.paused !== this.highest.paused) {
        this.highest.paused = null;
        this.cached = null;
        return;
      }
    } else {
      this.highest = { version: state.version, paused: state.paused };
      this.cached = null;
    }
    // A late result at the same revision cannot shorten a newer observation.
    if (this.fresh(clock) && (!this.cached || !this.fresh(this.cached.clock) || clock.mono >= this.cached.clock.mono)) this.cached = { state: structuredClone(state), clock: { ...clock } };
  }
  private async readObservation(): Promise<Observation> {
    try {
      const clock = this.clock();
      const observation = { state: structuredClone(await this.source.read()), clock };
      this.observe(observation);
      return observation;
    } catch (error) { this.cached = null; throw error; }
  }
  async read() { return (await this.readObservation()).state; }
  async change(operator: Operator, command: TradingControlCommand) {
    const result = await this.source.change(operator, command);
    // An acknowledged revision supersedes every lower in-flight DB result.
    this.observe({ state: structuredClone(result.state), clock: this.clock() });
    return result;
  }
  history(limit?: number, beforeVersion?: number) { return this.source.history(limit, beforeVersion); }
  async isPaused(): Promise<boolean> {
    try {
      const own = await this.readObservation();
      // Admission uses only this DB result. Concurrent diagnostics cannot lend
      // authority to a slow/invalid read or erase a newer acknowledged pause.
      return own.state.paused || !this.fresh(own.clock) || own.state.version !== this.highest?.version || this.highest.paused !== false;
    }
    catch { return true; } // DB/control failure cannot authorize new dispatch.
  }
  snapshot(): OperatorControlStatus {
    if (this.cached && !this.fresh(this.cached.clock)) this.cached = null;
    return this.cached ? { status: this.cached.state.paused ? 'PAUSED' : 'RESUMED', version: this.cached.state.version }
      : { status: 'UNAVAILABLE', version: null };
  }
}
