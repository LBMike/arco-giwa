// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

/// @notice The ArcoUSD surface the Reserve uses.
interface IArcoUSD is IERC20Upgradeable {
    function mint(address to, uint256 amount) external;

    function burn(uint256 amount) external;

    function isBlacklisted(address account) external view returns (bool);
}

/// @notice The subset of ArcoDepositVault an MMF strategy uses.
interface IArcoDepositVaultLike {
    function deposit(
        uint256 paymentAssets,
        uint256 minSharesOut,
        address recipient
    ) external returns (uint256 sharesOut);

    function paymentToken() external view returns (address);

    function productToken() external view returns (address);

    function productPriceFeed() external view returns (address);
}

/// @notice The subset of ArcoRedemptionVault an MMF strategy uses.
interface IArcoRedemptionVaultLike {
    function redeemInstant(
        uint256 sharesIn,
        uint256 minAssetsOut,
        address recipient
    ) external returns (uint256 assetsOut);

    function requestRedeem(
        uint256 sharesIn,
        uint256 minAssetsOut,
        address recipient
    ) external returns (uint256 requestId);

    function claimRedeem(uint256 requestId) external;

    function redemptionRequests(
        uint256 requestId
    )
        external
        view
        returns (
            address sender,
            address recipient,
            uint256 sharesIn,
            uint256 assetsOut,
            uint256 productRate,
            uint256 paymentRate,
            bool fulfilled,
            bool claimed
        );

    function paymentToken() external view returns (address);

    function productToken() external view returns (address);

    function productPriceFeed() external view returns (address);
}
