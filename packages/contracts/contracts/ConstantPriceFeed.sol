// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IDataFeed} from "./interfaces/IDataFeed.sol";

/// @title ConstantPriceFeed
/// @notice Immutable, non-upgradeable fixed-rate IDataFeed. Used as a vault's paymentPriceFeed
///         when the product feed is already denominated in the payment asset (NAV in USDC,
///         NAV in ETH, ...): one payment unit is worth exactly 1.0 of itself, so the payment
///         rate is a constant 1e18 and never goes stale.
/// @dev No admin, no setter, no staleness window: nothing to rotate or misconfigure. Replacing
///      the rate means deploying a new feed and pointing the vault at it (setPaymentPriceFeed).
contract ConstantPriceFeed is IDataFeed {
    uint256 public immutable answerBase18;

    constructor(uint256 answerBase18_) {
        require(answerBase18_ > 0, "CPF: answer zero");
        answerBase18 = answerBase18_;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function getDataInBase18() external view override returns (uint256 answer) {
        return answerBase18;
    }
}
