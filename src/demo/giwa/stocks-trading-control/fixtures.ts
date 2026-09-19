// EXPLICIT FIXTURES — tests only. The feature never imports this file. Shapes mirror
// server/src/stocks-trading-control/plugin.ts and server/src/stocks-runtime-status/plugin.ts.
import { expectedPauseReasons } from "./parse"
import type { StocksAdminFetch, StocksAdminResponse } from "../stocks-admin/types"

export const TC_PROFILE = Object.freeze({ profile: "DEMO_TESTNET", valuePolicy: "TEST_VALUE_ONLY", brokerMode: "MOCK_BROKER", chainId: 91342, priceSource: "FIXED_MOCK_PRICE" })
export const TC_DIGEST = "5f0c2b7d9e41a3c6b8d0f2e4a6c8b0d2f4e6a8c0b2d4f6e8a0c2e4b6d8f0a2c4"
export const TC_OBSERVED_AT = "2026-09-19T09:00:00.000Z"
export const TC_NOW = Date.parse("2026-09-19T09:00:05.000Z")
export const TC_FLAGS = Object.freeze({ executionAuthorization: false, inFlightMayContinue: true })

export function tcEnvelope(data: unknown, observedAt: string = TC_OBSERVED_AT) {
  return { ...TC_PROFILE, observedAt, data }
}
export function tcError(error: string, observedAt: string = TC_OBSERVED_AT) {
  return { ...TC_PROFILE, observedAt, data: null, error }
}

export function tcTime(version: number): string {
  return new Date(Date.parse("2026-09-19T08:00:00.000Z") + version * 60_000).toISOString()
}

export function tcState(version: number, paused: boolean, options: { operatorId?: string; reason?: string; updatedAt?: string } = {}) {
  if (version === 0) return { deploymentDigest: TC_DIGEST, paused: true, version: 0, updatedAt: null, operatorId: null, reason: null }
  return { deploymentDigest: TC_DIGEST, paused, version, updatedAt: options.updatedAt ?? tcTime(version), operatorId: options.operatorId ?? "ops-control-a", reason: options.reason ?? `Reason for version ${version}` }
}

export function tcEvent(version: number, paused: boolean, options: { previousPaused?: boolean; operatorId?: string; reason?: string; createdAt?: string; id?: string } = {}) {
  return {
    id: options.id ?? `evt-${version}`,
    deploymentDigest: TC_DIGEST,
    version,
    previousPaused: options.previousPaused ?? !paused,
    paused,
    operatorId: options.operatorId ?? "ops-control-a",
    reason: options.reason ?? `Reason for version ${version}`,
    createdAt: options.createdAt ?? tcTime(version),
  }
}

export function tcRead(state: unknown) {
  return { state, ...TC_FLAGS }
}
export function tcChange(state: unknown, change: unknown, replayed = false) {
  return { state, change, replayed, ...TC_FLAGS }
}
export function tcHistory(items: unknown[], nextBeforeVersion: number | null) {
  return { items, nextBeforeVersion, ...TC_FLAGS }
}

export type RuntimeInput = {
  runtimeState?: "RUNNING" | "STOPPED"
  autodispatch?: boolean
  configuredPause?: boolean
  operatorControl?: { status: "PAUSED" | "RESUMED" | "UNAVAILABLE"; version: number | null } | undefined
  observerStatus?: "CURRENT" | "STALE" | "STOPPED" | "STARTING"
  observedAt?: string
}

/** A runtime status body whose pause reasons are derived exactly like the server's adapter. */
export function tcRuntime(input: RuntimeInput = {}) {
  const observedAt = input.observedAt ?? TC_OBSERVED_AT
  const runtimeState = input.runtimeState ?? "RUNNING"
  const observerStatus = input.observerStatus ?? (runtimeState === "STOPPED" ? "STOPPED" : "CURRENT")
  const autodispatch = input.autodispatch ?? true
  const configuredPause = input.configuredPause ?? false
  const operatorControl = "operatorControl" in input ? input.operatorControl : { status: "PAUSED" as const, version: 0 }
  const current = observerStatus === "CURRENT"
  const lastCurrentAt = current ? new Date(Date.parse(observedAt) - 2_000).toISOString() : null
  const pauseReasons = expectedPauseReasons({ runtimeState, autodispatch, configuredPause, operatorControl: operatorControl ?? null, observerStatus })
  return {
    enabled: true,
    runtimeState,
    deploymentId: "giwa-stocks-testnet-v2",
    deploymentDigest: TC_DIGEST,
    autodispatch,
    configuredPause,
    ...(operatorControl === undefined ? {} : { operatorControl }),
    observerStatus,
    lastObservationAt: current ? new Date(Date.parse(observedAt) - 1_000).toISOString() : null,
    lastCurrentAt,
    lastCurrentAgeMs: current ? 2_000 : null,
    freshnessLimitMs: 60000,
    tickInFlight: false,
    newOrdersPaused: pauseReasons.length > 0,
    pauseReasons,
    executionAuthorization: false,
  }
}

export type TcReply = { readonly status: number; readonly body?: unknown; readonly raw?: string }
export type TcRequest = {
  readonly url: string
  readonly path: string
  readonly init: RequestInit
  readonly method: string
  readonly authorization: string | null
  respond(reply: TcReply): void
  fail(error?: unknown): void
}

/** A transport whose requests wait until the test answers them (like fetch, it rejects once aborted unless told not to). */
export function controlledTcTransport(options: { ignoreAbort?: boolean } = {}): { fetch: StocksAdminFetch; pending: TcRequest[]; all: TcRequest[]; take(method: string, path: string): TcRequest } {
  const pending: TcRequest[] = []
  const all: TcRequest[] = []
  const fetch: StocksAdminFetch = (url, init) =>
    new Promise<StocksAdminResponse>((resolve, reject) => {
      const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "")
      const headers = (init.headers ?? {}) as Record<string, string>
      const request: TcRequest = {
        url,
        path,
        init,
        method: String(init.method ?? "GET"),
        authorization: headers.authorization ?? null,
        respond(reply) {
          remove()
          const text = reply.raw ?? JSON.stringify(reply.body ?? null)
          resolve({ status: reply.status, text: async () => text })
        },
        fail(error = new TypeError("network down")) {
          remove()
          reject(error)
        },
      }
      const remove = () => {
        const index = pending.indexOf(request)
        if (index >= 0) pending.splice(index, 1)
      }
      pending.push(request)
      all.push(request)
      if (!options.ignoreAbort && init.signal) {
        const abort = () => {
          remove()
          reject(new DOMException("The operation was aborted.", "AbortError"))
        }
        if (init.signal.aborted) abort()
        else init.signal.addEventListener("abort", abort, { once: true })
      }
    })
  return {
    fetch,
    pending,
    all,
    take(method, path) {
      const index = pending.findIndex((request) => request.method === method && request.path === path)
      if (index < 0) throw new Error(`no pending ${method} ${path}; pending: ${pending.map((request) => `${request.method} ${request.path}`).join(", ")}`)
      return pending[index]
    },
  }
}

export const ok = (data: unknown, observedAt?: string): TcReply => ({ status: 200, body: tcEnvelope(data, observedAt) })
