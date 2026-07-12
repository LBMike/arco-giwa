// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {MidasAccessControl} from "./access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "./access/MidasAccessControlRoles.sol";

contract TestAssetToken is ERC20Upgradeable, MidasAccessControl {
    uint8 private _customDecimals;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address admin
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __MidasAccessControl_init(admin);
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(
        address to,
        uint256 amount
    ) external onlyRole(MidasAccessControlRoles.MINTER_ROLE) {
        _mint(to, amount);
    }
}
