# License Inventory

This package is isolated from the root npm/Vite app. It is published and handled
as the contracts boundary only; app/backend/frontend code must consume ABIs or
RPC results, not Solidity source.

Midas repository inspected: `midas-apps/contracts` main commit
`631d0c9748b6e01b4edfa45b9409d4d2dcbcd65a` (2026-06-24).

## Ported Or Derived From Midas Core

| Midas source file | Observed SPDX | Local treatment |
| --- | --- | --- |
| `contracts/mToken.sol` | MIT | Semantics incorporated in `ProductToken.sol` |
| `contracts/mTokenPermissioned.sol` | MIT | Semantics incorporated in `ProductToken.sol` |
| `contracts/access/MidasAccessControl.sol` | MIT | Ported/adapted as `MidasAccessControl.sol` |
| `contracts/access/MidasAccessControlRoles.sol` | MIT | Ported/adapted as `MidasAccessControlRoles.sol` |
| `contracts/access/Blacklistable.sol` | MIT | Semantics incorporated |
| `contracts/access/Greenlistable.sol` | MIT | Semantics incorporated |
| `contracts/access/WithMidasAccessControl.sol` | MIT | Semantics incorporated |
| `contracts/abstract/MidasInitializable.sol` | MIT | Upgradeable initializer pattern retained |
| `contracts/abstract/ManageableVault.sol` | MIT | Single-payment subset incorporated in vaults |
| `contracts/abstract/WithSanctionsList.sol` | MIT | Sanctions hook omitted for this test harness |
| `contracts/DepositVault.sol` | MIT | Single-payment subset incorporated in `ArcoDepositVault.sol` |
| `contracts/RedemptionVault.sol` | MIT | Single-payment subset incorporated in `ArcoRedemptionVault.sol` |
| `contracts/feeds/DataFeed.sol` | MIT | Semantics incorporated in `ProductPriceFeed.sol` |
| `contracts/feeds/CustomAggregatorV3CompatibleFeed.sol` | MIT | Semantics incorporated in `ProductPriceFeed.sol` |
| `contracts/libraries/DecimalsCorrectionLibrary.sol` | MIT | Ported/adapted as `DecimalsCorrectionLibrary.sol` |
| Required interfaces | MIT | Recreated locally for this package |

## Audit-Divergence Exception

`contracts/access/Pausable.sol` on inspected Midas `main` is
`SPDX-License-Identifier: UNLICENSED`. It is not copied, ported, or republished.
The local pause layer is a clean OpenZeppelin `PausableUpgradeable` integration
with equivalent global pause and function-level pause controls:
`fnPaused`, `pauseFn(bytes4)`, `unpauseFn(bytes4)`, and `whenFnNotPaused`.

This is the only intentional contract-layer divergence from the inspected Midas
core. It must be revisited if a properly licensed Midas commit/tag is selected.

