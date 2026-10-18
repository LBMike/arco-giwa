// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {MidasAccessControl} from "../access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";

/// @title ArcoUSD
/// @notice ARCO's settlement dollar and GIWA DeFi dollar. 18 decimals, EIP-2612 permit.
///         Issued 1:1 against supported stablecoins by ArcoUSDReserve, which is the only
///         MINTER/BURNER. See docs/specs/arcousd-v1.md.
/// @dev - `burn` only burns the CALLER's balance: no role can erase someone else's tokens.
///        The Reserve pulls ArcoUSD to itself (transferFrom / permit) and burns its own balance.
///      - Transfers are never paused (pools and lending markets must keep working); pause only
///        stops mint/burn. Blacklisted addresses cannot send or receive.
///      - initialize() does NOT leave MINTER/BURNER with the admin; the deploy script grants
///        them to the Reserve only. TRUST: DEFAULT_ADMIN can still grant roles (and the ProxyAdmin
///        owner can upgrade), and the blacklist operator could freeze the Reserve — on mainnet all
///        three must be a multisig behind a timelock.
contract ArcoUSD is ERC20PermitUpgradeable, MidasAccessControl, FunctionPausable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __ERC20_init("ArcoUSD", "ArcoUSD");
        __ERC20Permit_init("ArcoUSD");
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
        // MidasAccessControl grants the admin every operational role; a stablecoin admin must
        // not be able to mint or burn directly, and the product-vault roles do not apply here.
        _revokeRole(MidasAccessControlRoles.MINTER_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.BURNER_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.GREENLIST_OPERATOR_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.DEPOSIT_VAULT_ADMIN_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.REDEMPTION_VAULT_ADMIN_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.FEED_ADMIN_ROLE, admin);
        _revokeRole(MidasAccessControlRoles.FAUCET_ADMIN_ROLE, admin);
    }

    function mint(
        address to,
        uint256 amount
    ) external onlyRole(MidasAccessControlRoles.MINTER_ROLE) whenFnNotPaused(this.mint.selector) {
        _mint(to, amount);
    }

    /// @notice Burns `amount` from the caller's own balance.
    function burn(
        uint256 amount
    ) external onlyRole(MidasAccessControlRoles.BURNER_ROLE) whenFnNotPaused(this.burn.selector) {
        _burn(_msgSender(), amount);
    }

    /// @dev A blacklisted spender cannot move someone else's tokens through an old allowance.
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _requireNotBlacklisted(_msgSender());
        return super.transferFrom(from, to, amount);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override {
        super._beforeTokenTransfer(from, to, amount);
        if (from != address(0)) _requireNotBlacklisted(from);
        if (to != address(0)) _requireNotBlacklisted(to);
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }

    uint256[50] private __gap;
}
