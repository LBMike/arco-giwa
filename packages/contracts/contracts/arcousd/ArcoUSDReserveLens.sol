// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {DecimalsCorrectionLibrary} from "../libraries/DecimalsCorrectionLibrary.sol";
import {ArcoUSDReserve} from "./ArcoUSDReserve.sol";

/// @title ArcoUSDReserveLens
/// @notice Stateless, non-upgradeable read helper for ArcoUSDReserve: total backing vs
///         liabilities, MMF share, and a one-call snapshot for the server/admin dashboard.
///         Redeployable at will; holds no funds and no roles.
contract ArcoUSDReserveLens {
    using DecimalsCorrectionLibrary for uint256;

    uint256 private constant BPS = 10_000;

    struct AssetSnapshot {
        address asset;
        uint8 decimals;
        bool depositEnabled;
        bool redeemEnabled;
        uint16 instantFeeBps; // Instant redemptions only
        uint16 swapFeeBps; // deposits and all redemptions (non-base stablecoins)
        uint256 balance; // asset units
        uint256 queued; // asset units owed to the Standard queue
        uint256 available; // balance − queued (free for Instant, settlement, allocation)
        uint256 queueLength;
        uint256 queueHead;
    }

    struct StrategySnapshot {
        uint256 strategyId;
        address asset;
        address productToken;
        bool enabled;
        uint256 shares;
        uint256 value; // base18 at NAV, 0 when !navOk
        bool navOk;
        uint256 pendingRecall; // base18
        uint256 maxAllocation; // base18
    }

    struct ReserveSnapshot {
        uint256 totalBacking; // base18
        uint256 totalLiabilities; // ArcoUSD total supply (escrow included)
        bool navOk;
        uint256 mmfBps; // (strategy value + pending recalls) / backing
        uint256 mmfTargetBps;
        uint256 bufferFloorBps;
        uint256 queueMinDelay;
        uint256 mintCap;
        AssetSnapshot[] assets;
        StrategySnapshot[] strategies;
    }

    /// @notice Buffers (base18, queued payouts included) + strategy holdings at NAV + pending
    ///         recalls. `navOk` is false when any strategy NAV could not be read (that strategy
    ///         then counts as 0).
    function totalBacking(ArcoUSDReserve reserve) public view returns (uint256 backing, bool navOk) {
        backing = bufferTotal(reserve);
        (uint256 invested, bool ok) = investedValue(reserve);
        return (backing + invested, ok);
    }

    function totalLiabilities(ArcoUSDReserve reserve) public view returns (uint256) {
        return IERC20Upgradeable(address(reserve.arcoUSD())).totalSupply();
    }

    function bufferTotal(ArcoUSDReserve reserve) public view returns (uint256 total) {
        address[] memory assets = reserve.getAssets();
        for (uint256 i = 0; i < assets.length; i++) {
            total += reserve.bufferBalance(assets[i]).convertToBase18(
                reserve.getAssetConfig(assets[i]).decimals
            );
        }
    }

    function investedValue(ArcoUSDReserve reserve) public view returns (uint256 invested, bool navOk) {
        navOk = true;
        uint256 count = reserve.strategyCount();
        for (uint256 i = 0; i < count; i++) {
            (uint256 value, bool ok) = reserve.strategyValue(i);
            if (!ok) navOk = false;
            invested += value + reserve.pendingRecall(i);
        }
    }

    function mmfAllocationBps(ArcoUSDReserve reserve) public view returns (uint256) {
        (uint256 backing, ) = totalBacking(reserve);
        if (backing == 0) return 0;
        (uint256 invested, ) = investedValue(reserve);
        return (invested * BPS) / backing;
    }

    function snapshot(ArcoUSDReserve reserve) external view returns (ReserveSnapshot memory snap) {
        (snap.totalBacking, snap.navOk) = totalBacking(reserve);
        snap.totalLiabilities = totalLiabilities(reserve);
        snap.mmfBps = mmfAllocationBps(reserve);
        snap.mmfTargetBps = reserve.mmfTargetBps();
        snap.bufferFloorBps = reserve.bufferFloorBps();
        snap.queueMinDelay = reserve.queueMinDelay();
        snap.mintCap = reserve.mintCap();

        address[] memory assets = reserve.getAssets();
        snap.assets = new AssetSnapshot[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            ArcoUSDReserve.AssetConfig memory config = reserve.getAssetConfig(assets[i]);
            snap.assets[i] = AssetSnapshot({
                asset: assets[i],
                decimals: config.decimals,
                depositEnabled: config.depositEnabled,
                redeemEnabled: config.redeemEnabled,
                instantFeeBps: config.instantFeeBps,
                swapFeeBps: config.swapFeeBps,
                balance: reserve.bufferBalance(assets[i]),
                queued: reserve.queuedAssets(assets[i]),
                available: reserve.availableLiquidity(assets[i]),
                queueLength: reserve.queueLength(assets[i]),
                queueHead: reserve.queueHead(assets[i])
            });
        }

        uint256 count = reserve.strategyCount();
        snap.strategies = new StrategySnapshot[](count);
        for (uint256 i = 0; i < count; i++) {
            ArcoUSDReserve.Strategy memory strategy = reserve.getStrategy(i);
            (uint256 value, bool ok) = reserve.strategyValue(i);
            snap.strategies[i] = StrategySnapshot({
                strategyId: i,
                asset: strategy.asset,
                productToken: strategy.productToken,
                enabled: strategy.enabled,
                shares: IERC20Upgradeable(strategy.productToken).balanceOf(address(reserve)),
                value: value,
                navOk: ok,
                pendingRecall: reserve.pendingRecall(i),
                maxAllocation: strategy.maxAllocation
            });
        }
    }
}
