// In-memory store of transaction hashes that an original wallet request returned after its Stocks session could no
// longer record them. It lives in this tab's memory only: a reload or a closed tab loses it. It holds plain data only
// (no token, session, signature, provider or permission) and never releases, resets or re-grants a server claim.

import { isAddress } from "viem"

import type { Side, Stage } from "../stocks-wallet/types"

export const KNOWN_HASH_CHAIN_ID = 91342
export const DEFAULT_KNOWN_HASH_LIMIT = 16

/** The owner a candidate belongs to: the same wallet on the same chain, API base and frontend origin. */
export type KnownHashScope = Readonly<{ wallet: string; chainId: number; apiBase: string; origin: string }>

/** The original claim binding, its order scope and the hash the original wallet request returned. */
export type KnownHashCandidate = Readonly<{
  claimId: string
  intentKey: string
  stage: Stage
  transactionDigest: string
  side: Side
  orderId: string
  deploymentDigest: string
  /** Lower-case wallet address of the original session. */
  wallet: string
  chainId: number
  apiBase: string
  origin: string
  /** Lower-case 0x-prefixed 32-byte hash returned by the original wallet request. */
  txHash: string
  capturedAt: number
}>

/**
 * KEPT: the server may not have the hash. RECORDED: the server has this hash, its receipt is not verified yet.
 * VERIFIED: the server's trusted receipt check finished. BLOCKED: nothing may be recorded from this tab.
 */
export type KnownHashState =
  | Readonly<{ kind: "KEPT" }>
  | Readonly<{ kind: "RECORDED" }>
  | Readonly<{ kind: "VERIFIED"; status: "CONFIRMED" | "REVERTED" }>
  | Readonly<{ kind: "BLOCKED"; reason: "CONFLICT" | "NO_CLAIM" | "BINDING_MISMATCH" }>

export type KnownHashEntry = Readonly<KnownHashCandidate & { state: KnownHashState; busy: boolean }>

export type KnownHashStore = Readonly<{
  /** Stores a validated candidate. Returns false for invalid input or another hash for an already kept claim. */
  remember(input: unknown): boolean
  /** Entries of one owner, oldest first. The same array is returned until the store changes. */
  entries(scope: KnownHashScope): readonly KnownHashEntry[]
  /** Entries of one owner for one order of one deployment. */
  forOrder(scope: KnownHashScope, side: Side, orderId: string, deploymentDigest: string): readonly KnownHashEntry[]
  get(claimId: string): KnownHashEntry | null
  /** Moves a kept candidate to a server-derived state. The claim and hash must both match. */
  settle(claimId: string, txHash: string, state: Exclude<KnownHashState, { kind: "KEPT" }>): boolean
  /** One explicit action per candidate at a time. False when another action already runs. */
  begin(claimId: string): boolean
  end(claimId: string): void
  subscribe(listener: () => void): () => void
  version(): number
  /** Candidates dropped because the store was full (tests and diagnostics). */
  dropped(): number
}>

const ID = /^[A-Za-z0-9:_-]{1,128}$/
const DIGEST = /^[a-f0-9]{64}$/
const HASH = /^0x[a-f0-9]{64}$/

function text(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null
}

function httpBase(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.href.includes("?") && !url.href.includes("#") ? value : null
  } catch {
    return null
  }
}

function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value ? value : null
  } catch {
    return null
  }
}

/** Validates and copies exactly the candidate fields. Anything else (a token, a session, a provider) is not copied. */
export function knownHashCandidate(input: unknown, now: () => number = Date.now): KnownHashCandidate | null {
  if (input === null || typeof input !== "object") return null
  const row = input as Record<string, unknown>
  const claimId = text(row.claimId, ID)
  const intentKey = text(row.intentKey, DIGEST)
  const transactionDigest = text(row.transactionDigest, DIGEST)
  const orderId = text(row.orderId, ID)
  const deploymentDigest = text(row.deploymentDigest, DIGEST)
  const txHash = text(row.txHash, HASH)
  const stage = row.stage === "APPROVAL" || row.stage === "TRANSFER" ? row.stage : null
  const side = row.side === "BUY" || row.side === "SELL" ? row.side : null
  const wallet = typeof row.wallet === "string" && isAddress(row.wallet, { strict: false }) && !/^0x0{40}$/i.test(row.wallet) ? row.wallet.toLowerCase() : null
  const apiBase = httpBase(row.apiBase)
  const origin = originOf(row.origin)
  const capturedAt = now()
  if (!claimId || !intentKey || !transactionDigest || !orderId || !deploymentDigest || !txHash || !stage || !side || !wallet || !apiBase || !origin) return null
  if (row.chainId !== KNOWN_HASH_CHAIN_ID || /^0x0{64}$/.test(txHash) || !Number.isFinite(capturedAt)) return null
  return Object.freeze({ claimId, intentKey, stage, transactionDigest, side, orderId, deploymentDigest, wallet, chainId: KNOWN_HASH_CHAIN_ID, apiBase, origin, txHash, capturedAt })
}

