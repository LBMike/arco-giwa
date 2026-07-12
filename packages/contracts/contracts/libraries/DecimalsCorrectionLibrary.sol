// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library DecimalsCorrectionLibrary {
    uint256 internal constant BASE18 = 1e18;

    function convertToBase18(uint256 amount, uint8 decimals_) internal pure returns (uint256) {
        if (decimals_ == 18) return amount;
        if (decimals_ < 18) return amount * (10 ** (18 - decimals_));
        return amount / (10 ** (decimals_ - 18));
    }

    function convertFromBase18(uint256 amount, uint8 decimals_) internal pure returns (uint256) {
        if (decimals_ == 18) return amount;
        if (decimals_ < 18) return amount / (10 ** (18 - decimals_));
        return amount * (10 ** (decimals_ - 18));
    }
}
