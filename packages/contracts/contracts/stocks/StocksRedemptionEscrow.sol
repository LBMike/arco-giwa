// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./StocksToken.sol";
import "./StocksMintController.sol";
import "./StocksFundingVault.sol";

contract StocksRedemptionEscrow is StocksOperations, ReentrancyGuard {
    enum State {
        NONE,
        HELD,
        REDEEMED,
        RETURNED
    }
    struct EscrowRecord {
        bytes32 orderKey;
        address payer;
        address token;
        uint256 quantity;
        State state;
    }

    address public immutable operator;
    address public immutable stockToken;
    StocksFundingVault public immutable fundingVault;
    address public immutable cashToken;
    mapping(bytes32 => EscrowRecord) public escrows;

    event StockEscrowed(
        bytes32 indexed escrowId,
        bytes32 indexed orderKey,
        address indexed payer,
        address token,
        uint256 quantity
    );
    event StockRedeemed(
        bytes32 indexed operationId,
        bytes32 indexed escrowId,
        address indexed recipient,
        address token,
        uint256 quantity,
        address cashToken,
        uint256 cashAmount
    );
    event StockReturned(
        bytes32 indexed operationId,
        bytes32 indexed escrowId,
        address indexed recipient,
        address token,
        uint256 quantity
    );

    constructor(address operator_, address stockToken_, address fundingVault_) {
        _address(operator_);
        _address(stockToken_);
        _address(fundingVault_);
        require(
            StocksToken(stockToken_).redemptionEscrow() == address(this),
            "STOCKS_ESCROW_MISMATCH"
        );
        require(
            StocksFundingVault(fundingVault_).redemptionEscrow() == address(this),
            "STOCKS_VAULT_MISMATCH"
        );
        require(
            StocksFundingVault(fundingVault_).operator() == operator_,
            "STOCKS_OPERATOR_MISMATCH"
        );
        address controller = StocksToken(stockToken_).mintController();
        require(
            StocksMintController(controller).stockToken() == stockToken_ &&
                StocksMintController(controller).operator() == operator_,
            "STOCKS_CONTROLLER_MISMATCH"
        );
        operator = operator_;
        stockToken = stockToken_;
        fundingVault = StocksFundingVault(fundingVault_);
        cashToken = address(StocksFundingVault(fundingVault_).cashToken());
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "STOCKS_UNAUTHORIZED");
        _;
    }

    function escrowForOrder(
        bytes32 orderKey,
        address token,
        uint256 quantity
    ) external nonReentrant onGiwaTestnet {
        require(orderKey != bytes32(0), "STOCKS_ZERO_ORDER");
        require(token == stockToken, "STOCKS_WRONG_TOKEN");
        _positive(quantity);
        bytes32 escrowId = keccak256(abi.encode(orderKey, msg.sender, token));
        require(escrows[escrowId].state == State.NONE, "STOCKS_ESCROW_ALREADY_EXISTS");
        escrows[escrowId] = EscrowRecord(orderKey, msg.sender, token, quantity, State.HELD);
        StocksToken(token).escrowFrom(msg.sender, quantity);
        emit StockEscrowed(escrowId, orderKey, msg.sender, token, quantity);
    }

    function settleRedemption(
        bytes32 operationId,
        bytes32 escrowId,
        uint256 cashAmount
    ) external onlyOperator nonReentrant onGiwaTestnet {
        _positive(cashAmount);
        EscrowRecord storage record = escrows[escrowId];
        require(record.state != State.NONE, "STOCKS_UNKNOWN_ESCROW");
        bytes32 payload = keccak256(
            abi.encode(
                "REDEEM",
                escrowId,
                record.orderKey,
                record.payer,
                record.token,
                record.quantity,
                cashToken,
                cashAmount
            )
        );
        if (!_recordOperation(operationId, payload)) return;
        require(record.state == State.HELD, "STOCKS_ESCROW_CLOSED");
        record.state = State.REDEEMED;
        StocksToken(record.token).burnEscrow(record.quantity);
        fundingVault.payoutRedemption(operationId, escrowId, record.payer, cashAmount);
        emit StockRedeemed(
            operationId,
            escrowId,
            record.payer,
            record.token,
            record.quantity,
            cashToken,
            cashAmount
        );
    }

    function returnEscrowForOperation(
        bytes32 operationId,
        bytes32 escrowId
    ) external onlyOperator nonReentrant onGiwaTestnet {
        EscrowRecord storage record = escrows[escrowId];
        require(record.state != State.NONE, "STOCKS_UNKNOWN_ESCROW");
        bytes32 payload = keccak256(
            abi.encode(
                "RETURN",
                escrowId,
                record.orderKey,
                record.payer,
                record.token,
                record.quantity
            )
        );
        if (!_recordOperation(operationId, payload)) return;
        require(record.state == State.HELD, "STOCKS_ESCROW_CLOSED");
        record.state = State.RETURNED;
        StocksToken(record.token).returnFromEscrow(record.payer, record.quantity);
        emit StockReturned(operationId, escrowId, record.payer, record.token, record.quantity);
    }
}
