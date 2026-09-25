import { useQuery } from "@tanstack/react-query"
import { readHasRole, type AdminRoleName } from "./contracts"
import type { HexAddress } from "./types"

// On-chain operations are signed by the connected wallet itself; the contract checks its role. This
// read-only check lets a screen say why a wallet cannot sign instead of failing at simulation.
export type RoleCheck =
  | { readonly status: "unknown" }
  | { readonly status: "granted" }
  | { readonly status: "missing"; readonly message: string }

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Pure: an unreadable role (no wallet, no contract, RPC failure) never blocks; only a definite "no" does. */
export function roleCheckOf(role: AdminRoleName, contractLabel: string, wallet: string | null, granted: boolean | undefined): RoleCheck {
  if (!wallet || granted === undefined) return { status: "unknown" }
  if (granted) return { status: "granted" }
  return {
    status: "missing",
    message: `The connected wallet ${shortAddress(wallet)} does not hold ${role} on the ${contractLabel}, so this transaction would revert. Connect the operator wallet that holds ${role}.`,
  }
}

export function useOnchainRole(contract: HexAddress | null, role: AdminRoleName, contractLabel: string, wallet: HexAddress | null): RoleCheck {
  const query = useQuery({
    queryKey: ["giwa", "onchain-role", role, contract, wallet],
    queryFn: () => readHasRole(contract as HexAddress, role, wallet as HexAddress),
    enabled: Boolean(contract && wallet),
    staleTime: 60_000,
    retry: 0,
  })
  return roleCheckOf(role, contractLabel, contract ? wallet : null, query.data)
}
