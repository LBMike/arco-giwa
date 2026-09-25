// Offline tests only. No chain, wallet, token, signing or deployment action.
import type { Hex } from "viem"
import { manifest, orderRow, START, WALLET } from "../stocks-wallet-http/test-support"
import { digest } from "./planner"
import { PLATFORM_TUSDC, type ExecutionContext, type ManifestV3, type ReviewedDeployment, type Side } from "./types"

export function tusdcFixture(side: Side = "BUY") {
  const legacy = manifest()
  const { cashSymbol: _symbol, schemaVersion: _version, nonUpgradeable: _immutable, ...common } = legacy
  const codeHashes = { ...legacy.codeHashes }
  delete codeHashes[legacy.cashToken]
  codeHashes[PLATFORM_TUSDC] = `0x${"b".repeat(64)}`
  const m: ManifestV3 = { ...common, schemaVersion: 3, cashToken: PLATFORM_TUSDC, cashSymbol: "tUSDC", nonUpgradeable: false, stockContractsNonUpgradeable: true, codeHashes,
    cashIdentity: { kind: "ERC1967", implementation: "0x9999999999999999999999999999999999999999", implementationCodeHash: `0x${"c".repeat(64)}` as Hex, proxyAdmin: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", proxyAdminCodeHash: `0x${"d".repeat(64)}` as Hex } }
  const deployment: ReviewedDeployment = { status: "VERIFIED", evidenceId: "review-v3", manifestDigest: digest(m), manifest: m, verifiedAt: START - 1000, validUntil: START + 14000 }
  const context: ExecutionContext = { session: { id: "session-v3", walletAddress: WALLET, chainId: 91342, accessToken: "offline-token", createdAt: START - 1000, expiresAt: START + 900000 }, walletAddress: WALLET, chainId: 91342, walletEpoch: "wallet-1", apiBase: "https://stocks.test", deployment }
  const selection = { side, order: orderRow(side, { deploymentDigest: deployment.manifestDigest }) }
  return { m, deployment, context, selection, now: START, wallet: WALLET }
}
