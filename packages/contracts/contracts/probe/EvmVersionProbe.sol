// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

contract EvmVersionProbe {
    uint256 public immutable deployedAt;

    constructor() {
        deployedAt = block.timestamp;
    }
}
