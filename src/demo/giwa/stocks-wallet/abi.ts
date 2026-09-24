import { parseAbi, sha256, toHex } from "viem"

// Pinned backend Stocks v2 ABI. Compatibility tests compare actual backend definitions and artifacts.
export const STOCKS_ABI = parseAbi([
  'function depositForOrder(bytes32 orderKey,uint256 amount)',
  'function mintForOperation(bytes32 operationId,address token,address recipient,uint256 quantity)',
  'function refundForOperation(bytes32 operationId,address recipient,uint256 amount)',
  'event FundingReceived(bytes32 indexed orderKey,address indexed payer,address token,uint256 amount)',
  'event StockMinted(bytes32 indexed operationId,address indexed token,address recipient,uint256 quantity)',
  'event FundingRefunded(bytes32 indexed operationId,address indexed recipient,uint256 amount)',
  'function escrowForOrder(bytes32 orderKey,address token,uint256 quantity)',
  'function settleRedemption(bytes32 operationId,bytes32 escrowId,uint256 cashAmount)',
  'function returnEscrowForOperation(bytes32 operationId,bytes32 escrowId)',
  'event StockEscrowed(bytes32 indexed escrowId,bytes32 indexed orderKey,address indexed payer,address token,uint256 quantity)',
  'event StockRedeemed(bytes32 indexed operationId,bytes32 indexed escrowId,address indexed recipient,address token,uint256 quantity,address cashToken,uint256 cashAmount)',
  'event StockReturned(bytes32 indexed operationId,bytes32 indexed escrowId,address indexed recipient,address token,uint256 quantity)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
export const STOCKS_ABI_DIGEST = sha256(toHex(JSON.stringify(STOCKS_ABI))).slice(2)
export const APPROVAL_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)'])
