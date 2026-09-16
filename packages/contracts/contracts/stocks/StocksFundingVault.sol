// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./StocksGuards.sol";

contract StocksFundingVault is StocksOperations, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable cashToken;
    address public immutable operator;
    address public immutable redemptionEscrow;

    event FundingReceived(
        bytes32 indexed orderKey,
        address indexed payer,
        address token,
        uint256 amount
    );
    event FundingRefunded(bytes32 indexed operationId, address indexed recipient, uint256 amount);

    constructor(address cashToken_, address operator_, address redemptionEscrow_) {
        _address(cashToken_);
        _address(operator_);
        _address(redemptionEscrow_);
        require(cashToken_.code.length > 0, "STOCKS_CASH_NOT_CONTRACT");
        require(operator_ != redemptionEscrow_, "STOCKS_OVERLAPPING_ROLES");
        cashToken = IERC20(cashToken_);
        operator = operator_;
        redemptionEscrow = redemptionEscrow_;
    }

    function depositForOrder(bytes32 orderKey, uint256 amount) external nonReentrant onGiwaTestnet {
        require(orderKey != bytes32(0), "STOCKS_ZERO_ORDER");
        _positive(amount);
        uint256 beforeBalance = cashToken.balanceOf(address(this));
        cashToken.safeTransferFrom(msg.sender, address(this), amount);
        require(
            cashToken.balanceOf(address(this)) == beforeBalance + amount,
            "STOCKS_CASH_AMOUNT_MISMATCH"
        );
        emit FundingReceived(orderKey, msg.sender, address(cashToken), amount);
    }

    function refundForOperation(
        bytes32 operationId,
        address recipient,
        uint256 amount
    ) external nonReentrant onGiwaTestnet {
        require(msg.sender == operator, "STOCKS_UNAUTHORIZED");
        _address(recipient);
        _positive(amount);
        if (!_recordOperation(operationId, keccak256(abi.encode("REFUND", recipient, amount))))
            return;
        _pay(recipient, amount);
        emit FundingRefunded(operationId, recipient, amount);
    }

    function payoutRedemption(
        bytes32 operationId,
        bytes32 escrowId,
        address recipient,
        uint256 amount
    ) external nonReentrant onGiwaTestnet {
        require(msg.sender == redemptionEscrow, "STOCKS_UNAUTHORIZED");
        _address(recipient);
        _positive(amount);
        require(escrowId != bytes32(0), "STOCKS_ZERO_ESCROW");
        require(
            _recordOperation(
                operationId,
                keccak256(abi.encode("REDEEM", escrowId, recipient, amount))
            ),
            "STOCKS_PAYOUT_ALREADY_USED"
        );
        _pay(recipient, amount);
    }

    function _pay(address recipient, uint256 amount) private {
        require(recipient != address(this), "STOCKS_CUSTODY_RECIPIENT");
        uint256 vaultBefore = cashToken.balanceOf(address(this));
        uint256 recipientBefore = cashToken.balanceOf(recipient);
        cashToken.safeTransfer(recipient, amount);
        require(
            cashToken.balanceOf(address(this)) + amount == vaultBefore &&
                cashToken.balanceOf(recipient) == recipientBefore + amount,
            "STOCKS_CASH_AMOUNT_MISMATCH"
        );
    }
}
