import { parseAbi, toFunctionSelector } from "viem"

// Inline ABIs (the API image has no contract artifacts — render.yaml). arcousd.test.ts checks these
// against the compiled artifacts so they cannot drift from the contracts.

export const lensAbi = parseAbi([
  "struct AssetSnapshot { address asset; uint8 decimals; bool depositEnabled; bool redeemEnabled; uint16 instantFeeBps; uint16 swapFeeBps; uint256 balance; uint256 queued; uint256 available; uint256 queueLength; uint256 queueHead; }",
  "struct StrategySnapshot { uint256 strategyId; address asset; address productToken; bool enabled; uint256 shares; uint256 value; bool navOk; uint256 pendingRecall; uint256 maxAllocation; }",
  "struct ReserveSnapshot { uint256 totalBacking; uint256 totalLiabilities; bool navOk; uint256 mmfBps; uint256 mmfTargetBps; uint256 bufferFloorBps; uint256 queueMinDelay; uint256 mintCap; AssetSnapshot[] assets; StrategySnapshot[] strategies; }",
  "function snapshot(address reserve) view returns (ReserveSnapshot)",
])

export const reservePauseAbi = parseAbi([
  "function paused() view returns (bool)",
  "function fnPaused(bytes4 selector) view returns (bool)",
])

export const SETTLE_FOR_SELECTOR = toFunctionSelector("settleFor(address,uint256,address)")
/** ArcoUSD.burn(uint256): settleFor burns the settler's ArcoUSD, so pausing it halts settlement. */
export const ARCOUSD_BURN_SELECTOR = toFunctionSelector("burn(uint256)")
/** Reserve.deposit and ArcoUSD.mint: a Router buy paid in a stablecoin deposits (mints) first. */
export const DEPOSIT_SELECTOR = toFunctionSelector("deposit(address,uint256,address)")
export const ARCOUSD_MINT_SELECTOR = toFunctionSelector("mint(address,uint256)")
/** ArcoRouter.buy */
export const ROUTER_BUY_SELECTOR = toFunctionSelector("buy(address,uint256,address,uint256,address,bool)")
/** Reserve.processQueue: its own pause switch halts Standard-queue payouts. */
export const PROCESS_QUEUE_SELECTOR = toFunctionSelector("processQueue(address,uint256)")

/** Every ArcoUSDReserve event (indexer). */
export const reserveEventsAbi = parseAbi([
  "event Deposited(address indexed sender, address indexed recipient, address indexed asset, uint256 assetAmount, uint256 arcoUSDOut, uint256 fee)",
  "event RedeemedInstant(address indexed sender, address indexed recipient, address indexed asset, uint256 arcoUSDIn, uint256 assetOut, uint256 fee)",
  "event RedeemQueued(uint256 indexed requestId, address indexed owner, address recipient, address indexed asset, uint256 arcoUSDIn, uint256 assetOut, uint64 requestedAt)",
  "event RedeemPaid(uint256 indexed requestId, address indexed recipient, address indexed asset, uint256 assetOut)",
  "event RedeemPayoutFailed(uint256 indexed requestId, address indexed recipient, address indexed asset, uint256 assetOut)",
  "event RedeemCancelled(uint256 indexed requestId, address indexed owner, uint256 arcoUSDReturned)",
  "event SettledFor(address indexed settler, address indexed asset, uint256 arcoUSDIn, uint256 assetOut, address indexed to)",
  "event Allocated(uint256 indexed strategyId, uint256 assetsIn, uint256 sharesOut)",
  "event RecalledInstant(uint256 indexed strategyId, uint256 sharesIn, uint256 assetsReceived)",
  "event RecallRequested(uint256 indexed strategyId, uint256 indexed vaultRequestId, uint256 sharesIn, uint256 assetsOut)",
  "event RecallClaimed(uint256 indexed strategyId, uint256 indexed vaultRequestId, uint256 assetsReceived)",
  "event RecallAcknowledged(uint256 indexed strategyId, uint256 indexed vaultRequestId, uint256 assetsOut)",
  "event AssetConfigured(address indexed asset, bool depositEnabled, bool redeemEnabled, uint16 instantFeeBps, uint16 swapFeeBps, uint256 depositCap, address priceFeed, uint16 maxDepegBps, uint256 minQueued)",
  "event StrategyConfigured(uint256 indexed strategyId, address indexed asset, address depositVault, address redemptionVault, bool enabled, uint256 maxAllocation)",
  "event ParamsUpdated(uint256 mintCap, uint16 mmfTargetBps, uint16 bufferFloorBps, uint32 queueMinDelay)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event FunctionPaused(bytes4 indexed selector, address indexed account)",
  "event FunctionUnpaused(bytes4 indexed selector, address indexed account)",
  // Inherited (OZ AccessControl / Initializable): kept so role changes and upgrades leave an audit trail.
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event Initialized(uint8 version)",
])

/** Every ArcoRouter event (indexer). */
export const routerEventsAbi = parseAbi([
  "event Bought(address indexed payer, address indexed recipient, address indexed depositVault, address payAsset, uint256 payAmount, uint256 arcoUSDSettled, uint256 paymentAmount, uint256 result, bool request)",
  "event VaultAllowed(address indexed depositVault, address indexed paymentToken, bool allowed)",
  "event Rescued(address indexed token, address indexed to, uint256 amount)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event FunctionPaused(bytes4 indexed selector, address indexed account)",
  "event FunctionUnpaused(bytes4 indexed selector, address indexed account)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event Initialized(uint8 version)",
])
