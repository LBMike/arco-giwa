// Pure helper for valuing a holding in USD. navUsd (payment-asset USD per share) now
// comes from the backend market endpoint (GET /api/v1/evm/market/:chainId); this just
// scales by human shares. The CoinGecko fetch + base-rate mapping moved server-side.
export function positionUsdValue({ shares, navUsd }: { shares: number; navUsd: number }): number {
  return shares * navUsd
}
