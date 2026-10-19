// Error text that may leave the server process (alert messages, the alert table, the console).
// RPC URLs carry provider keys in their path (INDEXER_RPC_URL), and viem's messages quote the full URL
// and request body on later lines. Keep the first line (viem's shortMessage), add the endpoint's host
// and HTTP status when known, and cut every URL left in the text down to its scheme and host.

export function safeErrorText(error: unknown): string {
  if (!(error instanceof Error)) return scrubUrls(String(error)).slice(0, 300)
  const viem = error as Error & { shortMessage?: unknown }
  const first = (typeof viem.shortMessage === "string" && viem.shortMessage ? viem.shortMessage : error.message.split("\n")[0]).trim()
  // Which endpoint and what it answered, without the URL's path (where the key lives).
  const host = hostOf(error)
  const status = httpStatus(error)
  const context = [host, status !== null && !first.includes(String(status)) ? `HTTP ${status}` : null].filter(Boolean)
  const text = context.length ? `${first.replace(/\.$/, "")} (${context.join(", ")})` : first
  return scrubUrls(text || error.name || "failed").slice(0, 300)
}

export function scrubUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, (match) => {
    try {
      const url = new URL(match)
      return `${url.protocol}//${url.host}/…`
    } catch {
      return "[url]"
    }
  })
}

function hostOf(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const url = (current as { url?: unknown }).url
    if (typeof url === "string") {
      try {
        return new URL(url).host
      } catch {
        return null
      }
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

function httpStatus(error: unknown): number | null {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const status = (current as { status?: unknown }).status
    if (typeof status === "number" && status >= 100 && status < 600) return status
    current = (current as { cause?: unknown }).cause
  }
  return null
}
