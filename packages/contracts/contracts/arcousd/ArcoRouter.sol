// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {
    SafeERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {DecimalsCorrectionLibrary} from "../libraries/DecimalsCorrectionLibrary.sol";
import {ArcoUSDReserve} from "./ArcoUSDReserve.sol";
import {IArcoDepositVaultLike, IGreenlistLike} from "./IArcoUSDInterfaces.sol";

/// @title ArcoRouter
/// @notice Buys an Arco product with any Reserve stablecoin (or ArcoUSD) in one transaction:
///         pay asset → Reserve.deposit (ArcoUSD; swap fee for non-base stablecoins) →
///         Reserve.settleFor (the vault's payment token, from the Reserve buffer) → the product's
///         deposit vault, shares minted straight to `recipient`. Spec: docs/specs/arcousd-v1.md §3.12.
/// @dev Holds SETTLER_ROLE on the Reserve. Never keeps funds: every amount it pulls is passed on
///      within the call, and sub-unit ArcoUSD dust from the decimal conversion goes back to the
///      payer. Only admin-allowed deposit vaults paid in a base Reserve asset (no swap fee), so
///      the Router can never be pointed at an arbitrary contract nor used to take a fee-bearing
///      stablecoin out of the Reserve fee-free. A short buffer makes settleFor — and therefore
///      the whole buy — revert (the on-chain half of the buy gate).
contract ArcoRouter is AccessControlUpgradeable, FunctionPausable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using DecimalsCorrectionLibrary for uint256;

    uint16 private constant BPS = 10_000;

    ArcoUSDReserve public reserve;
    IERC20Upgradeable public arcoUSD;
    mapping(address depositVault => bool allowed) public allowedVault;

    event VaultAllowed(address indexed depositVault, address indexed paymentToken, bool allowed);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Bought(
        address indexed payer,
        address indexed recipient,
        address indexed depositVault,
        address payAsset,
        uint256 payAmount,
        uint256 arcoUSDSettled,
        uint256 paymentAmount,
        uint256 result, // shares minted, or the vault's deposit request id when `request`
        bool request
    );

    error NotReserveAsset();
    error NotBaseAsset();
    error NotGreenlisted();
    error InvalidRecipient();
    error VaultNotAllowed();
    error ZeroAddress();
    error ZeroAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address reserve_, address admin) external initializer {
        if (reserve_ == address(0) || admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __FunctionPausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.PAUSER_ROLE, admin);
        reserve = ArcoUSDReserve(reserve_);
        arcoUSD = IERC20Upgradeable(address(ArcoUSDReserve(reserve_).arcoUSD()));
    }

    // ─────────────────────────────── admin ───────────────────────────────

    /// @notice Allow (or stop) buys into a product deposit vault. Allowing requires the vault's
    ///         payment token to be a base Reserve asset: supported (settleFor can only pay those)
    ///         and without a swap fee (settleFor is fee-free, so a fee-bearing payment token would
    ///         let a buyer take that stablecoin out of the Reserve without its fee).
    function setVault(address depositVault, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (depositVault == address(0)) revert ZeroAddress();
        address paymentToken = IArcoDepositVaultLike(depositVault).paymentToken();
        if (allowed) _requireBaseAsset(paymentToken);
        allowedVault[depositVault] = allowed;
        emit VaultAllowed(depositVault, paymentToken, allowed);
    }

    /// @notice Recover tokens sent to the Router by mistake. The Router holds nothing between
    ///         transactions, so this can never touch a buyer's funds.
    function rescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        IERC20Upgradeable(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ──────────────────────────────── buy ────────────────────────────────

    /// @notice Buy `depositVault`'s product with `payAmount` of `payAsset` (a Reserve stablecoin
    ///         or ArcoUSD itself). `request` uses the vault's requestDeposit (shares minted to
    ///         `recipient` when the vault admin fulfils it) instead of an instant deposit.
    /// @return result Shares minted, or the vault's deposit request id when `request`.
    function buy(
        address payAsset,
        uint256 payAmount,
        address depositVault,
        uint256 minSharesOut,
        address recipient,
        bool request
    ) external nonReentrant whenFnNotPaused(this.buy.selector) returns (uint256 result) {
        if (!allowedVault[depositVault]) revert VaultNotAllowed();
        if (payAmount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert InvalidRecipient();
        address paymentToken = IArcoDepositVaultLike(depositVault).paymentToken();
        // Re-checked per buy: the asset's swap fee can be raised after the vault was allowed.
        _requireBaseAsset(paymentToken);
        // A request for a recipient the product token would refuse could never be fulfilled, and
        // the vault records the Router as its sender, so check before taking any funds.
        if (request) _requireGreenlistedIfEnforced(IArcoDepositVaultLike(depositVault).productToken(), recipient);

        uint256 arcoUSDIn = _pullAsArcoUSD(payAsset, payAmount);
        (uint256 paymentAmount, uint256 arcoUSDSettled) = _settle(paymentToken, arcoUSDIn);

        IERC20Upgradeable(paymentToken).forceApprove(depositVault, paymentAmount);
        result = request
            ? IArcoDepositVaultLike(depositVault).requestDeposit(paymentAmount, minSharesOut, recipient)
            : IArcoDepositVaultLike(depositVault).deposit(paymentAmount, minSharesOut, recipient);
        IERC20Upgradeable(paymentToken).forceApprove(depositVault, 0);

        if (arcoUSDIn > arcoUSDSettled) arcoUSD.safeTransfer(_msgSender(), arcoUSDIn - arcoUSDSettled);
        emit Bought(
            _msgSender(),
            recipient,
            depositVault,
            payAsset,
            payAmount,
            arcoUSDSettled,
            paymentAmount,
            result,
            request
        );
    }

    /// @notice What `buy` would do now: ArcoUSD after the deposit swap fee, the payment-token
    ///         amount settled into the vault, and the vault's share quote for it. Does not check
    ///         liquidity, caps or pauses (the buy gate and the transaction itself do).
    function quoteBuy(
        address payAsset,
        uint256 payAmount,
        address depositVault
    ) external view returns (uint256 arcoUSDIn, uint256 paymentAmount, uint256 sharesOut) {
        if (payAsset == address(arcoUSD)) {
            arcoUSDIn = payAmount;
        } else {
            ArcoUSDReserve.AssetConfig memory pay = reserve.getAssetConfig(payAsset);
            if (!pay.supported) revert NotReserveAsset();
            uint256 gross = payAmount.convertToBase18(pay.decimals);
            arcoUSDIn = gross - (gross * pay.swapFeeBps) / BPS;
        }
        address paymentToken = IArcoDepositVaultLike(depositVault).paymentToken();
        paymentAmount = arcoUSDIn.convertFromBase18(reserve.getAssetConfig(paymentToken).decimals);
        sharesOut = IArcoDepositVaultLike(depositVault).quoteDeposit(paymentAmount);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Pull the payer's funds and turn them into ArcoUSD held by the Router. Amounts are
    ///      measured by balance, never trusted from return values.
    function _pullAsArcoUSD(address payAsset, uint256 payAmount) internal returns (uint256 arcoUSDIn) {
        uint256 arcoBefore = arcoUSD.balanceOf(address(this));
        if (payAsset == address(arcoUSD)) {
            arcoUSD.safeTransferFrom(_msgSender(), address(this), payAmount);
        } else {
            IERC20Upgradeable token = IERC20Upgradeable(payAsset);
            uint256 before = token.balanceOf(address(this));
            token.safeTransferFrom(_msgSender(), address(this), payAmount);
            uint256 received = token.balanceOf(address(this)) - before;
            token.forceApprove(address(reserve), received);
            reserve.deposit(payAsset, received, address(this));
        }
        arcoUSDIn = arcoUSD.balanceOf(address(this)) - arcoBefore;
        if (arcoUSDIn == 0) revert ZeroAmount();
    }

    /// @dev Burn the ArcoUSD for the vault's payment token through the Reserve. Returns the token
    ///      received and the ArcoUSD actually used (sub-unit dust is left for the payer).
    function _settle(
        address paymentToken,
        uint256 arcoUSDIn
    ) internal returns (uint256 paymentAmount, uint256 arcoUSDSettled) {
        IERC20Upgradeable token = IERC20Upgradeable(paymentToken);
        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 arcoBefore = arcoUSD.balanceOf(address(this));
        arcoUSD.forceApprove(address(reserve), arcoUSDIn);
        reserve.settleFor(paymentToken, arcoUSDIn, address(this));
        arcoUSD.forceApprove(address(reserve), 0);
        paymentAmount = token.balanceOf(address(this)) - tokenBefore;
        arcoUSDSettled = arcoBefore - arcoUSD.balanceOf(address(this));
        if (paymentAmount == 0) revert ZeroAmount();
    }

    /// @dev A V1 product token has no greenlistEnforced() and always enforces its greenlist.
    function _requireGreenlistedIfEnforced(address productToken, address recipient) internal view {
        bool enforced = true;
        try IGreenlistLike(productToken).greenlistEnforced() returns (bool value) {
            enforced = value;
        } catch {}
        if (enforced && !IGreenlistLike(productToken).isGreenlisted(recipient)) revert NotGreenlisted();
    }

    function _requireBaseAsset(address asset) internal view {
        ArcoUSDReserve.AssetConfig memory config = reserve.getAssetConfig(asset);
        if (!config.supported) revert NotReserveAsset();
        if (config.swapFeeBps != 0) revert NotBaseAsset();
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }

    // 3 slots used above + 47 = 50.
    uint256[47] private __gap;
}
