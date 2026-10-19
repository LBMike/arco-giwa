// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {
    SafeERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {MathUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {IArcoUSD} from "./IArcoUSDInterfaces.sol";

/// @title SArcoUSD
/// @notice The Savings vault: deposit ArcoUSD, hold sArcoUSD (ERC-4626, 18 decimals, EIP-2612
///         permit) whose price rises as yield arrives. The vault holds only ArcoUSD — withdrawals
///         are always instant, straight to the receiver. Yield is Reserve surplus, minted and added
///         by ArcoUSDSavingsDistributor (or topped up by an operator), and released into the share
///         price second by second over `vestingPeriod`. Spec: docs/specs/arcousd-v1.md §3.13.
/// @dev - totalAssets = ArcoUSD balance − rewards not yet vested, so a reward never jumps the
///        price (no deposit-before / withdraw-after capture) and accrues per second.
///      - Total shares are 0 or ≥ MIN_SHARES: the first-depositor (donation) inflation attack would
///        need a donation ~MIN_SHARES times the victim's deposit, without a decimals offset (shares
///        keep ArcoUSD's 18 decimals). Deposits open only through seed(), which mints MIN_SHARES to
///        SEED_HOLDER at 1:1 in the same call — nothing can be front-run between deploy and seed.
///      - cumulativeAssetSeconds() integrates totalAssets over time (checkpointed on every state
///        change) so the distributor caps yield on the time-weighted average, which a deposit made
///        just before a distribution cannot inflate.
///      - Follows ArcoUSD's blacklist (no list of its own): a blacklisted address cannot receive,
///        send or redeem shares, nor move shares through an allowance — so it cannot hand shares
///        to a clean address to get ArcoUSD out.
///      - Share transfers are never paused (as ArcoUSD); pause stops deposit/mint, withdraw/redeem
///        and addRewards, and the matching max* views return 0 while paused (ERC-4626).
contract SArcoUSD is
    ERC20PermitUpgradeable,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    FunctionPausable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    bytes32 public constant REWARDER_ROLE = keccak256("REWARDER_ROLE");
    uint256 public constant MIN_SHARES = 1e18;
    uint64 public constant MIN_VESTING_PERIOD = 1 hours;
    uint64 public constant MAX_VESTING_PERIOD = 30 days;
    /// @notice Holder of the seed shares (nobody can redeem them).
    address public constant SEED_HOLDER = 0x000000000000000000000000000000000000dEaD;

    /// @notice Rewards being released in the current vesting window (re-based on every addRewards).
    uint256 public vestingAmount;
    /// @notice Start of the current vesting window.
    uint64 public vestingStart;
    /// @notice Length of a vesting window, in seconds.
    uint64 public vestingPeriod;
    /// @dev Time of the last asset checkpoint (packed with the two fields above).
    uint64 private _checkpointAt;
    /// @dev ∫ totalAssets dt up to _checkpointAt.
    uint256 private _assetSeconds;
    /// @dev totalAssets right after the last checkpointed state change.
    uint256 private _checkpointAssets;

    event RewardsAdded(address indexed caller, uint256 amount, uint256 vestingAmount, uint64 vestingPeriod);
    event VestingPeriodUpdated(uint64 vestingPeriod);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Seeded(address indexed caller, address indexed holder, uint256 assets);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidParams();
    error NoDepositors();
    error MinSharesViolation();
    error Blacklisted();
    error CannotRescueAsset();
    error AlreadySeeded();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address arcoUSD_, address admin, uint64 vestingPeriod_) external initializer {
        if (arcoUSD_ == address(0) || admin == address(0)) revert ZeroAddress();
        __ERC20_init("sArcoUSD", "sArcoUSD");
        __ERC20Permit_init("sArcoUSD");
        __ERC4626_init(IERC20Upgradeable(arcoUSD_));
        __AccessControl_init();
        __FunctionPausable_init();
        __ReentrancyGuard_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MidasAccessControlRoles.PAUSER_ROLE, admin);
        _grantRole(REWARDER_ROLE, admin); // operator top-ups; the deploy also grants the distributor
        _setVestingPeriod(vestingPeriod_);
        _checkpointAt = uint64(block.timestamp);
        // Closed until seed() mints the floor shares in the same call that opens deposits.
        fnPaused[this.deposit.selector] = true;
        emit FunctionPaused(this.deposit.selector, admin);
    }

    /// @dev Integrate totalAssets up to now before a state change, and record it after.
    modifier checkpointed() {
        _assetSeconds = cumulativeAssetSeconds();
        _checkpointAt = uint64(block.timestamp);
        _;
        _checkpointAssets = totalAssets();
    }

    /// @notice Mint MIN_SHARES to SEED_HOLDER for exactly MIN_SHARES ArcoUSD (1:1, whatever was sent
    ///         here before — that stays with the seed shares) and open deposits. Once, while the
    ///         supply is 0. With the floor held by nobody, every real holder can always exit in full.
    function seed() external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) checkpointed {
        if (totalSupply() != 0) revert AlreadySeeded();
        IERC20Upgradeable(asset()).safeTransferFrom(_msgSender(), address(this), MIN_SHARES);
        _mint(SEED_HOLDER, MIN_SHARES);
        emit Deposit(_msgSender(), SEED_HOLDER, MIN_SHARES, MIN_SHARES);
        emit Seeded(_msgSender(), SEED_HOLDER, MIN_SHARES);
        fnPaused[this.deposit.selector] = false;
        emit FunctionUnpaused(this.deposit.selector, _msgSender());
    }

    /// @notice ∫ totalAssets dt (ArcoUSD·seconds) since deployment, sampled at every deposit,
    ///         withdrawal and reward (vesting between samples is not counted: conservative).
    function cumulativeAssetSeconds() public view returns (uint256) {
        return _assetSeconds + _checkpointAssets * (block.timestamp - _checkpointAt);
    }

    // ─────────────────────────────── yield ───────────────────────────────

    /// @notice Add `amount` ArcoUSD of yield (pulled from the caller). It is released into the share
    ///         price over `vestingPeriod`, together with whatever was still unvested.
    function addRewards(
        uint256 amount
    ) external nonReentrant onlyRole(REWARDER_ROLE) whenFnNotPaused(this.addRewards.selector) checkpointed {
        if (amount == 0) revert ZeroAmount();
        // With no depositors the reward would go to whoever deposits first.
        if (totalSupply() < MIN_SHARES) revert NoDepositors();
        uint256 remaining = unvestedAmount();
        IERC20Upgradeable token = IERC20Upgradeable(asset());
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(_msgSender(), address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        vestingAmount = remaining + received;
        vestingStart = uint64(block.timestamp);
        emit RewardsAdded(_msgSender(), received, vestingAmount, vestingPeriod);
    }

    /// @notice Rewards not yet released into the share price (rounded up: never over-counted as assets).
    function unvestedAmount() public view returns (uint256) {
        uint256 elapsed = block.timestamp - vestingStart;
        if (elapsed >= vestingPeriod) return 0;
        return MathUpgradeable.mulDiv(vestingAmount, vestingPeriod - elapsed, vestingPeriod, MathUpgradeable.Rounding.Up);
    }

    /// @notice ArcoUSD released into the share price per second right now (0 when nothing is vesting).
    function rewardRate() external view returns (uint256) {
        if (block.timestamp - vestingStart >= vestingPeriod) return 0;
        return vestingAmount / vestingPeriod;
    }

    /// @notice When the current vesting window ends.
    function vestingEnd() external view returns (uint256) {
        return uint256(vestingStart) + vestingPeriod;
    }

    // ───────────────────────────── ERC-4626 ──────────────────────────────

    function totalAssets() public view override returns (uint256) {
        uint256 balance = IERC20Upgradeable(asset()).balanceOf(address(this));
        uint256 unvested = unvestedAmount();
        return balance > unvested ? balance - unvested : 0;
    }

    function decimals() public view override(ERC20Upgradeable, ERC4626Upgradeable) returns (uint8) {
        return ERC4626Upgradeable.decimals();
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant whenFnNotPaused(this.deposit.selector) checkpointed returns (uint256) {
        return super.deposit(assets, receiver);
    }

    /// @dev Follows the `deposit` pause switch.
    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant whenFnNotPaused(this.deposit.selector) checkpointed returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant whenFnNotPaused(this.withdraw.selector) checkpointed returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    /// @dev Follows the `withdraw` pause switch.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant whenFnNotPaused(this.withdraw.selector) checkpointed returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (_isPaused(this.deposit.selector) || _blacklisted(receiver)) return 0;
        return super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (_isPaused(this.deposit.selector) || _blacklisted(receiver)) return 0;
        return super.maxMint(receiver);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (_isPaused(this.withdraw.selector) || _blacklisted(owner)) return 0;
        return _convertToAssets(_redeemableShares(owner), MathUpgradeable.Rounding.Down);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (_isPaused(this.withdraw.selector) || _blacklisted(owner)) return 0;
        return _redeemableShares(owner);
    }

    // ───────────────────────────── admin ─────────────────────────────────

    /// @notice Change the vesting window. What vested so far is kept; what is still unvested is
    ///         re-spread over the new period from now.
    function setVestingPeriod(uint64 period) external onlyRole(DEFAULT_ADMIN_ROLE) checkpointed {
        vestingAmount = unvestedAmount();
        vestingStart = uint64(block.timestamp);
        _setVestingPeriod(period);
    }

    /// @notice Recover a token sent here by mistake. Never ArcoUSD (the depositors' assets).
    function rescue(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == asset()) revert CannotRescueAsset();
        if (to == address(0)) revert ZeroAddress();
        IERC20Upgradeable(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ──────────────────────────── internals ──────────────────────────────

    /// @dev A blacklisted spender cannot move someone else's shares through an old allowance.
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override(ERC20Upgradeable, IERC20Upgradeable) returns (bool) {
        _requireNotBlacklisted(_msgSender());
        return super.transferFrom(from, to, amount);
    }

    /// @dev Redeeming on someone's behalf spends their allowance: the caller must not be blacklisted.
    ///      The receiver is checked up front for a clear error (ArcoUSD would refuse the transfer anyway).
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (caller != owner) _requireNotBlacklisted(caller);
        _requireNotBlacklisted(receiver);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal override {
        super._beforeTokenTransfer(from, to, amount);
        if (from != address(0)) _requireNotBlacklisted(from);
        if (to != address(0)) _requireNotBlacklisted(to);
    }

    /// @dev After every mint/burn the supply is 0 or at least MIN_SHARES.
    function _afterTokenTransfer(address from, address to, uint256 amount) internal override {
        super._afterTokenTransfer(from, to, amount);
        if (from == address(0) || to == address(0)) {
            uint256 supply = totalSupply();
            if (supply != 0 && supply < MIN_SHARES) revert MinSharesViolation();
        }
    }

    /// @dev Shares `owner` can redeem without leaving a non-zero supply below MIN_SHARES.
    function _redeemableShares(address owner) internal view returns (uint256) {
        uint256 shares = balanceOf(owner);
        uint256 supply = totalSupply();
        uint256 rest = supply - shares;
        if (rest == 0 || rest >= MIN_SHARES) return shares;
        return supply > MIN_SHARES ? supply - MIN_SHARES : 0;
    }

    function _setVestingPeriod(uint64 period) internal {
        if (period < MIN_VESTING_PERIOD || period > MAX_VESTING_PERIOD) revert InvalidParams();
        vestingPeriod = period;
        emit VestingPeriodUpdated(period);
    }

    function _isPaused(bytes4 selector) internal view returns (bool) {
        return paused() || fnPaused[selector];
    }

    function _blacklisted(address account) internal view returns (bool) {
        return IArcoUSD(asset()).isBlacklisted(account);
    }

    function _requireNotBlacklisted(address account) internal view {
        if (_blacklisted(account)) revert Blacklisted();
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }

    // 4 slots used above (vestingAmount; vestingStart + vestingPeriod + _checkpointAt; _assetSeconds;
    // _checkpointAssets) + 46 = 50.
    uint256[46] private __gap;
}
