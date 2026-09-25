import type { Artifacts } from "hardhat/types"
import {
  assertPreparedStep,
  verifyPreparedDeployment,
  type UnsignedStocksDeployment,
} from "./prepare-deployment"
import {
  assertPreparedExternalCashStep,
  verifyPreparedExternalCashDeployment,
  type UnsignedExternalCashDeployment,
} from "./prepare-external-cash"

export type LocalUnsignedDeployment = UnsignedStocksDeployment | UnsignedExternalCashDeployment
export type LocalDeploymentObservation = Parameters<typeof assertPreparedStep>[2]
export function isExternalCashPlan(
  plan: LocalUnsignedDeployment,
): plan is UnsignedExternalCashDeployment {
  return plan.kind === "ARCO_GIWA_STOCKS_EXTERNAL_CASH_UNSIGNED_DEPLOYMENT_V1"
}
/** Exact discriminated policies; v2 still rebuilds its original five-CREATE plan unchanged. */
export async function verifyPreparedLocalDeployment(
  value: unknown,
  artifacts: Pick<Artifacts, "readArtifact" | "getBuildInfo">,
): Promise<LocalUnsignedDeployment> {
  return value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "ARCO_GIWA_STOCKS_EXTERNAL_CASH_UNSIGNED_DEPLOYMENT_V1"
    ? verifyPreparedExternalCashDeployment(value, artifacts)
    : verifyPreparedDeployment(value, artifacts)
}
export function assertPreparedLocalStep(
  plan: LocalUnsignedDeployment,
  index: number,
  observed: LocalDeploymentObservation,
) {
  return isExternalCashPlan(plan)
    ? assertPreparedExternalCashStep(plan, index, observed)
    : assertPreparedStep(plan, index, observed)
}
