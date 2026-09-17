// The one API base rule for the Stocks clients. Pure: no I/O, no environment reads.
//
// A base is an absolute http(s) URL without credentials whose normalized href holds no "?" or "#".
// An empty "?" or "#" leaves url.search/url.hash empty but would still move every API path into a
// query or fragment, so the href itself is checked. Delimiters are refused, never stripped.

function accepted(url: URL): string | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password) return null
  if (url.href.includes("?") || url.href.includes("#")) return null
  return url.href.replace(/\/+$/, "")
}

function parse(value: string, base?: string): URL | null {
  try {
    return new URL(value, base)
  } catch {
    return null
  }
}

/** Absolute base only. Returns the href without trailing slashes, or null. Path prefix and percent-encoding are kept. */
export function normalizeApiBase(value: unknown): string | null {
  if (typeof value !== "string") return null
  const url = parse(value)
  return url === null ? null : accepted(url)
}

/**
 * For the host session and the /stocks page only: "" means the frontend origin and a relative value is
 * resolved against it, then the same rule applies. The frontend origin must itself be a plain http(s) origin.
 */
export function resolveApiBase(value: unknown, frontendOrigin: string): string | null {
  if (typeof value !== "string" || typeof frontendOrigin !== "string") return null
  const origin = parse(frontendOrigin)
  if (origin === null || accepted(origin) === null || origin.pathname !== "/") return null
  const url = parse(value === "" ? origin.origin : value, origin.origin)
  return url === null ? null : accepted(url)
}
