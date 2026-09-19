import type { Operator } from '../stocks/contracts.js';

export type TradingControlState = {
  deploymentDigest: string;
  paused: boolean;
  version: number;
  updatedAt: string | null;
  operatorId: string | null;
  reason: string | null;
};
export type TradingControlCommand = {
  paused: boolean;
  expectedVersion: number;
  idempotencyKey: string;
  reason: string;
};
export type TradingControlEvent = {
  id: string;
  deploymentDigest: string;
  version: number;
  previousPaused: boolean;
  paused: boolean;
  operatorId: string;
  reason: string;
  createdAt: string;
};
export type TradingControlChange = { state: TradingControlState; change: TradingControlEvent; replayed: boolean };
export type TradingControlHistory = { items: TradingControlEvent[]; nextBeforeVersion: number | null };
export type TradingControlPort = {
  read(): Promise<TradingControlState>;
  change(operator: Operator, command: TradingControlCommand): Promise<TradingControlChange>;
  history(limit?: number, beforeVersion?: number): Promise<TradingControlHistory>;
};
/** Cached process-local diagnostic only. Authorization always reads the DB. */
export type OperatorControlStatus = {
  status: 'PAUSED' | 'RESUMED' | 'UNAVAILABLE';
  version: number | null;
};
