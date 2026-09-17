import { getAddress, isAddress } from "viem"
import type { AttemptRecord, Transaction } from "../stocks-wallet/types"

export class SubmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "SubmissionError" }
}
export function ensure(value: unknown, code = "SUBMISSION_INVALID_RESPONSE"): asserts value {
  if (!value) throw new SubmissionError(code)
}
export function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value))
  return value as Record<string, unknown>
}
export function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  ensure(required.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)))
}
export function label(value: unknown): string {
  ensure(typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value), "SUBMISSION_INVALID_ID")
  return value
}
export function digestString(value: unknown): string {
  ensure(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "SUBMISSION_INVALID_DIGEST")
  return value
}
export function wallet(value: unknown): string {
  ensure(typeof value === "string" && isAddress(value) && !/^0x0{40}$/i.test(value), "SUBMISSION_INVALID_WALLET")
  return getAddress(value)
}
export function attempt(value: unknown, allowTerminal = false): AttemptRecord {
  const row = object(value)
  exact(row, ["claimId", "intentKey", "stage", "transactionDigest", "status"], ["txHash"])
  label(row.claimId); digestString(row.intentKey); digestString(row.transactionDigest)
  ensure(row.stage === "APPROVAL" || row.stage === "TRANSFER")
  ensure(["REQUEST_MAY_START", "UNKNOWN", "SUBMITTED", ...(allowTerminal ? ["CONFIRMED", "REVERTED"] : [])].includes(String(row.status)))
  if (Object.prototype.hasOwnProperty.call(row, "txHash")) ensure(typeof row.txHash === "string" && /^0x[a-f0-9]{64}$/.test(row.txHash) && !/^0x0{64}$/.test(row.txHash))
  ensure(!["SUBMITTED", "CONFIRMED", "REVERTED"].includes(String(row.status)) || row.txHash !== undefined)
  ensure(row.status !== "REQUEST_MAY_START" || row.txHash === undefined)
  return Object.freeze({ ...row }) as AttemptRecord
}
export function transaction(value: unknown, owner: string): Transaction {
  const row = object(value)
  exact(row, ["chainId", "from", "to", "data", "value"])
  ensure(row.chainId === 91342 && row.value === "0", "SUBMISSION_TRANSACTION_MISMATCH")
  // The reviewed planner emits canonical EIP55 addresses. Do not silently change its digest.
  ensure(row.from === wallet(row.from) && row.to === wallet(row.to) && row.from === owner, "SUBMISSION_TRANSACTION_MISMATCH")
  ensure(typeof row.data === "string" && /^0x(?:[a-f0-9]{2}){4,4096}$/.test(row.data), "SUBMISSION_TRANSACTION_MISMATCH")
  return Object.freeze({ ...row }) as Transaction
}
export function envelope(value: unknown): unknown {
  const row = object(value)
  exact(row, ["profile", "valuePolicy", "brokerMode", "chainId", "priceSource", "observedAt", "data"])
  ensure(row.profile === "DEMO_TESTNET" && row.valuePolicy === "TEST_VALUE_ONLY" && row.brokerMode === "MOCK_BROKER" && row.chainId === 91342 && row.priceSource === "FIXED_MOCK_PRICE", "SUBMISSION_PROFILE_MISMATCH")
  ensure(typeof row.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.observedAt) && Number.isFinite(Date.parse(row.observedAt)) && new Date(row.observedAt).toISOString() === row.observedAt)
  return row.data
}
