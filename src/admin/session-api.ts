import { AdminApiError } from "../demo/giwa/api"
import { parseAdminSession, type AdminSessionInfo } from "./console-model"

export const ADMIN_SESSION_PATH = "/api/v1/admin/session"

/**
 * Who is signed in and what the server's directories grant (GET /api/v1/admin/session). Sends only the
 * in-memory SIWE session as a Bearer token; never cookies or a stored credential.
 */
export async function fetchAdminSession(
  apiBase: string,
  accessToken: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<AdminSessionInfo> {
  const response = await fetchImpl(`${apiBase}${ADMIN_SESSION_PATH}`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const message = typeof record.error === "string" ? record.error : `Request failed: ${response.status}`
    throw new AdminApiError(message, response.status, typeof record.code === "string" ? record.code : null)
  }
  return parseAdminSession(body)
}