export function sameOwner(entry: KnownHashCandidate, scope: KnownHashScope): boolean {
  return entry.wallet === scope.wallet.toLowerCase() && entry.chainId === scope.chainId && entry.apiBase === scope.apiBase && entry.origin === scope.origin
}

const KEPT: KnownHashState = Object.freeze({ kind: "KEPT" })

/** Eviction order when full: finished entries first, then the oldest. A running action is never evicted. */
function evictionRank(entry: KnownHashEntry): number {
  switch (entry.state.kind) {
    case "VERIFIED": return 0
    case "BLOCKED": return 1
    case "RECORDED": return 2
    default: return 3
  }
}

export function createKnownHashStore(options: { limit?: number; now?: () => number } = {}): KnownHashStore {
  const limit = options.limit ?? DEFAULT_KNOWN_HASH_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("KNOWN_HASH_INVALID_LIMIT")
  const now = options.now ?? Date.now
  /** Insertion-ordered by claim ID. */
  const entries = new Map<string, KnownHashEntry>()
  const listeners = new Set<() => void>()
  const views = new Map<string, { version: number; list: readonly KnownHashEntry[] }>()
  let version = 0
  let dropped = 0

  function changed() {
    version++
    views.clear()
    listeners.forEach((listener) => {
      try {
        listener()
      } catch {
        /* A failing subscriber never changes the store. */
      }
    })
  }

  function put(entry: KnownHashEntry) {
    entries.set(entry.claimId, Object.freeze(entry))
  }

  function makeRoom() {
    while (entries.size >= limit) {
      let victim: KnownHashEntry | null = null
      for (const entry of entries.values()) {
        if (entry.busy) continue
        if (victim === null || evictionRank(entry) < evictionRank(victim)) victim = entry
      }
      if (victim === null) return false
      entries.delete(victim.claimId)
      dropped++
    }
    return true
  }

  function view(key: string, pick: () => KnownHashEntry[]): readonly KnownHashEntry[] {
    const cached = views.get(key)
    if (cached && cached.version === version) return cached.list
    const list = Object.freeze(pick())
    views.set(key, { version, list })
    return list
  }

  return Object.freeze({
    remember(input: unknown): boolean {
      const candidate = knownHashCandidate(input, now)
      if (candidate === null) return false
      const existing = entries.get(candidate.claimId)
      if (existing) {
        // The first hash for a claim is kept; another hash for it is never stored or swapped in.
        return existing.txHash === candidate.txHash && existing.intentKey === candidate.intentKey && existing.stage === candidate.stage && existing.transactionDigest === candidate.transactionDigest
      }
      if (!makeRoom()) return false
      put({ ...candidate, state: KEPT, busy: false })
      changed()
      return true
    },
    entries(scope: KnownHashScope) {
      return view(JSON.stringify(["owner", scope.wallet.toLowerCase(), scope.chainId, scope.apiBase, scope.origin]), () => [...entries.values()].filter((entry) => sameOwner(entry, scope)))
    },
    forOrder(scope: KnownHashScope, side: Side, orderId: string, deploymentDigest: string) {
      return view(JSON.stringify(["order", scope.wallet.toLowerCase(), scope.chainId, scope.apiBase, scope.origin, side, orderId, deploymentDigest]), () =>
        [...entries.values()].filter((entry) => sameOwner(entry, scope) && entry.side === side && entry.orderId === orderId && entry.deploymentDigest === deploymentDigest),
      )
    },
    get: (claimId: string) => entries.get(claimId) ?? null,
    settle(claimId: string, txHash: string, state: Exclude<KnownHashState, { kind: "KEPT" }>): boolean {
      const entry = entries.get(claimId)
      if (!entry || entry.txHash !== txHash) return false
      // A trusted result is final for this tab; a pending or blocked note never replaces it.
      if (entry.state.kind === "VERIFIED") return false
      put({ ...entry, state: Object.freeze({ ...state }) as KnownHashState })
      changed()
      return true
    },
    begin(claimId: string): boolean {
      const entry = entries.get(claimId)
      if (!entry || entry.busy) return false
      put({ ...entry, busy: true })
      changed()
      return true
    },
    end(claimId: string) {
      const entry = entries.get(claimId)
      if (!entry || !entry.busy) return
      put({ ...entry, busy: false })
      changed()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version,
    dropped: () => dropped,
  })
}

/** The page's store. One per tab (module memory): a reload or a closed tab loses every candidate. */
export const tabKnownHashStore: KnownHashStore = createKnownHashStore()
