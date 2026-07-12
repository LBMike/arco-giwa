// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {MidasAccessControl} from "./access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "./access/MidasAccessControlRoles.sol";
import {FunctionPausable} from "./access/FunctionPausable.sol";
import {TestAssetToken} from "./TestAssetToken.sol";

contract TestAssetFaucet is MidasAccessControl, FunctionPausable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct AssetConfig {
        uint256 dripAmount;
        uint256 dailyCap;
        uint256 globalCap;
        uint256 cooldown;
        bool enabled;
    }

    mapping(address token => AssetConfig config) public assetConfigs;
    mapping(address token => uint256 totalMinted) public totalMintedByAsset;
    mapping(address token => mapping(uint256 day => uint256 minted)) public mintedByDay;
    mapping(address token => mapping(address wallet => uint256 timestamp)) public lastDripAt;
    address[] private _assets;
    mapping(address token => bool known) private _assetKnown;

    event FaucetAssetConfigured(
        address indexed token,
        uint256 dripAmount,
        uint256 dailyCap,
        uint256 globalCap
    );
    event FaucetDrip(address indexed token, address indexed wallet, uint256 amount);

    function initialize(address admin) external initializer {
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
    }

    function configureAsset(
        address token,
        uint256 dripAmount,
        uint256 dailyCap,
        uint256 globalCap,
        uint256 cooldown,
        bool enabled
    ) external onlyRole(MidasAccessControlRoles.FAUCET_ADMIN_ROLE) {
        require(token != address(0), "TAF: token zero");
        require(dripAmount > 0, "TAF: drip zero");
        require(dailyCap >= dripAmount, "TAF: daily cap");
        require(globalCap >= dripAmount, "TAF: global cap");
        if (!_assetKnown[token]) {
            _assetKnown[token] = true;
            _assets.push(token);
        }
        assetConfigs[token] = AssetConfig({
            dripAmount: dripAmount,
            dailyCap: dailyCap,
            globalCap: globalCap,
            cooldown: cooldown,
            enabled: enabled
        });
        emit FaucetAssetConfigured(token, dripAmount, dailyCap, globalCap);
    }

    function drip(address token) external whenFnNotPaused(this.drip.selector) {
        AssetConfig memory config = assetConfigs[token];
        uint256 day = block.timestamp / 1 days;
        _requireDripAllowed(token, _msgSender(), config, day);
        _executeDrip(token, _msgSender(), config, day);
    }

    function dripAll() external whenFnNotPaused(this.dripAll.selector) {
        uint256 day = block.timestamp / 1 days;
        address wallet = _msgSender();
        uint256 length = _assets.length;
        for (uint256 i = 0; i < length; ++i) {
            address token = _assets[i];
            AssetConfig memory config = assetConfigs[token];
            if (_canDrip(token, wallet, config, day)) {
                _executeDrip(token, wallet, config, day);
            }
        }
    }

    function supportedAssets() external view returns (address[] memory) {
        uint256 length = _assets.length;
        address[] memory assets = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            assets[i] = _assets[i];
        }
        return assets;
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }

    function _requireDripAllowed(
        address token,
        address wallet,
        AssetConfig memory config,
        uint256 day
    ) private view {
        require(config.enabled, "TAF: disabled");
        require(_cooldownElapsed(token, wallet, config), "TAF: cooldown");
        require(_withinDailyCap(token, config, day), "TAF: daily cap");
        require(_withinGlobalCap(token, config), "TAF: global cap");
    }

    function _canDrip(
        address token,
        address wallet,
        AssetConfig memory config,
        uint256 day
    ) private view returns (bool) {
        return
            config.enabled &&
            _cooldownElapsed(token, wallet, config) &&
            _withinDailyCap(token, config, day) &&
            _withinGlobalCap(token, config);
    }

    function _cooldownElapsed(
        address token,
        address wallet,
        AssetConfig memory config
    ) private view returns (bool) {
        uint256 lastDrip = lastDripAt[token][wallet];
        return block.timestamp >= lastDrip && block.timestamp - lastDrip >= config.cooldown;
    }

    function _withinDailyCap(
        address token,
        AssetConfig memory config,
        uint256 day
    ) private view returns (bool) {
        uint256 mintedToday = mintedByDay[token][day];
        return mintedToday <= config.dailyCap && config.dripAmount <= config.dailyCap - mintedToday;
    }

    function _withinGlobalCap(
        address token,
        AssetConfig memory config
    ) private view returns (bool) {
        uint256 mintedTotal = totalMintedByAsset[token];
        return mintedTotal <= config.globalCap && config.dripAmount <= config.globalCap - mintedTotal;
    }

    function _executeDrip(
        address token,
        address wallet,
        AssetConfig memory config,
        uint256 day
    ) private {
        lastDripAt[token][wallet] = block.timestamp;
        mintedByDay[token][day] += config.dripAmount;
        totalMintedByAsset[token] += config.dripAmount;
        TestAssetToken(token).mint(wallet, config.dripAmount);
        emit FaucetDrip(token, wallet, config.dripAmount);
    }

    uint256[48] private __gap;
}
