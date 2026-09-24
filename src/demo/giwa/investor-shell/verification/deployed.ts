// EDITABLE PREVIEW ONLY. Public GIWA API responses captured without changing their product fields.
// This is a dated copy, not a live feed or a wallet/transaction connection.
import snapshot from "./deployed-giwa.snapshot.json"
import type { PreviewReply } from "./fixtures"

export const DEPLOYED_SOURCE = snapshot.source
export const DEPLOYED_CAPTURED_AT = snapshot.capturedAt

/** Exact public responses. Missing history stays missing; no synthetic price/return fallback. */
export function deployedLegacyReply(method: string, path: string): PreviewReply | null {
  if (method.toUpperCase() !== "GET") return null
  const route = path.split("?")[0] ?? ""
  if (route === "/api/v1/evm/catalog/91342") return { status: 200, body: snapshot.catalog }
  if (route === "/api/v1/evm/market/91342") return { status: 200, body: snapshot.market }
  if (route === "/api/v1/evm/featured/91342") return { status: 200, body: snapshot.featured }
  const match = route.match(/^\/api\/v1\/evm\/market\/91342\/([^/]+)\/history$/)
  if (match) {
    let productId: string
    try { productId = decodeURIComponent(match[1]!) } catch { return { status: 400, body: { error: "Invalid productId" } } }
    const histories: Record<string, unknown> = snapshot.history
    return Object.prototype.hasOwnProperty.call(histories, productId)
      ? { status: 200, body: histories[productId] }
      : { status: 404, body: { error: "No captured history for this product" } }
  }
  return null
}
