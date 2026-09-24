import type { Side, Stage } from '../stocks-submissions/contracts.js';
export type ReceiptSummary = {
  status: 'CONFIRMED' | 'REVERTED'; blockNumber: string; blockHash: string; verifiedAt: string;
};
export type SubmissionDiagnostic = {
  claimId: string; intentKey: string; stage: Stage; transactionDigest: string;
  status: 'REQUEST_MAY_START' | 'UNKNOWN' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED';
  txHash: string | null; createdAt: string; updatedAt: string; receipt: ReceiptSummary | null;
};
export type SubmissionDiagnosticsData = {
  deploymentId: string; deploymentDigest: string;
  order: { id: string; side: Side; state: string; wallet: string; version: number; quoteExpiresAt: string; quoteExpired: boolean };
  enrollment: 'ENROLLED' | 'NOT_ENROLLED'; intentKey: string;
  approval: SubmissionDiagnostic | null; transfer: SubmissionDiagnostic | null;
  readOnly: true; executionAuthorization: false; resubmissionAllowed: false;
};
export type SubmissionDiagnosticsSnapshot = { observedAt: string; data: SubmissionDiagnosticsData };
export type SubmissionDiagnosticsReader = { inspect(side: Side, orderId: string): Promise<SubmissionDiagnosticsSnapshot> };
