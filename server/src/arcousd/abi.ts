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

/** Reserve.getAssetConfig: the per-asset limits the Lens snapshot leaves out (depositCap, minQueued). */
export const reserveAssetConfigAbi = parseAbi([
  "struct AssetConfig { bool supported; bool depositEnabled; bool redeemEnabled; uint8 decimals; uint16 instantFeeBps; uint16 maxDepegBps; address priceFeed; uint16 swapFeeBps; uint256 depositCap; uint256 minQueued; }",
  "function getAssetConfig(address asset) view returns (AssetConfig)",
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
/** Reserve.redeem: its switch halts every redemption, Instant and Standard (the Zap's Instant-only one too). */
export const REDEEM_SELECTOR = toFunctionSelector("redeem(address,uint256,address,uint256)")

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

// ─────────────────────────── Savings (phase 4) ───────────────────────────

/** sArcoUSD reads (SArcoUSD.sol, docs/specs/arcousd-v1.md §3.13). */
export const savingsVaultReadAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function unvestedAmount() view returns (uint256)",
  "function vestingAmount() view returns (uint256)",
  "function vestingStart() view returns (uint64)",
  "function vestingPeriod() view returns (uint64)",
  "function rewardRate() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function MIN_SHARES() view returns (uint256)",
  "function paused() view returns (bool)",
  "function fnPaused(bytes4 selector) view returns (bool)",
])

/** ArcoUSDSavingsDistributor reads and its one write (§3.14). */
export const distributorAbi = parseAbi([
  "function preview() view returns (uint256 amount, uint256 surplus, uint256 rateCap, uint256 mintHeadroom, uint256 nextAt, bool navOk)",
  "function minInterval() view returns (uint64)",
  "function maxAprBps() view returns (uint16)",
  "function reserveMarginBps() view returns (uint16)",
  "function lastDistribution() view returns (uint64)",
  "function paused() view returns (bool)",
  "function distribute() returns (uint256 amount)",
  // Custom errors, so a simulated distribute() that reverts names its reason.
  "error TooSoon()",
  "error ReservePaused()",
  "error NoDepositors()",
  "error NavUnavailable()",
  "error NothingToDistribute()",
])

/** sArcoUSD pause switches: deposit (also mint), withdraw (also redeem), addRewards. */
export const SAVINGS_DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)")
export const SAVINGS_WITHDRAW_SELECTOR = toFunctionSelector("withdraw(uint256,address,address)")
export const SAVINGS_REWARDS_SELECTOR = toFunctionSelector("addRewards(uint256)")
/** Holder of the 1 sArcoUSD seed (SArcoUSD.SEED_HOLDER). */
export const SAVINGS_SEED_HOLDER = "0x000000000000000000000000000000000000dEaD" as const

/** Every SArcoUSD event (indexer; Transfer and Approval are decoded but not stored). */
export const savingsVaultEventsAbi = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event RewardsAdded(address indexed caller, uint256 amount, uint256 vestingAmount, uint64 vestingPeriod)",
  "event Seeded(address indexed caller, address indexed holder, uint256 assets)",
  "event VestingPeriodUpdated(uint64 vestingPeriod)",
  "event Rescued(address indexed token, address indexed to, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event FunctionPaused(bytes4 indexed selector, address indexed account)",
  "event FunctionUnpaused(bytes4 indexed selector, address indexed account)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event Initialized(uint8 version)",
  "event EIP712DomainChanged()",
])

/** Every ArcoUSDSavingsDistributor event (indexer). */
export const distributorEventsAbi = parseAbi([
  "event Distributed(address indexed caller, uint256 amount, uint256 backing, uint256 liabilities, uint256 surplus, uint256 rateCap)",
  "event ParamsUpdated(uint64 minInterval, uint16 maxAprBps, uint16 reserveMarginBps)",
  "event Paused(address account)",
  "event Unpaused(address account)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
])

/** Every ArcoSavingsZap event (indexer): which stablecoin a saver came in or left with. */
export const savingsZapEventsAbi = parseAbi([
  "event ZapDeposit(address indexed caller, address indexed receiver, address indexed asset, uint256 amount, uint256 arcoUSDIn, uint256 shares)",
  "event ZapRedeem(address indexed caller, address indexed receiver, address indexed asset, uint256 shares, uint256 arcoUSDOut, uint256 assetOut)",
])
