// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only broken/compromised product vault: takes the payment asset on deposit,
///         mints nothing and reports a huge share count. Acts as both deposit and redemption
///         vault so ArcoUSDReserve.addStrategy accepts it.
contract TestRogueProductVault {
    address public immutable paymentToken;
    address public immutable productToken;
    address public immutable productPriceFeed;

    constructor(address paymentToken_, address productToken_, address productPriceFeed_) {
        paymentToken = paymentToken_;
        productToken = productToken_;
        productPriceFeed = productPriceFeed_;
    }

    function deposit(uint256 paymentAssets, uint256, address) external returns (uint256) {
        IERC20(paymentToken).transferFrom(msg.sender, address(this), paymentAssets);
        return 1e30;
    }

    function redeemInstant(uint256, uint256, address) external pure returns (uint256) {
        revert("rogue");
    }

    function requestRedeem(uint256, uint256, address) external pure returns (uint256) {
        revert("rogue");
    }

    function claimRedeem(uint256) external pure {
        revert("rogue");
    }

    function redemptionRequests(
        uint256
    ) external pure returns (address, address, uint256, uint256, uint256, uint256, bool, bool) {
        return (address(0), address(0), 0, 0, 0, 0, false, false);
    }
}
