// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

abstract contract FunctionPausable is Initializable, PausableUpgradeable {
    mapping(bytes4 selector => bool paused) public fnPaused;

    event FunctionPaused(bytes4 indexed selector, address indexed account);
    event FunctionUnpaused(bytes4 indexed selector, address indexed account);

    function __FunctionPausable_init() internal onlyInitializing {
        __Pausable_init();
    }

    modifier whenFnNotPaused(bytes4 selector) {
        require(!paused(), "FP: paused");
        require(!fnPaused[selector], "FP: fn paused");
        _;
    }

    function pause() external {
        _requirePauseAdmin();
        _pause();
    }

    function unpause() external {
        _requirePauseAdmin();
        _unpause();
    }

    function pauseFn(bytes4 selector) external {
        _requirePauseAdmin();
        fnPaused[selector] = true;
        emit FunctionPaused(selector, _msgSender());
    }

    function unpauseFn(bytes4 selector) external {
        _requirePauseAdmin();
        fnPaused[selector] = false;
        emit FunctionUnpaused(selector, _msgSender());
    }

    function _requirePauseAdmin() internal view virtual;

    uint256[49] private __gap;
}
