// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

/// @notice Test-only USDT-style token whose transfer/transferFrom/approve return NOTHING.
///         Proves the Reserve handles non-standard return data on every payout path.
contract TestNoReturnStable {
    string public name = "NoReturn USD";
    string public symbol = "nUSD";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "NRS: allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "NRS: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
