// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only stablecoin with an issuer blocklist (like USDC/USDT): transfers to or from
///         a blocked address revert. Used to prove one blocked recipient cannot stall the
///         ArcoUSDReserve Standard queue.
contract TestBlocklistStable is ERC20 {
    uint8 private immutable _decimals;
    mapping(address account => bool blocked) public blocked;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        super._beforeTokenTransfer(from, to, amount);
        require(!blocked[from] && !blocked[to], "TBS: blocked");
    }
}
