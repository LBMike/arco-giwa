import type { Manifest } from '../stocks/contracts.js';
export type ReviewedDeployment = Readonly<{
  status: 'VERIFIED'; evidenceId: string; manifestDigest: string; manifest: Manifest;
  verifiedAt: number; validUntil: number;
}>;
/** Trusted server composition only; no browser/config flag can substitute for evidence. */
export type DeploymentEvidencePort = { get(): Promise<ReviewedDeployment> };
export type ExecutionPolicy = Readonly<{
  allowed: true; deploymentDigest: string; orderId: string; side: 'BUY' | 'SELL';
  observedAt: number; validUntil: number;
}>;
