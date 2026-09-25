// Direct order keys. A direct Buy or Sell is the wallet's own deposit or escrow; its key is how the server tells it from
// any other payment (server/src/stocks/direct.ts): the fixed 8-byte prefix "ARCODRCT", then 24 random bytes.

export const DIRECT_ORDER_PREFIX = "0x4152434f44524354"
const DIRECT_KEY = /^0x4152434f44524354[0-9a-f]{48}$/

export type DirectOrderKey = `0x${string}`

export function isDirectOrderKey(value: unknown): value is DirectOrderKey {
  return typeof value === "string" && DIRECT_KEY.test(value)
}

/** A new key: the prefix and 24 bytes from the platform's cryptographic random source. */
export function newDirectOrderKey(fill: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)): DirectOrderKey {
  const bytes = fill(new Uint8Array(24))
  if (!(bytes instanceof Uint8Array) || bytes.length !== 24) throw new Error("DIRECT_KEY_RANDOM_UNAVAILABLE")
  const key = `${DIRECT_ORDER_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  if (!isDirectOrderKey(key)) throw new Error("DIRECT_KEY_RANDOM_UNAVAILABLE")
  return key
}
