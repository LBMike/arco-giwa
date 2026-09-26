// What the customer screens call a GIWA test asset. tUSDC, the testnet USDC, is shown as "USDC". Its on-chain symbol,
// the server's data, the operator pages and every check in code keep "tUSDC"; other test assets keep their own symbols.
export function assetLabel<T extends string | null>(symbol: T): T | "USDC" {
  return symbol === "tUSDC" ? "USDC" : symbol
}
