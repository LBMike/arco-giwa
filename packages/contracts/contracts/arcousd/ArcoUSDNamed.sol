// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {ArcoUSD} from "./ArcoUSD.sol";

/// @title ArcoUSDNamed
/// @notice ArcoUSD's logic (18 decimals, EIP-2612 permit, Reserve-only mint/burn, blacklist,
///         function pauses) under a name and symbol chosen at deployment. First use: the ArcoGOLD
///         stack's internal "gold ounce unit" (name "Arco Gold Ounce", symbol "ArcoXAU"), issued
///         1:1 per troy ounce by its own ArcoUSDReserve proxy. Spec: docs/specs/arcousd-v1.md.
/// @dev - Adds NO state and overrides nothing: storage layout and every function are ArcoUSD's
///        (test/arcogold.test.ts compares the compiler storage layouts and the role set).
///      - ArcoUSD.initialize hardcodes "ArcoUSD" and is not virtual, so this contract adds
///        initializeNamed. Both carry `initializer`, so whichever runs first is the only one that
///        ever runs; deploy with initializer "initializeNamed" (the proxy constructor calls it
///        atomically) and check name()/symbol() after deployment.
///      - The EIP-712 permit domain name is `name_` (version "1").
contract ArcoUSDNamed is ArcoUSD {
    error EmptyName();

    function initializeNamed(
        string calldata name_,
        string calldata symbol_,
        address admin
    ) external initializer {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyName();
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
        // Same role set as ArcoUSD.initialize: the admin keeps admin, pauser and blacklist operator
        // only; mint/burn go to the Reserve through the deploy script.
        _revokeRole(MidasAccessControlRoles.MINTER_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.BURNER_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.GREENLIST_OPERATOR_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.DEPOSIT_VAULT_ADMIN_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.REDEMPTION_VAULT_ADMIN_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.FEED_ADMIN_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.FAUCET_ADMIN_ROLE, admin);
    }
}
