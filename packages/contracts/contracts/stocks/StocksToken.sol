// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./StocksGuards.sol";

contract StocksToken is ERC20, StocksGuards {
    address public immutable mintController;
    address public immutable redemptionEscrow;

    constructor(
        address mintController_,
        address redemptionEscrow_
    ) ERC20("ARCO Test NVIDIA", "ARCO_TEST_NVDA") {
        _address(mintController_);
        _address(redemptionEscrow_);
        require(mintController_ != redemptionEscrow_, "STOCKS_OVERLAPPING_ROLES");
        mintController = mintController_;
        redemptionEscrow = redemptionEscrow_;
    }

    function decimals() public pure override returns (uint8) {
        return 9;
    }

    modifier onlyEscrow() {
        require(msg.sender == redemptionEscrow, "STOCKS_UNAUTHORIZED");
        _;
    }

    function mintTo(address recipient, uint256 quantity) external onGiwaTestnet {
        require(msg.sender == mintController, "STOCKS_UNAUTHORIZED");
        _address(recipient);
        require(recipient != redemptionEscrow, "STOCKS_CUSTODY_RECIPIENT");
        _positive(quantity);
        _mint(recipient, quantity);
    }

    function escrowFrom(address payer, uint256 quantity) external onlyEscrow onGiwaTestnet {
        _address(payer);
        require(payer != redemptionEscrow, "STOCKS_CUSTODY_PAYER");
        _positive(quantity);
        _spendAllowance(payer, redemptionEscrow, quantity);
        _transfer(payer, redemptionEscrow, quantity);
    }

    function returnFromEscrow(
        address recipient,
        uint256 quantity
    ) external onlyEscrow onGiwaTestnet {
        _address(recipient);
        require(recipient != redemptionEscrow, "STOCKS_CUSTODY_RECIPIENT");
        _positive(quantity);
        _transfer(redemptionEscrow, recipient, quantity);
    }

    function burnEscrow(uint256 quantity) external onlyEscrow onGiwaTestnet {
        _positive(quantity);
        _burn(redemptionEscrow, quantity);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        require(block.chainid == REQUIRED_CHAIN_ID, "STOCKS_WRONG_CHAIN");
        if (from == address(0)) {
            require(msg.sender == mintController, "STOCKS_UNAUTHORIZED");
        } else {
            require(msg.sender == redemptionEscrow, "STOCKS_RESTRICTED_TRANSFER");
            require(
                from == redemptionEscrow || to == redemptionEscrow,
                "STOCKS_RESTRICTED_TRANSFER"
            );
        }
        super._beforeTokenTransfer(from, to, amount);
    }
}
