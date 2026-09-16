// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

abstract contract StocksGuards {
    uint256 public constant REQUIRED_CHAIN_ID = 91342;

    constructor() {
        require(block.chainid == REQUIRED_CHAIN_ID, "STOCKS_WRONG_CHAIN");
    }

    modifier onGiwaTestnet() {
        require(block.chainid == REQUIRED_CHAIN_ID, "STOCKS_WRONG_CHAIN");
        _;
    }

    function _address(address value) internal pure {
        require(value != address(0), "STOCKS_ZERO_ADDRESS");
    }

    function _positive(uint256 value) internal pure {
        require(value > 0, "STOCKS_ZERO_AMOUNT");
    }
}

abstract contract StocksOperations is StocksGuards {
    mapping(bytes32 => bytes32) public operationPayloads;

    // Record before external calls. A failed call reverts this record atomically.
    function _recordOperation(bytes32 operationId, bytes32 payload) internal returns (bool) {
        require(operationId != bytes32(0), "STOCKS_ZERO_OPERATION");
        bytes32 prior = operationPayloads[operationId];
        if (prior != bytes32(0)) {
            require(prior == payload, "STOCKS_OPERATION_CONFLICT");
            return false;
        }
        operationPayloads[operationId] = payload;
        return true;
    }
}
