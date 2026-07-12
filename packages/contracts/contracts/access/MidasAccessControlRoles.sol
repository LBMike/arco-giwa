// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library MidasAccessControlRoles {
    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant GREENLIST_OPERATOR_ROLE = keccak256("GREENLIST_OPERATOR_ROLE");
    bytes32 internal constant BLACKLIST_OPERATOR_ROLE = keccak256("BLACKLIST_OPERATOR_ROLE");
    bytes32 internal constant GREENLISTED_ROLE = keccak256("GREENLISTED_ROLE");
    bytes32 internal constant BLACKLISTED_ROLE = keccak256("BLACKLISTED_ROLE");
    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 internal constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 internal constant DEPOSIT_VAULT_ADMIN_ROLE = keccak256("DEPOSIT_VAULT_ADMIN_ROLE");
    bytes32 internal constant REDEMPTION_VAULT_ADMIN_ROLE =
        keccak256("REDEMPTION_VAULT_ADMIN_ROLE");
    bytes32 internal constant FEED_ADMIN_ROLE = keccak256("FEED_ADMIN_ROLE");
    bytes32 internal constant FAUCET_ADMIN_ROLE = keccak256("FAUCET_ADMIN_ROLE");
}
