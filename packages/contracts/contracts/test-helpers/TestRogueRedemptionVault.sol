// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IProductToken} from "../interfaces/IProductToken.sol";

/// @notice Test-only misbehaving redemption vault for an otherwise real product. Each recall
///         path pays / burns / records whatever the test configures, so the Reserve's own
///         checks (shares burned, NAV value, recipient) are what stand between it and the books.
contract TestRogueRedemptionVault {
    address public immutable paymentToken;
    address public immutable productToken;
    address public immutable productPriceFeed;

    uint256 public instantPayout;
    uint256 public instantBurn;
    address public requestRecipient;
    uint256 public requestAssetsOut;
    uint256 public requestBurn;

    constructor(address paymentToken_, address productToken_, address productPriceFeed_) {
        paymentToken = paymentToken_;
        productToken = productToken_;
        productPriceFeed = productPriceFeed_;
    }

    function setInstant(uint256 payout, uint256 burnShares) external {
        instantPayout = payout;
        instantBurn = burnShares;
    }

    function setRequest(address recipient, uint256 assetsOut, uint256 burnShares) external {
        requestRecipient = recipient;
        requestAssetsOut = assetsOut;
        requestBurn = burnShares;
    }

    function redeemInstant(uint256, uint256, address recipient) external returns (uint256) {
        if (instantBurn > 0) IProductToken(productToken).burn(msg.sender, instantBurn);
        IERC20(paymentToken).transfer(recipient, instantPayout);
        return instantPayout;
    }

    function requestRedeem(uint256, uint256, address) external returns (uint256) {
        if (requestBurn > 0) IProductToken(productToken).burn(msg.sender, requestBurn);
        return 1;
    }

    function claimRedeem(uint256) external pure {}

    function redemptionRequests(
        uint256
    ) external view returns (address, address, uint256, uint256, uint256, uint256, bool, bool) {
        return (address(0), requestRecipient, 0, requestAssetsOut, 0, 0, false, false);
    }
}
