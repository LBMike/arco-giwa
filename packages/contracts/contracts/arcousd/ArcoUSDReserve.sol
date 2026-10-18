// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {
    IERC20MetadataUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import {
    IERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20PermitUpgradeable.sol";
import {
    SafeERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {DecimalsCorrectionLibrary} from "../libraries/DecimalsCorrectionLibrary.sol";
import {IDataFeed} from "../interfaces/IDataFeed.sol";
import {IArcoUSD, IArcoDepositVaultLike, IArcoRedemptionVaultLike} from "./IArcoUSDInterfaces.sol";

/// @title ArcoUSDReserve
/// @notice Issues ArcoUSD 1:1 against supported stablecoins and pays it back out.
///         - Instant redemption when the selected stablecoin's free buffer covers it, else a
///           per-asset FIFO Standard queue that pushes the payout straight to the wallet.
///         - settleFor: product purchases (Router) burn ArcoUSD and draw the stablecoin.
///         - MMF strategies: the manager allocates buffer into existing Arco product vaults and
///           recalls it; holdings are valued at the product feed NAV.
///         Spec: docs/specs/arcousd-v1.md. Aggregate views (total backing, MMF share, snapshot)
///         live in ArcoUSDReserveLens to keep this contract under the 24KB code limit.
/// @dev Free buffer of an asset = balance − unpaid queued payouts of that asset. Instant
///      redemptions, settlement and allocation only ever draw on the free buffer, so a later
///      request can never jump ahead of a queued one. Queued requests skip the Instant fee and
///      are payable only after `queueMinDelay`, so the queue cannot be used as a same-block
///      fee-free Instant. Fees: `swapFeeBps` (non-base stablecoins such as USDT/RLUSD; 0 for
///      USDC) applies to deposits and to every redemption, Instant or queued; `instantFeeBps`
///      applies to Instant only. Fees stay in the Reserve as surplus backing.
contract ArcoUSDReserve is AccessControlUpgradeable, FunctionPausable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using DecimalsCorrectionLibrary for uint256;

    bytes32 public constant RESERVE_MANAGER_ROLE = keccak256("RESERVE_MANAGER_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    uint256 public constant MAX_ASSETS = 8;
    uint256 public constant MAX_STRATEGIES = 8;
    uint16 public constant MAX_INSTANT_FEE_BPS = 100;
    uint16 public constant BPS = 10_000;
    /// @notice allocate() requires the strategy value to move by the allocated amount ± this.
    uint16 public constant ALLOCATION_TOLERANCE_BPS = 100;
    uint32 public constant MAX_QUEUE_MIN_DELAY = 7 days;
    /// @notice processQueue stops (keeps priority) instead of attempting a payout below this gas,
    ///         so a starved inner call is never mistaken for a recipient failure.
    uint256 public constant MIN_PAYOUT_GAS = 150_000;
    uint256 private constant ONE = 1e18;

    enum RequestStatus {
        None,
        Queued,
        Paid,
        Cancelled,
        PayoutFailed
    }

    struct AssetParams {
        bool depositEnabled;
        bool redeemEnabled;
        uint16 instantFeeBps; // Instant redemptions only
        uint16 swapFeeBps; // deposits and all redemptions of a non-base stablecoin (0 for USDC)
        uint256 depositCap;
        address priceFeed;
        uint16 maxDepegBps;
        uint256 minQueued; // smallest payout (asset units) that may join the Standard queue
    }

    struct AssetConfig {
        bool supported;
        bool depositEnabled;
        bool redeemEnabled;
        uint8 decimals;
        uint16 instantFeeBps;
        uint16 maxDepegBps;
        address priceFeed;
        // Appended after priceFeed (bytes 28-29 of the first slot) so the layout before it is unchanged.
        uint16 swapFeeBps;
        uint256 depositCap;
        uint256 minQueued;
    }

    struct RedeemRequest {
        address owner;
        address recipient;
        address asset;
        uint64 requestedAt;
        RequestStatus status;
        uint256 arcoUSDAmount;
        uint256 assetAmount;
    }

    struct Strategy {
        address asset;
        address depositVault;
        address redemptionVault;
        address productToken;
        address priceFeed;
        bool enabled;
        uint256 maxAllocation; // base18, valued at NAV
        uint256 pendingRecall; // asset units locked in open vault redemption requests
    }

    IArcoUSD public arcoUSD;
    uint256 public mintCap;
    uint16 public mmfTargetBps;
    uint16 public bufferFloorBps;
    uint32 public queueMinDelay;
    uint256 public nextRequestId;

    address[] private _assets;
    mapping(address asset => AssetConfig config) private _assetConfig;
    mapping(address asset => uint256 amount) public queuedAssets;
    mapping(address asset => uint256[] requestIds) private _queue;
    mapping(address asset => uint256 index) public queueHead;
    mapping(uint256 requestId => RedeemRequest request) private _requests;

    // Mapping (not an array) so Strategy can grow fields in an upgrade without shifting storage.
    uint256 public strategyCount;
    mapping(uint256 strategyId => Strategy strategy) private _strategies;
    mapping(address productToken => bool registered) public strategyProductToken;
    /// @notice Pending (still counted in backing) amount of a Reserve recall request; 0 once
    ///         claimed or acknowledged.
    mapping(uint256 strategyId => mapping(uint256 vaultRequestId => uint256 assetsOut))
        public recallRequests;
    /// @notice The recall can still be collected with claimRecall (stays true after an
    ///         acknowledgement, so a later fulfil is never stranded in the vault).
    mapping(uint256 strategyId => mapping(uint256 vaultRequestId => bool open)) public recallOpen;

    event Deposited(
        address indexed sender,
        address indexed recipient,
        address indexed asset,
        uint256 assetAmount,
        uint256 arcoUSDOut,
        uint256 fee
    );
    event RedeemedInstant(
        address indexed sender,
        address indexed recipient,
        address indexed asset,
        uint256 arcoUSDIn,
        uint256 assetOut,
        uint256 fee
    );
    event RedeemQueued(
        uint256 indexed requestId,
        address indexed owner,
        address recipient,
        address indexed asset,
        uint256 arcoUSDIn,
        uint256 assetOut,
        uint64 requestedAt
    );
    event RedeemPaid(
        uint256 indexed requestId,
        address indexed recipient,
        address indexed asset,
        uint256 assetOut
    );
    event RedeemPayoutFailed(
        uint256 indexed requestId,
        address indexed recipient,
        address indexed asset,
        uint256 assetOut
    );
    event RedeemCancelled(uint256 indexed requestId, address indexed owner, uint256 arcoUSDReturned);
    event SettledFor(
        address indexed settler,
        address indexed asset,
        uint256 arcoUSDIn,
        uint256 assetOut,
        address indexed to
    );
    event Allocated(uint256 indexed strategyId, uint256 assetsIn, uint256 sharesOut);
    event RecalledInstant(uint256 indexed strategyId, uint256 sharesIn, uint256 assetsReceived);
    event RecallRequested(
        uint256 indexed strategyId,
        uint256 indexed vaultRequestId,
        uint256 sharesIn,
        uint256 assetsOut
    );
    event RecallClaimed(
        uint256 indexed strategyId,
        uint256 indexed vaultRequestId,
        uint256 assetsReceived
    );
    event RecallAcknowledged(
        uint256 indexed strategyId,
        uint256 indexed vaultRequestId,
        uint256 assetsOut
    );
    event AssetConfigured(
        address indexed asset,
        bool depositEnabled,
        bool redeemEnabled,
        uint16 instantFeeBps,
        uint16 swapFeeBps,
        uint256 depositCap,
        address priceFeed,
        uint16 maxDepegBps,
        uint256 minQueued
    );
    event StrategyConfigured(
        uint256 indexed strategyId,
        address indexed asset,
        address depositVault,
        address redemptionVault,
        bool enabled,
        uint256 maxAllocation
    );
    event ParamsUpdated(
        uint256 mintCap,
        uint16 mmfTargetBps,
        uint16 bufferFloorBps,
        uint32 queueMinDelay
    );

    error AllocationMispriced();
    error BelowQueueMinimum();
    error Blacklisted();
    error BufferFloor();
    error Depeg();
    error DepositCap();
    error DepositDisabled();
    error DuplicateStrategy();
    error EmptyRecall();
    error InsufficientLiquidity();
    error InvalidAsset();
    error InvalidParams();
    error MinOut();
    error MintCap();
    error NavUnavailable();
    error NotCancellable();
    error NotOwner();
    error NotPending();
    error RecallMispriced();
    error RecallNotReceived();
    error RedeemDisabled();
    error SharesNotReceived();
    error StrategyCap();
    error StrategyDisabled();
    error StrategyMismatch();
    error TooMany();
    error UnknownRecall();
    error UnknownStrategy();
    error UnsupportedAsset();
    error ZeroAddress();
    error ZeroAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address arcoUSD_,
        address admin,
        uint256 mintCap_,
        uint16 mmfTargetBps_,
        uint16 bufferFloorBps_,
        uint32 queueMinDelay_
    ) external initializer {
        if (arcoUSD_ == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __FunctionPausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.PAUSER_ROLE, admin);
        _grantRole(RESERVE_MANAGER_ROLE, admin);
        arcoUSD = IArcoUSD(arcoUSD_);
        nextRequestId = 1;
        _setParams(mintCap_, mmfTargetBps_, bufferFloorBps_, queueMinDelay_);
    }

    // ───────────────────────────── deposits ─────────────────────────────

    /// @notice Deposit a supported stablecoin and receive ArcoUSD 1:1 (18 decimals).
    function deposit(
        address asset,
        uint256 amount,
        address recipient
    ) external nonReentrant returns (uint256 arcoUSDOut) {
        _requireFnNotPaused(this.deposit.selector);
        AssetConfig memory config = _assetConfig[asset];
        if (!(config.supported && config.depositEnabled)) revert DepositDisabled();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        _checkPeg(config);

        IERC20Upgradeable token = IERC20Upgradeable(asset);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(_msgSender(), address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        uint256 received = balanceAfter - before;
        if (received == 0) revert ZeroAmount();
        if (balanceAfter > config.depositCap) revert DepositCap();

        uint256 gross = received.convertToBase18(config.decimals);
        uint256 fee = (gross * config.swapFeeBps) / BPS; // non-base stablecoins only
        arcoUSDOut = gross - fee;
        if (arcoUSDOut == 0) revert ZeroAmount();
        if (arcoUSD.totalSupply() + arcoUSDOut > mintCap) revert MintCap();
        arcoUSD.mint(recipient, arcoUSDOut);
        emit Deposited(_msgSender(), recipient, asset, received, arcoUSDOut, fee);
    }

    // ──────────────────────────── redemptions ───────────────────────────

    /// @notice One withdrawal request: Instant when the free buffer of `asset` covers it,
    ///         otherwise queued (swap fee only, no Instant fee) and pushed to `recipient` when
    ///         liquidity arrives.
    /// @return requestId 0 when paid instantly.
    /// @return assetPaid Net amount paid now (0 when queued).
    function redeem(
        address asset,
        uint256 arcoUSDAmount,
        address recipient,
        uint256 minAssetOut
    )
        external
        nonReentrant
        returns (uint256 requestId, uint256 assetPaid)
    {
        _requireFnNotPaused(this.redeem.selector);
        return _redeem(_msgSender(), asset, arcoUSDAmount, recipient, minAssetOut, true);
    }

    /// @notice Same as redeem, with an EIP-2612 permit for the ArcoUSD pull. Follows the
    ///         `redeem` pause switch. A failed permit is ignored when allowance already covers it
    ///         (front-run permit griefing).
    function redeemWithPermit(
        address asset,
        uint256 arcoUSDAmount,
        address recipient,
        uint256 minAssetOut,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external
        nonReentrant
        returns (uint256 requestId, uint256 assetPaid)
    {
        _requireFnNotPaused(this.redeem.selector);
        try
            IERC20PermitUpgradeable(address(arcoUSD)).permit(
                _msgSender(),
                address(this),
                arcoUSDAmount,
                deadline,
                v,
                r,
                s
            )
        {} catch {}
        return _redeem(_msgSender(), asset, arcoUSDAmount, recipient, minAssetOut, true);
    }

    /// @notice Instant or revert — for aggregators and routers that need atomicity.
    function redeemInstantOnly(
        address asset,
        uint256 arcoUSDAmount,
        address recipient,
        uint256 minAssetOut
    )
        external
        nonReentrant
        returns (uint256 assetPaid)
    {
        _requireFnNotPaused(this.redeem.selector);
        _requireFnNotPaused(this.redeemInstantOnly.selector);
        (, assetPaid) = _redeem(_msgSender(), asset, arcoUSDAmount, recipient, minAssetOut, false);
    }

    /// @notice Pay the `asset` queue from its head. Permissionless: it only discharges existing
    ///         obligations, in order. Stops — keeping every request's place — when the head is
    ///         younger than `queueMinDelay`, the buffer cannot cover it, gas runs low, or the
    ///         stablecoin rejects transfers globally (paused token, Reserve blocked). Only a
    ///         failure specific to one request (its recipient is blocked by the stablecoin, or its
    ///         owner/recipient is blacklisted on ArcoUSD) marks that request PayoutFailed.
    /// @param maxCount Upper bound on queue entries visited (paid, failed or skipped).
    function processQueue(
        address asset,
        uint256 maxCount
    ) external nonReentrant returns (uint256 paid) {
        _requireFnNotPaused(this.processQueue.selector);
        uint256[] storage queue = _queue[asset];
        uint256 head = queueHead[asset];
        uint256 visited;
        while (head < queue.length && visited < maxCount) {
            uint256 requestId = queue[head];
            RedeemRequest storage request = _requests[requestId];
            if (request.status != RequestStatus.Queued) {
                head++;
                visited++;
                continue;
            }
            if (uint256(request.requestedAt) + queueMinDelay > block.timestamp) break;
            // A request that can never be paid must not hold the head while liquidity builds up.
            if (arcoUSD.isBlacklisted(request.owner) || arcoUSD.isBlacklisted(request.recipient)) {
                _failRequest(requestId, request);
                head++;
                visited++;
                continue;
            }
            if (IERC20Upgradeable(asset).balanceOf(address(this)) < request.assetAmount) break;
            if (gasleft() < MIN_PAYOUT_GAS) break;

            if (_tryTransfer(asset, request.recipient, request.assetAmount)) {
                queuedAssets[asset] -= request.assetAmount;
                request.status = RequestStatus.Paid;
                arcoUSD.burn(request.arcoUSDAmount);
                emit RedeemPaid(requestId, request.recipient, asset, request.assetAmount);
                paid++;
            } else if (_transfersWork(asset)) {
                // The token works for the Reserve itself, so the failure is this recipient's.
                _failRequest(requestId, request);
            } else {
                break; // token-wide failure: retry later, nobody loses their place
            }
            head++;
            visited++;
        }
        queueHead[asset] = head;
    }

    /// @notice Owner takes back the escrowed ArcoUSD of a queued or failed request.
    ///         Never paused: the way back to one's own funds stays open.
    function cancelRedeem(uint256 requestId) external nonReentrant {
        RedeemRequest storage request = _requests[requestId];
        if (request.owner != _msgSender()) revert NotOwner();
        if (request.status != RequestStatus.Queued && request.status != RequestStatus.PayoutFailed) {
            revert NotCancellable();
        }
        if (request.status == RequestStatus.Queued) {
            queuedAssets[request.asset] -= request.assetAmount;
        }
        request.status = RequestStatus.Cancelled;
        IERC20Upgradeable(address(arcoUSD)).safeTransfer(request.owner, request.arcoUSDAmount);
        emit RedeemCancelled(requestId, request.owner, request.arcoUSDAmount);
    }

    // ──────────────────────────── settlement ────────────────────────────

    /// @notice Product purchase settlement: burn the settler's ArcoUSD and send the same dollar
    ///         amount of `asset` to `to`. No fee. Only from the free buffer — when it is short
    ///         this reverts, which is the on-chain side of the "buy disabled" gate.
    function settleFor(
        address asset,
        uint256 arcoUSDAmount,
        address to
    )
        external
        nonReentrant
        onlyRole(SETTLER_ROLE)
        returns (uint256 assetOut)
    {
        _requireFnNotPaused(this.settleFor.selector);
        AssetConfig memory config = _assetConfig[asset];
        if (!config.supported) revert UnsupportedAsset();
        if (to == address(0)) revert ZeroAddress();
        uint256 arcoUSDUsed;
        (assetOut, arcoUSDUsed) = _toAsset(config, arcoUSDAmount);
        if (assetOut == 0) revert ZeroAmount();
        if (availableLiquidity(asset) < assetOut) revert InsufficientLiquidity();
        IERC20Upgradeable(address(arcoUSD)).safeTransferFrom(_msgSender(), address(this), arcoUSDUsed);
        arcoUSD.burn(arcoUSDUsed);
        IERC20Upgradeable(asset).safeTransfer(to, assetOut);
        emit SettledFor(_msgSender(), asset, arcoUSDUsed, assetOut, to);
    }

    // ─────────────────────────── MMF strategies ─────────────────────────

    function allocate(
        uint256 strategyId,
        uint256 assets,
        uint256 minSharesOut
    )
        external
        nonReentrant
        onlyRole(RESERVE_MANAGER_ROLE)
        returns (uint256 sharesOut)
    {
        _requireFnNotPaused(this.allocate.selector);
        Strategy storage strategy = _strategy(strategyId);
        if (!strategy.enabled) revert StrategyDisabled();
        if (assets == 0) revert ZeroAmount();
        if (availableLiquidity(strategy.asset) < assets) revert InsufficientLiquidity();
        (uint256 valueBefore, bool okBefore) = strategyValue(strategyId);
        if (!okBefore) revert NavUnavailable();
        sharesOut = _depositIntoStrategy(strategy, assets, minSharesOut);
        _verifyAllocation(strategyId, strategy, assets, valueBefore);
        _checkBufferFloor(strategy.asset);
        emit Allocated(strategyId, assets, sharesOut);
    }

    function recallInstant(
        uint256 strategyId,
        uint256 shares,
        uint256 minAssetsOut
    )
        external
        nonReentrant
        onlyRole(RESERVE_MANAGER_ROLE)
        returns (uint256 assetsReceived)
    {
        _requireFnNotPaused(this.recallInstant.selector);
        Strategy storage strategy = _strategy(strategyId);
        uint256 nav = _navOf(strategy);
        IERC20Upgradeable token = IERC20Upgradeable(strategy.asset);
        uint256 before = token.balanceOf(address(this));
        uint256 sharesBefore = IERC20Upgradeable(strategy.productToken).balanceOf(address(this));
        IArcoRedemptionVaultLike(strategy.redemptionVault).redeemInstant(
            shares,
            minAssetsOut,
            address(this)
        );
        assetsReceived = token.balanceOf(address(this)) - before;
        if (assetsReceived == 0 || assetsReceived < minAssetsOut) revert RecallNotReceived();
        _checkRecall(strategy, sharesBefore, shares, nav, assetsReceived);
        emit RecalledInstant(strategyId, shares, assetsReceived);
    }

    function requestRecall(
        uint256 strategyId,
        uint256 shares,
        uint256 minAssetsOut
    )
        external
        nonReentrant
        onlyRole(RESERVE_MANAGER_ROLE)
        returns (uint256 vaultRequestId)
    {
        _requireFnNotPaused(this.requestRecall.selector);
        Strategy storage strategy = _strategy(strategyId);
        uint256 nav = _navOf(strategy);
        uint256 sharesBefore = IERC20Upgradeable(strategy.productToken).balanceOf(address(this));
        vaultRequestId = IArcoRedemptionVaultLike(strategy.redemptionVault).requestRedeem(
            shares,
            minAssetsOut,
            address(this)
        );
        if (recallOpen[strategyId][vaultRequestId]) revert RecallMispriced();
        uint256 assetsOut = _recordedRecall(strategy, vaultRequestId);
        _checkRecall(strategy, sharesBefore, shares, nav, assetsOut);
        recallRequests[strategyId][vaultRequestId] = assetsOut;
        recallOpen[strategyId][vaultRequestId] = true;
        strategy.pendingRecall += assetsOut;
        emit RecallRequested(strategyId, vaultRequestId, shares, assetsOut);
    }

    /// @notice Collect a fulfilled vault redemption into the buffer. Permissionless.
    function claimRecall(
        uint256 strategyId,
        uint256 vaultRequestId
    )
        external
        nonReentrant
        returns (uint256 assetsReceived)
    {
        _requireFnNotPaused(this.claimRecall.selector);
        Strategy storage strategy = _strategy(strategyId);
        if (!recallOpen[strategyId][vaultRequestId]) revert UnknownRecall();
        uint256 pending = recallRequests[strategyId][vaultRequestId]; // 0 if acknowledged
        delete recallOpen[strategyId][vaultRequestId];
        delete recallRequests[strategyId][vaultRequestId];
        strategy.pendingRecall -= pending;
        IERC20Upgradeable token = IERC20Upgradeable(strategy.asset);
        uint256 before = token.balanceOf(address(this));
        IArcoRedemptionVaultLike(strategy.redemptionVault).claimRedeem(vaultRequestId);
        assetsReceived = token.balanceOf(address(this)) - before;
        emit RecallClaimed(strategyId, vaultRequestId, assetsReceived);
    }

    /// @notice A recall was paid by direct transfer instead of fulfill + claim: stop counting it
    ///         as pending. Lowers reported backing only, so it can never overstate it. The request
    ///         stays claimable, so if the vault later fulfils it the funds are not stranded.
    function acknowledgeRecallPaid(
        uint256 strategyId,
        uint256 vaultRequestId
    ) external onlyRole(RESERVE_MANAGER_ROLE) {
        Strategy storage strategy = _strategy(strategyId);
        uint256 assetsOut = recallRequests[strategyId][vaultRequestId];
        if (assetsOut == 0) revert NotPending();
        recallRequests[strategyId][vaultRequestId] = 0;
        strategy.pendingRecall -= assetsOut;
        emit RecallAcknowledged(strategyId, vaultRequestId, assetsOut);
    }

    // ────────────────────────────── admin ───────────────────────────────

    function setAsset(address asset, AssetParams calldata params) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (asset == address(0)) revert ZeroAddress();
        if (asset == address(arcoUSD) || strategyProductToken[asset]) revert InvalidAsset();
        if (params.instantFeeBps > MAX_INSTANT_FEE_BPS || params.swapFeeBps > MAX_INSTANT_FEE_BPS) {
            revert InvalidParams();
        }
        if (params.maxDepegBps > BPS) revert InvalidParams();
        AssetConfig storage config = _assetConfig[asset];
        if (!config.supported) {
            if (_assets.length >= MAX_ASSETS) revert TooMany();
            uint8 decimals_ = IERC20MetadataUpgradeable(asset).decimals();
            if (decimals_ > 18) revert InvalidAsset();
            config.supported = true;
            config.decimals = decimals_;
            _assets.push(asset);
        }
        config.depositEnabled = params.depositEnabled;
        config.redeemEnabled = params.redeemEnabled;
        config.instantFeeBps = params.instantFeeBps;
        config.swapFeeBps = params.swapFeeBps;
        config.depositCap = params.depositCap;
        config.priceFeed = params.priceFeed;
        config.maxDepegBps = params.maxDepegBps;
        config.minQueued = params.minQueued;
        emit AssetConfigured(
            asset,
            params.depositEnabled,
            params.redeemEnabled,
            params.instantFeeBps,
            params.swapFeeBps,
            params.depositCap,
            params.priceFeed,
            params.maxDepegBps,
            params.minQueued
        );
    }

    /// @notice Register an existing Arco product as an MMF strategy. Both vaults must agree on
    ///         payment token, product token and product feed, and the payment token must be a
    ///         supported Reserve asset.
    function addStrategy(
        address depositVault,
        address redemptionVault,
        uint256 maxAllocation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 strategyId) {
        if (strategyCount >= MAX_STRATEGIES) revert TooMany();
        IArcoDepositVaultLike dv = IArcoDepositVaultLike(depositVault);
        IArcoRedemptionVaultLike rv = IArcoRedemptionVaultLike(redemptionVault);
        address asset = dv.paymentToken();
        address productToken = dv.productToken();
        address priceFeed = dv.productPriceFeed();
        if (rv.paymentToken() != asset) revert StrategyMismatch();
        if (rv.productToken() != productToken) revert StrategyMismatch();
        if (rv.productPriceFeed() != priceFeed) revert StrategyMismatch();
        if (!_assetConfig[asset].supported) revert UnsupportedAsset();
        // Holdings are valued from productToken.balanceOf(this): two strategies on one product
        // token would count the same shares twice.
        if (strategyProductToken[productToken]) revert DuplicateStrategy();
        if (productToken == address(arcoUSD) || _assetConfig[productToken].supported) {
            revert InvalidAsset();
        }
        strategyProductToken[productToken] = true;
        strategyId = strategyCount++;
        _strategies[strategyId] = Strategy({
            asset: asset,
            depositVault: depositVault,
            redemptionVault: redemptionVault,
            productToken: productToken,
            priceFeed: priceFeed,
            enabled: true,
            maxAllocation: maxAllocation,
            pendingRecall: 0
        });
        emit StrategyConfigured(strategyId, asset, depositVault, redemptionVault, true, maxAllocation);
    }

    function setStrategy(
        uint256 strategyId,
        bool enabled,
        uint256 maxAllocation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Strategy storage strategy = _strategy(strategyId);
        strategy.enabled = enabled;
        strategy.maxAllocation = maxAllocation;
        emit StrategyConfigured(
            strategyId,
            strategy.asset,
            strategy.depositVault,
            strategy.redemptionVault,
            enabled,
            maxAllocation
        );
    }

    function setParams(
        uint256 mintCap_,
        uint16 mmfTargetBps_,
        uint16 bufferFloorBps_,
        uint32 queueMinDelay_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setParams(mintCap_, mmfTargetBps_, bufferFloorBps_, queueMinDelay_);
    }

    // ────────────────────────────── views ───────────────────────────────

    function bufferBalance(address asset) public view returns (uint256) {
        return IERC20Upgradeable(asset).balanceOf(address(this));
    }

    /// @notice Balance minus unpaid queued payouts — what Instant, settlement and allocation
    ///         may use.
    function availableLiquidity(address asset) public view returns (uint256) {
        uint256 balance = bufferBalance(asset);
        uint256 queued = queuedAssets[asset];
        return balance > queued ? balance - queued : 0;
    }

    function availableForSettlement(address asset) external view returns (uint256) {
        return availableLiquidity(asset);
    }

    /// @notice Strategy holdings at NAV, in base18 units of the strategy asset. `ok` is false
    ///         (value 0) when the feed reverts (stale, out of bounds, paused).
    function strategyValue(uint256 strategyId) public view returns (uint256 value, bool ok) {
        Strategy storage strategy = _strategy(strategyId);
        uint256 shares = IERC20Upgradeable(strategy.productToken).balanceOf(address(this));
        if (shares == 0) return (0, true);
        try IDataFeed(strategy.priceFeed).getDataInBase18() returns (uint256 nav) {
            return ((shares * nav) / ONE, true);
        } catch {
            return (0, false);
        }
    }

    function pendingRecall(uint256 strategyId) public view returns (uint256) {
        Strategy storage strategy = _strategy(strategyId);
        return strategy.pendingRecall.convertToBase18(_assetConfig[strategy.asset].decimals);
    }

    function getAssets() external view returns (address[] memory) {
        return _assets;
    }

    function getAssetConfig(address asset) external view returns (AssetConfig memory) {
        return _assetConfig[asset];
    }

    function getStrategy(uint256 strategyId) external view returns (Strategy memory) {
        return _strategy(strategyId);
    }

    function getRequest(uint256 requestId) external view returns (RedeemRequest memory) {
        return _requests[requestId];
    }

    function queueLength(address asset) external view returns (uint256) {
        return _queue[asset].length;
    }

    function queuedRequestIdAt(address asset, uint256 index) external view returns (uint256) {
        return _queue[asset][index];
    }

    // ──────────────────────────── internals ─────────────────────────────

    /// @dev Pays whatever the free buffer covers now (Instant: instant + swap fee) and queues only
    ///      the shortfall (Standard: swap fee only). Queued amounts therefore never exceed a real
    ///      shortage, so a large cancellable request cannot reserve liquidity that is available.
    function _redeem(
        address owner,
        address asset,
        uint256 arcoUSDAmount,
        address recipient,
        uint256 minAssetOut,
        bool allowQueue
    ) internal returns (uint256 requestId, uint256 assetPaid) {
        AssetConfig memory config = _assetConfig[asset];
        if (!(config.supported && config.redeemEnabled)) revert RedeemDisabled();
        if (recipient == address(0)) revert ZeroAddress();
        if (arcoUSD.isBlacklisted(recipient)) revert Blacklisted();
        (uint256 assetOut, uint256 arcoUSDUsed) = _toAsset(config, arcoUSDAmount);
        if (assetOut == 0) revert ZeroAmount();

        IERC20Upgradeable(address(arcoUSD)).safeTransferFrom(owner, address(this), arcoUSDUsed);

        uint256 instantGross = availableLiquidity(asset);
        if (instantGross > assetOut) instantGross = assetOut;
        if (!allowQueue && instantGross < assetOut) revert InsufficientLiquidity();
        if (instantGross > 0) {
            assetPaid = _payInstant(owner, recipient, asset, config, instantGross);
        }
        uint256 queuedNet;
        if (assetOut > instantGross) {
            (requestId, queuedNet) = _enqueue(owner, recipient, asset, config, assetOut - instantGross);
        }
        if (assetPaid + queuedNet < minAssetOut) revert MinOut();
    }

    function _payInstant(
        address owner,
        address recipient,
        address asset,
        AssetConfig memory config,
        uint256 gross
    ) internal returns (uint256 net) {
        uint256 fee = (gross * (uint256(config.instantFeeBps) + config.swapFeeBps)) / BPS;
        net = gross - fee;
        uint256 arcoUSDBurned = gross.convertToBase18(config.decimals);
        arcoUSD.burn(arcoUSDBurned);
        IERC20Upgradeable(asset).safeTransfer(recipient, net);
        emit RedeemedInstant(owner, recipient, asset, arcoUSDBurned, net, fee);
    }

    /// @dev The swap fee applies to the queued part too (no swap-fee bypass by queueing): the full
    ///      ArcoUSD of `gross` is escrowed (burned when paid, returned in full on cancel) and the
    ///      net amount is what gets paid; the difference stays in the Reserve.
    function _enqueue(
        address owner,
        address recipient,
        address asset,
        AssetConfig memory config,
        uint256 gross
    ) internal returns (uint256 requestId, uint256 assetAmount) {
        assetAmount = gross - (gross * config.swapFeeBps) / BPS;
        if (assetAmount == 0 || assetAmount < config.minQueued) revert BelowQueueMinimum();
        uint256 arcoUSDEscrowed = gross.convertToBase18(config.decimals);
        requestId = nextRequestId++;
        uint64 requestedAt = uint64(block.timestamp);
        _requests[requestId] = RedeemRequest({
            owner: owner,
            recipient: recipient,
            asset: asset,
            requestedAt: requestedAt,
            status: RequestStatus.Queued,
            arcoUSDAmount: arcoUSDEscrowed,
            assetAmount: assetAmount
        });
        _queue[asset].push(requestId);
        queuedAssets[asset] += assetAmount;
        emit RedeemQueued(requestId, owner, recipient, asset, arcoUSDEscrowed, assetAmount, requestedAt);
    }

    /// @dev ArcoUSD (18 dec) → asset units, rounding down; returns the ArcoUSD actually used so
    ///      sub-unit dust stays with the holder instead of being burned for nothing.
    function _toAsset(
        AssetConfig memory config,
        uint256 arcoUSDAmount
    ) internal pure returns (uint256 assetOut, uint256 arcoUSDUsed) {
        assetOut = arcoUSDAmount.convertFromBase18(config.decimals);
        arcoUSDUsed = assetOut.convertToBase18(config.decimals);
    }

    function _checkPeg(AssetConfig memory config) internal view {
        if (config.priceFeed == address(0)) return;
        uint256 price = IDataFeed(config.priceFeed).getDataInBase18();
        uint256 diff = price > ONE ? price - ONE : ONE - price;
        if (diff * BPS > uint256(config.maxDepegBps) * ONE) revert Depeg();
    }

    /// @dev The allocated asset's free buffer must stay ≥ bufferFloorBps of that asset's own
    ///      backing (its buffer + its strategies), so allocation never empties the USDC that
    ///      redemptions and product buys draw on — and other assets' deposits neither block nor
    ///      loosen it.
    function _checkBufferFloor(address asset) internal view {
        uint8 decimals_ = _assetConfig[asset].decimals;
        uint256 backing = bufferBalance(asset).convertToBase18(decimals_);
        for (uint256 i = 0; i < strategyCount; i++) {
            if (_strategies[i].asset != asset) continue;
            (uint256 value, bool ok) = strategyValue(i);
            if (!ok) revert NavUnavailable();
            backing += value + pendingRecall(i);
        }
        uint256 free = availableLiquidity(asset).convertToBase18(decimals_);
        if (free * BPS < uint256(bufferFloorBps) * backing) revert BufferFloor();
    }

    function _navOf(Strategy storage strategy) internal view returns (uint256 nav) {
        try IDataFeed(strategy.priceFeed).getDataInBase18() returns (uint256 answer) {
            return answer;
        } catch {
            revert NavUnavailable();
        }
    }

    /// @dev The vault's record of a Reserve recall: it must pay the Reserve something.
    function _recordedRecall(
        Strategy storage strategy,
        uint256 vaultRequestId
    ) internal view returns (uint256 assetsOut) {
        address recipient;
        (, recipient, , assetsOut, , , , ) = IArcoRedemptionVaultLike(strategy.redemptionVault)
            .redemptionRequests(vaultRequestId);
        if (assetsOut == 0) revert EmptyRecall();
        if (recipient != address(this)) revert RecallMispriced();
    }

    /// @dev A recall must burn exactly `shares` of the Reserve's product tokens and be worth
    ///      their NAV (± ALLOCATION_TOLERANCE_BPS) — never trust the vault's own figures.
    function _checkRecall(
        Strategy storage strategy,
        uint256 sharesBefore,
        uint256 shares,
        uint256 nav,
        uint256 assets
    ) internal view {
        uint256 sharesAfter = IERC20Upgradeable(strategy.productToken).balanceOf(address(this));
        if (sharesAfter + shares != sharesBefore) revert RecallMispriced();
        uint256 expected = (shares * nav) / ONE;
        uint256 got = assets.convertToBase18(_assetConfig[strategy.asset].decimals);
        if (
            got * BPS < expected * (BPS - ALLOCATION_TOLERANCE_BPS) ||
            got * BPS > expected * (BPS + ALLOCATION_TOLERANCE_BPS)
        ) revert RecallMispriced();
    }

    /// @dev Never trusts the vault's return value: measures the shares that actually arrived.
    function _depositIntoStrategy(
        Strategy storage strategy,
        uint256 assets,
        uint256 minSharesOut
    ) internal returns (uint256 sharesOut) {
        IERC20Upgradeable token = IERC20Upgradeable(strategy.asset);
        IERC20Upgradeable shares = IERC20Upgradeable(strategy.productToken);
        uint256 sharesBefore = shares.balanceOf(address(this));
        token.forceApprove(strategy.depositVault, assets);
        IArcoDepositVaultLike(strategy.depositVault).deposit(assets, minSharesOut, address(this));
        token.forceApprove(strategy.depositVault, 0);
        sharesOut = shares.balanceOf(address(this)) - sharesBefore;
        if (sharesOut == 0 || sharesOut < minSharesOut) revert SharesNotReceived();
    }

    /// @dev The NAV value added must match what left the buffer (± ALLOCATION_TOLERANCE_BPS):
    ///      catches a vault that takes funds without minting, and a mispriced quote such as the
    ///      payment-feed 1:1 bug, which would otherwise be booked as instant profit.
    function _verifyAllocation(
        uint256 strategyId,
        Strategy storage strategy,
        uint256 assets,
        uint256 valueBefore
    ) internal view {
        (uint256 valueAfter, bool ok) = strategyValue(strategyId);
        if (!ok) revert NavUnavailable();
        uint256 added = valueAfter > valueBefore ? valueAfter - valueBefore : 0;
        uint256 expected = assets.convertToBase18(_assetConfig[strategy.asset].decimals);
        if (
            added * BPS < expected * (BPS - ALLOCATION_TOLERANCE_BPS) ||
            added * BPS > expected * (BPS + ALLOCATION_TOLERANCE_BPS)
        ) revert AllocationMispriced();
        if (valueAfter > strategy.maxAllocation) revert StrategyCap();
    }

    function _failRequest(uint256 requestId, RedeemRequest storage request) internal {
        queuedAssets[request.asset] -= request.assetAmount;
        request.status = RequestStatus.PayoutFailed;
        emit RedeemPayoutFailed(requestId, request.recipient, request.asset, request.assetAmount);
    }

    function _strategy(uint256 strategyId) internal view returns (Strategy storage) {
        if (strategyId >= strategyCount) revert UnknownStrategy();
        return _strategies[strategyId];
    }

    function _setParams(
        uint256 mintCap_,
        uint16 mmfTargetBps_,
        uint16 bufferFloorBps_,
        uint32 queueMinDelay_
    ) internal {
        if (mmfTargetBps_ > BPS || bufferFloorBps_ > BPS) revert InvalidParams();
        if (queueMinDelay_ > MAX_QUEUE_MIN_DELAY) revert InvalidParams();
        mintCap = mintCap_;
        mmfTargetBps = mmfTargetBps_;
        bufferFloorBps = bufferFloorBps_;
        queueMinDelay = queueMinDelay_;
        emit ParamsUpdated(mintCap_, mmfTargetBps_, bufferFloorBps_, queueMinDelay_);
    }

    /// @dev ERC-20 transfer that reports failure instead of reverting (queue payouts must not be
    ///      blocked by one recipient). "Paid" means the Reserve's balance went down — judged by
    ///      balance, never by return data — so a request reported as failed (and then cancellable)
    ///      can never have moved funds, whatever the token returns.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        uint256 before = IERC20Upgradeable(token).balanceOf(address(this));
        (bool success, ) = token.call(
            abi.encodeWithSelector(IERC20Upgradeable.transfer.selector, to, amount)
        );
        if (!success) return false;
        return IERC20Upgradeable(token).balanceOf(address(this)) < before;
    }

    /// @dev Probe: does the token move at all for the Reserve? A 1-unit self-transfer (the
    ///      Reserve holds ≥ 1 here). Return data matters for this probe: a paused token that
    ///      returns false must read as "not working", not as a recipient problem.
    function _transfersWork(address token) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Upgradeable.transfer.selector, address(this), 1)
        );
        if (!success) return false;
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (uint256)) == 1;
    }

    /// @dev Same checks as FunctionPausable.whenFnNotPaused, as one shared internal call
    ///      instead of a modifier inlined into every entry point (24KB code limit).
    function _requireFnNotPaused(bytes4 selector) internal view {
        require(!paused(), "FP: paused");
        require(!fnPaused[selector], "FP: fn paused");
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }

    // 15 slots used above + 35 = 50.
    uint256[35] private __gap;
}
