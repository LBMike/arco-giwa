// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./StocksToken.sol";

contract StocksMintController is StocksOperations, ReentrancyGuard {
    address public immutable operator;
    address public immutable stockToken;

    event StockMinted(
        bytes32 indexed operationId,
        address indexed token,
        address recipient,
        uint256 quantity
    );

    constructor(address operator_, address stockToken_) {
        _address(operator_);
        _address(stockToken_);
        operator = operator_;
        stockToken = stockToken_;
    }

    function mintForOperation(
        bytes32 operationId,
        address token,
        address recipient,
        uint256 quantity
    ) external nonReentrant onGiwaTestnet {
        require(msg.sender == operator, "STOCKS_UNAUTHORIZED");
        require(token == stockToken, "STOCKS_WRONG_TOKEN");
        _address(recipient);
        _positive(quantity);
        require(StocksToken(token).mintController() == address(this), "STOCKS_CONTROLLER_MISMATCH");
        if (
            !_recordOperation(
                operationId,
                keccak256(abi.encode("MINT", token, recipient, quantity))
            )
        ) return;
        StocksToken(token).mintTo(recipient, quantity);
        emit StockMinted(operationId, token, recipient, quantity);
    }
}
