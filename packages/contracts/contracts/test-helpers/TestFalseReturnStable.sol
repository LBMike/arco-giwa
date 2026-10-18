// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

/// @notice Test-only stablecoin that, while paused, returns `false` from transfer without
///         reverting and without moving funds (an old-style ERC-20). Proves the Reserve's
///         token-wide failure probe does not misread such a pause as one recipient's failure.
contract TestFalseReturnStable {
    string public name = "FalseReturn USD";
    string public symbol = "fUSD";
    uint8 public constant decimals = 6;
    bool public paused;
    uint256 public totalSupply;
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (paused || balanceOf[msg.sender] < amount) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (paused || balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
