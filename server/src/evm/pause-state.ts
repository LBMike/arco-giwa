import { FUNCTION_PAUSE_SELECTORS, type FunctionPauseKind } from "./admin-transactions.js"

// Two independent pause layers exist on every FunctionPausable vault:
//   - whole-contract pause (`pause()` / `unpause()`, OZ Pausable): blocks EVERY guarded function;
//     `pause()` reverts when already paused and `unpause()` reverts when not paused.
//   - function pause (`pauseFn(selector)` / `unpauseFn(selector)`): one entry path at a time;
//     idempotent, never reverts on a no-op.
// `unpauseFn` cannot lift a whole-contract pause, so the admin flows must tell them apart.

/** Per-vault catalog snapshot. `*Paused` OR-includes the whole-contract pause. */
export type VaultPauseState = {
  readonly depositPaused: boolean
  readonly withdrawPaused: boolean
  /** The two entry-path selectors of the kind disagree (a half-completed sequence). */
  readonly depositPartial: boolean
  readonly withdrawPartial: boolean
  /** Whole-contract pause on the deposit vault (`paused()`); `unpauseFn` cannot lift it. */
  readonly depositVaultPaused: boolean
  /** Whole-contract pause on the redemption vault (`paused()`). */
  readonly withdrawVaultPaused: boolean
}

export const DEFAULT_PAUSE_STATE: VaultPauseState = {
  depositPaused: false,
  withdrawPaused: false,
  depositPartial: false,
  withdrawPartial: false,
  depositVaultPaused: false,
  withdrawVaultPaused: false,
}

/** One vault's raw pause reads. `fnPaused` follows FUNCTION_PAUSE_SELECTORS[kind].selectors order. */
export type VaultPauseSide = {
  readonly vaultPaused: boolean
  readonly fnPaused: readonly boolean[]
}

/** Raw per-product pause reads; a side is null when that vault has no address. */
export type VaultPauseDetail = {
  readonly deposit: VaultPauseSide | null
  readonly withdraw: VaultPauseSide | null
}

function summarizeSide(side: VaultPauseSide | null) {
  if (!side) return { paused: false, partial: false, vaultPaused: false }
  const anyFn = side.fnPaused.some(Boolean)
  return {
    paused: side.vaultPaused || anyFn,
    partial: anyFn && !side.fnPaused.every(Boolean),
    vaultPaused: side.vaultPaused,
  }
}

export function summarizePauseDetail(detail: VaultPauseDetail): VaultPauseState {
  const deposit = summarizeSide(detail.deposit)
  const withdraw = summarizeSide(detail.withdraw)
  return {
    depositPaused: deposit.paused,
    withdrawPaused: withdraw.paused,
    depositPartial: deposit.partial,
    withdrawPartial: withdraw.partial,
    depositVaultPaused: deposit.vaultPaused,
    withdrawVaultPaused: withdraw.vaultPaused,
  }
}

export type PausePlan<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Which entry-path selectors a function-pause request should actually send, given live state.
 * Skips selectors already in the requested state (a retry after a half-completed sequence signs
 * only the missing one). Unpausing while the whole vault is paused is refused: unpauseFn would
 * succeed on-chain yet leave the kind paused.
 */
export function planFunctionPause(
  side: VaultPauseSide | null,
  kind: FunctionPauseKind,
  paused: boolean,
): PausePlan<string[]> {
  const selectors = FUNCTION_PAUSE_SELECTORS[kind].selectors.map((entry) => entry.selector as string)
  if (!side) return { ok: true, value: selectors }
  if (!paused && side.vaultPaused) {
    return {
      ok: false,
      code: "VAULT_PAUSED",
      message: `the whole ${FUNCTION_PAUSE_SELECTORS[kind].vault} is paused; unpause the vault (unpause()) first — unpauseFn cannot lift it`,
    }
  }
  const pending = selectors.filter((_selector, index) => (side.fnPaused[index] ?? !paused) !== paused)
  if (pending.length === 0) {
    return { ok: false, code: "NO_CHANGE", message: `${kind} entry paths are already ${paused ? "paused" : "unpaused"}` }
  }
  return { ok: true, value: pending }
}

export type PauseTarget = "depositVault" | "redemptionVault" | "allVaults"

/**
 * Which vaults a whole-contract pause/unpause should touch, given live state. OZ `pause()`
 * reverts on an already-paused vault and `unpause()` on a running one, so those are skipped.
 */
export function planVaultPause(
  detail: VaultPauseDetail | null,
  action: "pause" | "unpause",
  target: PauseTarget,
): PausePlan<("depositVault" | "redemptionVault")[]> {
  const wanted: ("depositVault" | "redemptionVault")[] =
    target === "allVaults" ? ["depositVault", "redemptionVault"] : [target]
  if (!detail) return { ok: true, value: wanted }
  const sideOf = (vault: "depositVault" | "redemptionVault") => (vault === "depositVault" ? detail.deposit : detail.withdraw)
  const pending = wanted.filter((vault) => {
    const side = sideOf(vault)
    if (!side) return true // unknown state: let the builder decide (it throws on a missing address)
    return action === "pause" ? !side.vaultPaused : side.vaultPaused
  })
  if (pending.length === 0) {
    return { ok: false, code: "NO_CHANGE", message: `vault is already ${action === "pause" ? "paused" : "unpaused"}` }
  }
  return { ok: true, value: pending }
}
