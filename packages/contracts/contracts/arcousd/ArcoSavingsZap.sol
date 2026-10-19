// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {
    IERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20PermitUpgradeable.sol";
import {
    SafeERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {DecimalsCorrectionLibrary} from "../libraries/DecimalsCorrectionLibrary.sol";
import {ArcoUSDReserve} from "./ArcoUSDReserve.sol";
import {IArcoUSD} from "./IArcoUSDInterfaces.sol";
import {SArcoUSD} from "./SArcoUSD.sol";

/// @title ArcoSavingsZap
/// @notice Savings in and out with a stablecoin in one transaction:
///         deposit: stablecoin → Reserve.deposit (swap fee for non-base stablecoins) → sArcoUSD;
///         redeem:  sArcoUSD → ArcoUSD → Reserve.redeemInstantOnly → stablecoin to the receiver.
///         ArcoUSD itself skips the Reserve. Spec: docs/specs/arcousd-v1.md §3.15.
/// @dev No roles and no funds: every amount is measured by balance and passed on within the call;
///      sub-unit ArcoUSD dust from the decimal conversion goes back to the caller. Redemptions are
///      Instant only — a queued Reserve request would be owned by the Zap and nobody could cancel
///      it — so a short buffer reverts the whole call (the app then offers ArcoUSD + a Reserve
///      redemption). Addresses live in storage, not immutables (bytecode check on resume).
/// @dev ArcoUSD's pause switches (FunctionPausable), read by quoteRedeem.
interface IFunctionPausableLike {
    function paused() external view returns (bool);

    function fnPaused(bytes4 selector) external view returns (bool);
}

contract ArcoSavingsZap is ReentrancyGuard {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using DecimalsCorrectionLibrary for uint256;

    uint256 private constant BPS = 10_000;

    ArcoUSDReserve public reserve;
    SArcoUSD public vault;
    IERC20Upgradeable public arcoUSD;

    event ZapDeposit(
        address indexed caller,
        address indexed receiver,
        address indexed asset,
        uint256 amount,
        uint256 arcoUSDIn,
        uint256 shares
    );
    event ZapRedeem(
        address indexed caller,
        address indexed receiver,
        address indexed asset,
        uint256 shares,
        uint256 arcoUSDOut,
        uint256 assetOut
    );

    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient();
    error InvalidParams();
    error NotReserveAsset();
    error MinOut();

    constructor(address reserve_, address vault_) {
        if (reserve_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        reserve = ArcoUSDReserve(reserve_);
        vault = SArcoUSD(vault_);
        arcoUSD = IERC20Upgradeable(address(ArcoUSDReserve(reserve_).arcoUSD()));
        if (SArcoUSD(vault_).asset() != address(arcoUSD)) revert InvalidParams();
    }

    /// @notice Deposit `amount` of `asset` (a Reserve stablecoin, or ArcoUSD) into Savings;
    ///         sArcoUSD goes to `receiver`.
    function deposit(
        address asset,
        uint256 amount,
        uint256 minShares,
        address receiver
    ) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        _checkReceiver(receiver);
        uint256 arcoUSDIn = _pullAsArcoUSD(asset, amount);
        arcoUSD.forceApprove(address(vault), arcoUSDIn);
        shares = vault.deposit(arcoUSDIn, receiver);
        arcoUSD.forceApprove(address(vault), 0);
        if (shares < minShares) revert MinOut();
        emit ZapDeposit(_msgSender(), receiver, asset, amount, arcoUSDIn, shares);
    }

    /// @notice Redeem the caller's `shares` and pay `asset` to `receiver` (Instant only; needs a
    ///         share allowance for the Zap).
    function redeem(
        uint256 shares,
        address asset,
        uint256 minAssetOut,
        address receiver
    ) external nonReentrant returns (uint256 assetOut) {
        return _redeem(shares, asset, minAssetOut, receiver);
    }

    /// @notice redeem with an sArcoUSD permit for the share allowance. A failed permit is ignored
    ///         when the allowance already covers it (front-run permit griefing).
    function redeemWithPermit(
        uint256 shares,
        address asset,
        uint256 minAssetOut,
        address receiver,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 assetOut) {
        try IERC20PermitUpgradeable(address(vault)).permit(_msgSender(), address(this), shares, deadline, v, r, s) {} catch {}
        return _redeem(shares, asset, minAssetOut, receiver);
    }

    /// @notice ArcoUSD after the deposit swap fee, and the shares it would buy now (fees only).
    function quoteDeposit(address asset, uint256 amount) external view returns (uint256 arcoUSDIn, uint256 shares) {
        if (asset == address(arcoUSD)) {
            arcoUSDIn = amount;
        } else {
            ArcoUSDReserve.AssetConfig memory config = reserve.getAssetConfig(asset);
            if (!config.supported) revert NotReserveAsset();
            uint256 gross = amount.convertToBase18(config.decimals);
            arcoUSDIn = gross - (gross * config.swapFeeBps) / BPS;
        }
        shares = vault.previewDeposit(arcoUSDIn);
    }

    /// @notice ArcoUSD the shares redeem for, `asset` paid after the Instant and swap fees, and
    ///         whether redeem() would go through now: vault withdrawals open, and for a stablecoin
    ///         its redemptions enabled, the Reserve's redeem switches open, ArcoUSD burns not paused
    ///         (the Reserve burns what it pays out) and enough free buffer. The receiver's blacklist
    ///         status is not an input.
    ///         (A deposit quote is fees only: like ArcoRouter.quoteBuy it does not check pauses or caps.)
    function quoteRedeem(
        uint256 shares,
        address asset
    ) external view returns (uint256 arcoUSDOut, uint256 assetOut, bool instant) {
        arcoUSDOut = vault.previewRedeem(shares);
        bool vaultOpen = !vault.paused() && !vault.fnPaused(SArcoUSD.withdraw.selector);
        if (asset == address(arcoUSD)) return (arcoUSDOut, arcoUSDOut, vaultOpen);
        ArcoUSDReserve.AssetConfig memory config = reserve.getAssetConfig(asset);
        if (!config.supported) revert NotReserveAsset();
        uint256 gross = arcoUSDOut.convertFromBase18(config.decimals);
        assetOut = gross - (gross * (uint256(config.instantFeeBps) + config.swapFeeBps)) / BPS;
        instant =
            vaultOpen &&
            config.redeemEnabled &&
            !reserve.paused() &&
            !reserve.fnPaused(ArcoUSDReserve.redeem.selector) &&
            !reserve.fnPaused(ArcoUSDReserve.redeemInstantOnly.selector) &&
            !IFunctionPausableLike(address(arcoUSD)).paused() &&
            !IFunctionPausableLike(address(arcoUSD)).fnPaused(IArcoUSD.burn.selector) &&
            gross > 0 &&
            reserve.availableLiquidity(asset) >= gross;
    }

    function _redeem(
        uint256 shares,
        address asset,
        uint256 minAssetOut,
        address receiver
    ) internal returns (uint256 assetOut) {
        if (shares == 0) revert ZeroAmount();
        _checkReceiver(receiver);
        address owner = _msgSender();
        if (asset == address(arcoUSD)) {
            assetOut = vault.redeem(shares, receiver, owner);
            if (assetOut < minAssetOut) revert MinOut();
            emit ZapRedeem(owner, receiver, asset, shares, assetOut, assetOut);
            return assetOut;
        }
        uint256 before = arcoUSD.balanceOf(address(this));
        vault.redeem(shares, address(this), owner);
        uint256 arcoUSDOut = arcoUSD.balanceOf(address(this)) - before;
        arcoUSD.forceApprove(address(reserve), arcoUSDOut);
        assetOut = reserve.redeemInstantOnly(asset, arcoUSDOut, receiver, minAssetOut);
        arcoUSD.forceApprove(address(reserve), 0);
        uint256 dust = arcoUSD.balanceOf(address(this)) - before;
        if (dust > 0) arcoUSD.safeTransfer(owner, dust);
        emit ZapRedeem(owner, receiver, asset, shares, arcoUSDOut - dust, assetOut);
    }

    /// @dev Pull the caller's funds and turn them into ArcoUSD held by the Zap (measured by balance).
    function _pullAsArcoUSD(address asset, uint256 amount) internal returns (uint256 arcoUSDIn) {
        uint256 arcoBefore = arcoUSD.balanceOf(address(this));
        if (asset == address(arcoUSD)) {
            arcoUSD.safeTransferFrom(_msgSender(), address(this), amount);
        } else {
            IERC20Upgradeable token = IERC20Upgradeable(asset);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(_msgSender(), address(this), amount);
            uint256 received = token.balanceOf(address(this)) - before;
            token.forceApprove(address(reserve), received);
            reserve.deposit(asset, received, address(this));
            token.forceApprove(address(reserve), 0);
        }
        arcoUSDIn = arcoUSD.balanceOf(address(this)) - arcoBefore;
        if (arcoUSDIn == 0) revert ZeroAmount();
    }

    function _checkReceiver(address receiver) internal view {
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert InvalidRecipient();
    }

    function _msgSender() internal view returns (address) {
        return msg.sender;
    }
}
