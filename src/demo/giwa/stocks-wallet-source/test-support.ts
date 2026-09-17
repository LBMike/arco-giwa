// TEST SUPPORT ONLY. A minimal fake EIP-1193 provider and reviewed deployments. Not exported by index.ts.

import assert from "node:assert/strict"
import type { Address, Hex } from "viem"
import { StocksWalletError, digest } from "../stocks-wallet/planner"
import type { ManifestV2, ReviewedDeployment } from "../stocks-wallet/types"
import { evidence, manifest, WALLET } from "../stocks-wallet-http/test-support"

export { WALLET }
export const OTHER = "0x2222222222222222222222222222222222222222" as Address
export const CHECKPOINT = `0x${"a".repeat(64)}` as Hex
export const TX_HASH = `0x${"c".repeat(64)}` as Hex
export const WALLET_METHODS = ["eth_chainId", "eth_accounts", "eth_getBlockByNumber", "eth_call"]

export type Call = { method: string; params: unknown }
/** A fixed value, or a function of (params, per-method index) that may return a promise or throw. */
export type Answer = unknown | ((params: unknown, index: number) => unknown)

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

export function defaultAnswers(): Record<string, Answer> {
  return {
    eth_chainId: "0x164ce",
    eth_accounts: [WALLET.toLowerCase()],
    eth_getBlockByNumber: { number: "0x1", hash: CHECKPOINT, parentHash: `0x${"9".repeat(64)}` },
    eth_call: `0x${"0".repeat(64)}`,
    eth_sendTransaction: TX_HASH,
  }
}

/** Logs every request synchronously; a scripted promise is returned as the same object. */
export function fakeProvider(overrides: Record<string, Answer> = {}) {
  const answers: Record<string, Answer> = { ...defaultAnswers(), ...overrides }
  const calls: Call[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const provider = {
    calls,
    answers,
    request(args: { method: string; params?: unknown }): Promise<unknown> {
      const index = calls.filter(call => call.method === args.method).length
      calls.push({ method: args.method, params: args.params })
      if (!(args.method in answers)) return Promise.reject(new Error(`Unexpected wallet method: ${args.method}`))
      const answer = answers[args.method]
      try {
        const value = typeof answer === "function" ? (answer as (params: unknown, index: number) => unknown)(args.params, index) : answer
        return value instanceof Promise ? value : Promise.resolve(value)
      } catch (error) {
        return Promise.reject(error)
      }
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach(listener => listener(...args))
    },
    listenerCount() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0)
    },
    methods() {
      return calls.map(call => call.method)
    },
  }
  return provider
}
export type FakeProvider = ReturnType<typeof fakeProvider>

export function reviewedDeployment(change: Partial<ManifestV2> = {}): ReviewedDeployment {
  const m = { ...manifest(), ...change }
  return evidence({ manifest: m, manifestDigest: digest(m) }) as ReviewedDeployment
}

export async function rejectsCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => assert.fail(`expected ${code}`), (value: unknown) => value)
  assert.ok(error instanceof StocksWalletError, `expected StocksWalletError ${code}, got ${String(error)}`)
  assert.equal(error.code, code)
  assert.equal(error.message, code, "no provider text is surfaced")
}

export function throwsCode(run: () => unknown, code: string) {
  let thrown: unknown = null
  try { run() } catch (error) { thrown = error }
  assert.ok(thrown instanceof StocksWalletError, `expected synchronous StocksWalletError ${code}, got ${String(thrown)}`)
  assert.equal(thrown.code, code)
}

/** Installs `globalThis.window` whose `ethereum` getter counts reads; restore with the returned function. */
export function windowEthereumSpy(value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  const spy = { reads: 0 }
  const target = {}
  Object.defineProperty(target, "ethereum", { configurable: true, get() { spy.reads++; return value } })
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: target })
  const restore = () => {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
  return { spy, restore }
}

/** Counts every property access or call on a Dynamic-shaped client. */
export function touchSpy<T extends object>(target: T) {
  const touched: PropertyKey[] = []
  const proxy = new Proxy(target, {
    get(object, key, receiver) { touched.push(key); return Reflect.get(object, key, receiver) },
    has(object, key) { touched.push(key); return Reflect.has(object, key) },
    apply(fn, self, args) { touched.push("()"); return Reflect.apply(fn as (...a: unknown[]) => unknown, self, args) },
  })
  return { proxy, touched }
}
