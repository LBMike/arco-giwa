// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./StocksGuards.sol";

/// @notice Test value only. This contract is not an issuer's official USDC or RLUSD.
contract StocksTestCash is ERC20, StocksGuards {
    address public immutable faucetOperator;

    constructor(address faucetOperator_) ERC20("ARCO Test USDC", "ARCO_TEST_USDC") {
        _address(faucetOperator_);
        faucetOperator = faucetOperator_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address recipient, uint256 amount) external onGiwaTestnet {
        require(msg.sender == faucetOperator, "STOCKS_UNAUTHORIZED");
        _address(recipient);
        _positive(amount);
        _mint(recipient, amount);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        require(block.chainid == REQUIRED_CHAIN_ID, "STOCKS_WRONG_CHAIN");
        super._beforeTokenTransfer(from, to, amount);
    }
}
