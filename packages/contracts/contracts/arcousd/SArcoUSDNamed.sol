// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {SArcoUSD} from "./SArcoUSD.sol";

/// @title SArcoUSDNamed
/// @notice sArcoUSD's ERC-4626 Savings logic (18 decimals, EIP-2612 permit, seed floor, per-second
///         reward vesting, pauses, blacklist via the asset) under a name and symbol chosen at
///         deployment, over any ArcoUSDNamed / ArcoUSD unit. First use: "ArcoGOLD" (symbol
///         "ArcoGOLD") over the gold ounce unit ArcoXAU. Spec: docs/specs/arcousd-v1.md §3.13.
/// @dev - Adds NO state and overrides nothing: storage layout and every function are SArcoUSD's
///        (test/arcogold.test.ts compares the compiler storage layouts).
///      - SArcoUSD.initialize hardcodes "sArcoUSD" and is not virtual, so this contract adds
///        initializeNamed (both `initializer`: whichever runs first is the only one). It does what
///        SArcoUSD.initialize does, in the same order, except the private `_checkpointAt = now`:
///        it stays 0 until the first checkpointed call (seed). That is not observable:
///        cumulativeAssetSeconds() = _assetSeconds + _checkpointAssets × (now − _checkpointAt), and
///        _assetSeconds and _checkpointAssets are both 0 until that first call, which sets all
///        three exactly as it does on sArcoUSD.
///      - The EIP-712 permit domain name is `name_` (version "1").
///      - Like sArcoUSD, deposits are closed until seed() mints MIN_SHARES (1 unit) to 0x…dEaD.
contract SArcoUSDNamed is SArcoUSD {
    error EmptyName();

    function initializeNamed(
        string calldata name_,
        string calldata symbol_,
        address asset_,
        address admin,
        uint64 vestingPeriod_
    ) external initializer {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyName();
        if (asset_ == address(0) || admin == address(0)) revert ZeroAddress();
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC4626_init(IERC20Upgradeable(asset_));
        __AccessControl_init();
        __FunctionPausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.PAUSER_ROLE, admin);
        _grantRole(REWARDER_ROLE, admin); // operator top-ups (a future distributor gets it too)
        _setVestingPeriod(vestingPeriod_);
        // Closed until seed() mints the floor shares in the same call that opens deposits.
        fnPaused[this.deposit.selector] = true;
        emit FunctionPaused(this.deposit.selector, admin);
    }
}
