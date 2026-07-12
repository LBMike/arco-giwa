// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {MidasAccessControlRoles} from "./MidasAccessControlRoles.sol";

abstract contract MidasAccessControl is Initializable, AccessControlUpgradeable {
    function __MidasAccessControl_init(address admin) internal onlyInitializing {
        require(admin != address(0), "MAC: admin zero");
        __AccessControl_init();
        _grantRole(MidasAccessControlRoles.DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.GREENLIST_OPERATOR_ROLE, admin);
        _grantRole(MidasAccessControlRoles.BLACKLIST_OPERATOR_ROLE, admin);
        _grantRole(MidasAccessControlRoles.MINTER_ROLE, admin);
        _grantRole(MidasAccessControlRoles.BURNER_ROLE, admin);
        _grantRole(MidasAccessControlRoles.PAUSER_ROLE, admin);
        _grantRole(MidasAccessControlRoles.DEPOSIT_VAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.REDEMPTION_VAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.FEED_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.FAUCET_ADMIN_ROLE, admin);
    }

    modifier onlyGreenlistOperator() {
        _checkRole(MidasAccessControlRoles.GREENLIST_OPERATOR_ROLE, _msgSender());
        _;
    }

    modifier onlyBlacklistOperator() {
        _checkRole(MidasAccessControlRoles.BLACKLIST_OPERATOR_ROLE, _msgSender());
        _;
    }

    function greenlist(address account) external onlyGreenlistOperator {
        _grantRole(MidasAccessControlRoles.GREENLISTED_ROLE, account);
    }

    function unGreenlist(address account) external onlyGreenlistOperator {
        _revokeRole(MidasAccessControlRoles.GREENLISTED_ROLE, account);
    }

    function blacklist(address account) external onlyBlacklistOperator {
        _grantRole(MidasAccessControlRoles.BLACKLISTED_ROLE, account);
    }

    function unBlacklist(address account) external onlyBlacklistOperator {
        _revokeRole(MidasAccessControlRoles.BLACKLISTED_ROLE, account);
    }

    function isGreenlisted(address account) public view returns (bool) {
        return hasRole(MidasAccessControlRoles.GREENLISTED_ROLE, account);
    }

    function isBlacklisted(address account) public view returns (bool) {
        return hasRole(MidasAccessControlRoles.BLACKLISTED_ROLE, account);
    }

    function _requireGreenlisted(address account) internal view {
        require(isGreenlisted(account), "MAC: not greenlisted");
    }

    function _requireNotBlacklisted(address account) internal view {
        require(!isBlacklisted(account), "MAC: blacklisted");
    }

    uint256[50] private __gap;
}
