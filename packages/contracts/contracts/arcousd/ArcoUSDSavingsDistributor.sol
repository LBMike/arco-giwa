// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {
    SafeERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {ArcoUSDReserve} from "./ArcoUSDReserve.sol";
import {ArcoUSDReserveLens} from "./ArcoUSDReserveLens.sol";
import {IArcoUSD} from "./IArcoUSDInterfaces.sol";
import {SArcoUSD} from "./SArcoUSD.sol";

/// @title ArcoUSDSavingsDistributor
/// @notice Moves Reserve surplus (backing − liabilities − a safety margin) into sArcoUSD as yield:
///         mints that much ArcoUSD and adds it to the vault, which releases it per second over its
///         vesting period. The only path from the Reserve's MMF and fee income to savers (the
///         Reserve itself is at the 24 KB limit). Spec: docs/specs/arcousd-v1.md §3.14.
/// @dev Holds ArcoUSD MINTER_ROLE and sArcoUSD REWARDER_ROLE. A distribution is the smallest of:
///      surplus above the margin (only with every strategy NAV readable and the Reserve not
///      paused); an APR cap on the vault's TIME-WEIGHTED average assets since the last
///      distribution, accrued for at most one vesting period (a deposit made just before the call
///      adds nothing, and a backlog is paid out at most one vesting period at a time, so nobody can
///      snipe several days of yield by holding for one); and the room left under the Reserve's
///      mintCap. It can never mint past the backing.
///      Addresses live in storage, not immutables, so the deploy script can match the runtime
///      bytecode against the artifact when it settles an interrupted deploy.
contract ArcoUSDSavingsDistributor is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    uint256 private constant BPS = 10_000;
    uint256 private constant YEAR = 365 days;
    uint64 public constant MIN_INTERVAL = 1 hours;
    uint64 public constant MAX_INTERVAL = 30 days;
    uint16 public constant MAX_APR_BPS = 5_000;
    uint16 public constant MAX_MARGIN_BPS = 1_000;

    ArcoUSDReserve public reserve;
    ArcoUSDReserveLens public lens;
    SArcoUSD public vault;
    IArcoUSD public arcoUSD;
    uint64 public minInterval;
    uint16 public maxAprBps;
    uint16 public reserveMarginBps;
    uint64 public lastDistribution;
    /// @notice vault.cumulativeAssetSeconds() at the last distribution.
    uint256 public lastAssetSeconds;

    event Distributed(
        address indexed caller,
        uint256 amount,
        uint256 backing,
        uint256 liabilities,
        uint256 surplus,
        uint256 rateCap
    );
    event ParamsUpdated(uint64 minInterval, uint16 maxAprBps, uint16 reserveMarginBps);

    error TooSoon();
    error NoDepositors();
    error NavUnavailable();
    error NothingToDistribute();
    error InvalidParams();
    error ZeroAddress();
    error ReservePaused();

    constructor(
        address reserve_,
        address lens_,
        address vault_,
        address admin,
        uint64 minInterval_,
        uint16 maxAprBps_,
        uint16 reserveMarginBps_
    ) {
        if (reserve_ == address(0) || lens_ == address(0) || vault_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        reserve = ArcoUSDReserve(reserve_);
        lens = ArcoUSDReserveLens(lens_);
        vault = SArcoUSD(vault_);
        arcoUSD = IArcoUSD(address(ArcoUSDReserve(reserve_).arcoUSD()));
        if (SArcoUSD(vault_).asset() != address(arcoUSD)) revert InvalidParams();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.PAUSER_ROLE, admin);
        _setParams(minInterval_, maxAprBps_, reserveMarginBps_);
        lastDistribution = uint64(block.timestamp);
        lastAssetSeconds = SArcoUSD(vault_).cumulativeAssetSeconds();
    }

    /// @notice Mint the distributable surplus into sArcoUSD. Anyone may call it: it only moves
    ///         surplus to savers, on schedule and within the caps.
    function distribute() external nonReentrant whenNotPaused returns (uint256 amount) {
        if (block.timestamp < uint256(lastDistribution) + minInterval) revert TooSoon();
        if (reserve.paused()) revert ReservePaused();
        if (vault.totalSupply() < vault.MIN_SHARES()) revert NoDepositors();
        (uint256 backing, bool navOk) = lens.totalBacking(reserve);
        if (!navOk) revert NavUnavailable();
        uint256 liabilities = IERC20Upgradeable(address(arcoUSD)).totalSupply();
        uint256 surplus = _surplus(backing, liabilities);
        uint256 rateCap = _rateCap();
        amount = _min(_min(surplus, rateCap), _mintHeadroom(liabilities));
        if (amount == 0) revert NothingToDistribute();

        lastDistribution = uint64(block.timestamp);
        lastAssetSeconds = vault.cumulativeAssetSeconds();
        arcoUSD.mint(address(this), amount);
        IERC20Upgradeable(address(arcoUSD)).forceApprove(address(vault), amount);
        vault.addRewards(amount);
        emit Distributed(_msgSender(), amount, backing, liabilities, surplus, rateCap);
    }

    /// @notice What distribute() would mint now (0 while NAV is unreadable), each cap, and the
    ///         earliest time it may run. For the console and the keeper.
    function preview()
        external
        view
        returns (uint256 amount, uint256 surplus, uint256 rateCap, uint256 mintHeadroom, uint256 nextAt, bool navOk)
    {
        uint256 backing;
        (backing, navOk) = lens.totalBacking(reserve);
        uint256 liabilities = IERC20Upgradeable(address(arcoUSD)).totalSupply();
        surplus = _surplus(backing, liabilities);
        rateCap = _rateCap();
        mintHeadroom = _mintHeadroom(liabilities);
        nextAt = uint256(lastDistribution) + minInterval;
        amount = navOk && !reserve.paused() ? _min(_min(surplus, rateCap), mintHeadroom) : 0;
    }

    function setParams(
        uint64 minInterval_,
        uint16 maxAprBps_,
        uint16 reserveMarginBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setParams(minInterval_, maxAprBps_, reserveMarginBps_);
    }

    function pause() external onlyRole(MidasAccessControlRoles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(MidasAccessControlRoles.PAUSER_ROLE) {
        _unpause();
    }

    function _surplus(uint256 backing, uint256 liabilities) internal view returns (uint256) {
        uint256 floor = liabilities + (liabilities * reserveMarginBps) / BPS;
        return backing > floor ? backing - floor : 0;
    }

    /// @dev average assets since the last distribution × APR × min(elapsed, vesting period).
    function _rateCap() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - lastDistribution;
        if (elapsed == 0) return 0;
        uint256 assetSeconds = vault.cumulativeAssetSeconds() - lastAssetSeconds;
        uint256 accrual = elapsed;
        uint256 vesting = vault.vestingPeriod();
        if (accrual > vesting) accrual = vesting;
        return (assetSeconds * maxAprBps * accrual) / (elapsed * BPS * YEAR);
    }

    function _mintHeadroom(uint256 liabilities) internal view returns (uint256) {
        uint256 cap = reserve.mintCap();
        return cap > liabilities ? cap - liabilities : 0;
    }

    function _setParams(uint64 minInterval_, uint16 maxAprBps_, uint16 reserveMarginBps_) internal {
        // An interval longer than the vesting period would silently cut the APR cap.
        if (
            minInterval_ < MIN_INTERVAL ||
            minInterval_ > MAX_INTERVAL ||
            minInterval_ > vault.vestingPeriod() ||
            maxAprBps_ > MAX_APR_BPS ||
            reserveMarginBps_ > MAX_MARGIN_BPS
        ) revert InvalidParams();
        minInterval = minInterval_;
        maxAprBps = maxAprBps_;
        reserveMarginBps = reserveMarginBps_;
        emit ParamsUpdated(minInterval_, maxAprBps_, reserveMarginBps_);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
