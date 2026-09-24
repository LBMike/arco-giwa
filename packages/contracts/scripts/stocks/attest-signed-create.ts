import { utils } from "ethers"
import type { Artifacts } from "hardhat/types"
import {
  assertPreparedStep,
  verifyPreparedDeployment,
  type UnsignedStocksDeployment,
} from "./prepare-deployment"

type ArtifactReader = Pick<Artifacts, "readArtifact" | "getBuildInfo">

export type SignedCreateFeeLimits = Readonly<{
  maxGas: bigint
  maxPriorityFeePerGas: bigint
  maxFeePerGas: bigint
  maxTotalFeeWei: bigint
}>

export type SignedCreateAttestationInput = Readonly<{
  plan: UnsignedStocksDeployment
  /** Retained separately from the plan being checked. */
  expectedPlanDigest: string
  stepIndex: number
  /** Fresh trusted chain, pending-nonce and finalized completed-prefix observations. */
  observed: Parameters<typeof assertPreparedStep>[2]
  signedTransaction: string
  limits: SignedCreateFeeLimits
}>

const CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
const MAX_RAW_BYTES = 64 * 1024
const MAX_INITCODE_BYTES = 49_152
const failure = () => new Error("SIGNED_DEPLOYMENT_ATTESTATION_FAILED")

function requireValue(value: unknown): asserts value {
  if (!value) throw failure()
}

function bytes(value: unknown): string {
  requireValue(typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value))
  return value
}

/** EIP-2718/RLP integers use an empty byte string for zero and no leading zero bytes. */
function integer(value: unknown): bigint {
  const encoded = bytes(value)
  requireValue(encoded === "0x" || encoded.slice(2, 4) !== "00")
  return BigInt(encoded === "0x" ? "0x0" : encoded)
}

function limit(value: unknown, allowZero = false): bigint {
  requireValue(typeof value === "bigint" && (allowZero ? value >= 0n : value > 0n))
  return value
}

function createIntrinsicGas(initCodeHex: string): bigint {
  const initCode = utils.arrayify(initCodeHex)
  requireValue(initCode.length > 0 && initCode.length <= MAX_INITCODE_BYTES)
  let calldataGas = 0n
  for (const byte of initCode) calldataGas += byte === 0 ? 4n : 16n
  // Cancun: base transaction + CREATE surcharge + calldata + EIP-3860 words.
  return 21_000n + 32_000n + calldataGas + 2n * ((BigInt(initCode.length) + 31n) / 32n)
}

/**
 * Attest one externally signed, original EIP-1559 CREATE without an RPC or key.
 * The caller retains the approved digest independently and supplies fresh
 * chain/pending-nonce and finalized prior-code observations from a trusted
 * source. This pure function cannot establish that those observations are real,
 * or that they remain current before send. It checks only CREATE intrinsic gas;
 * the executor must separately check base fee, estimate actual execution gas,
 * refresh chain state immediately before sending, and verify final receipts.
 * This function neither queries an RPC nor broadcasts.
 */
export async function attestSignedStocksCreate(
  input: SignedCreateAttestationInput,
  artifacts: ArtifactReader,
): Promise<string> {
  try {
    requireValue(input && typeof input === "object" && !Array.isArray(input))
    requireValue(
      typeof input.expectedPlanDigest === "string" &&
        /^[0-9a-f]{64}$/.test(input.expectedPlanDigest),
    )
    // Rebuild the complete plan from pinned build artifacts; its self-declared
    // digest alone is never authority for signed bytes.
    const plan = await verifyPreparedDeployment(input.plan, artifacts)
    requireValue(plan.planDigest === input.expectedPlanDigest)
    requireValue(
      Number.isInteger(input.stepIndex) &&
        input.stepIndex >= 0 &&
        input.stepIndex < plan.steps.length,
    )
    const step = plan.steps[input.stepIndex]
    assertPreparedStep(plan, input.stepIndex, input.observed)
    const raw = input.signedTransaction
    requireValue(
      typeof raw === "string" &&
        /^0x02(?:[0-9a-f]{2})+$/i.test(raw) &&
        (raw.length - 2) / 2 <= MAX_RAW_BYTES,
    )
    const decoded = utils.RLP.decode(`0x${raw.slice(4)}`)
    requireValue(
      Array.isArray(decoded) &&
        decoded.length === 12 &&
        utils.RLP.encode(decoded).toLowerCase() === `0x${raw.slice(4).toLowerCase()}`,
    )
    const [chainId, nonce, priorityFee, maxFee, gas, to, value, data, accessList, parity, r, s] =
      decoded
    requireValue(integer(chainId) === BigInt(step.transaction.chainId))
    requireValue(integer(nonce) === BigInt(step.transaction.nonce))
    requireValue(
      to === "0x" &&
        integer(value) === 0n &&
        step.transaction.to === null &&
        step.transaction.value === "0x0",
    )
    requireValue(bytes(data).toLowerCase() === step.transaction.data.toLowerCase())
    requireValue(Array.isArray(accessList) && accessList.length === 0)

    const fees = input.limits
    requireValue(fees && typeof fees === "object" && !Array.isArray(fees))
    const maxGas = limit(fees.maxGas)
    const maxPriority = limit(fees.maxPriorityFeePerGas, true)
    const maxPerGas = limit(fees.maxFeePerGas)
    const maxTotal = limit(fees.maxTotalFeeWei)
    requireValue(maxPriority <= maxPerGas)
    const signedGas = integer(gas)
    const signedPriority = integer(priorityFee)
    const signedMax = integer(maxFee)
    requireValue(
      signedGas >= createIntrinsicGas(bytes(data)) &&
        signedGas <= maxGas &&
        signedMax > 0n &&
        signedMax <= maxPerGas &&
        signedPriority <= signedMax &&
        signedPriority <= maxPriority &&
        signedGas * signedMax <= maxTotal,
    )

    const recovery = integer(parity)
    const signedR = integer(r)
    const signedS = integer(s)
    requireValue(
      recovery <= 1n &&
        signedR > 0n &&
        signedR < CURVE_ORDER &&
        signedS > 0n &&
        signedS <= CURVE_ORDER / 2n,
    )
    const digest = utils.keccak256(utils.hexConcat(["0x02", utils.RLP.encode(decoded.slice(0, 9))]))
    const recovered = utils.recoverAddress(digest, {
      r: utils.hexZeroPad(bytes(r), 32),
      s: utils.hexZeroPad(bytes(s), 32),
      recoveryParam: Number(recovery),
    })
    requireValue(recovered.toLowerCase() === step.transaction.from.toLowerCase())
    return utils.keccak256(raw)
  } catch {
    // Ethers parsing errors may embed the entire signed transaction. Never pass
    // them, provider data, or the signed hash back to the caller.
    throw failure()
  }
}
