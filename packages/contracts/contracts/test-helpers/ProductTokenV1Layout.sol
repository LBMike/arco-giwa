// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {MidasAccessControl} from "../access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";

contract ProductTokenV1Layout is ERC20Upgradeable, MidasAccessControl, FunctionPausable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address admin
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
    }

    function mint(
        address to,
        uint256 amount
    ) external onlyRole(MidasAccessControlRoles.MINTER_ROLE) whenFnNotPaused(this.mint.selector) {
        _requireNotBlacklisted(to);
        _requireGreenlisted(to);
        _mint(to, amount);
    }

    function burn(
        address from,
        uint256 amount
    ) external onlyRole(MidasAccessControlRoles.BURNER_ROLE) whenFnNotPaused(this.burn.selector) {
        _requireNotBlacklisted(from);
        _burn(from, amount);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        super._beforeTokenTransfer(from, to, amount);

        if (from != address(0)) {
            _requireNotBlacklisted(from);
            _requireGreenlisted(from);
        }
        if (to != address(0)) {
            _requireNotBlacklisted(to);
            _requireGreenlisted(to);
        }
        require(!paused(), "PT: paused");
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }
}
