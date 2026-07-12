// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {MidasAccessControl} from "../access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";
import {TestAssetToken} from "../TestAssetToken.sol";

contract TestAssetFaucetV1Layout is MidasAccessControl, FunctionPausable {
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
        require(config.enabled, "TAF: disabled");
        require(
            block.timestamp - lastDripAt[token][_msgSender()] >= config.cooldown,
            "TAF: cooldown"
        );
        uint256 day = block.timestamp / 1 days;
        require(
            mintedByDay[token][day] + config.dripAmount <= config.dailyCap,
            "TAF: daily cap"
        );
        require(
            totalMintedByAsset[token] + config.dripAmount <= config.globalCap,
            "TAF: global cap"
        );

        lastDripAt[token][_msgSender()] = block.timestamp;
        mintedByDay[token][day] += config.dripAmount;
        totalMintedByAsset[token] += config.dripAmount;
        TestAssetToken(token).mint(_msgSender(), config.dripAmount);
        emit FaucetDrip(token, _msgSender(), config.dripAmount);
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }
}
