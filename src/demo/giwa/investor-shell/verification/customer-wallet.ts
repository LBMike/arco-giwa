const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export function validDynamicEnvironmentId(value: string): boolean {
  return UUID.test(value)
}

/** Only the configured Dynamic project may cross the connected preview boundary. */
export function customerWalletRequestAllowed(url: URL, method: string, environmentId: string): boolean {
  if (!validDynamicEnvironmentId(environmentId) || url.username || url.password || url.hash) return false
  if (url.origin === "https://app.dynamicauth.com") {
    return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
      && url.pathname.startsWith(`/api/v0/sdk/${environmentId}/`)
  }
  return method === "GET" && url.href === "https://dynamic-static-assets.com/wallet-book/v1/stable/wallet-book.json"
}
