// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {
    IERC20MetadataUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import {
    SafeERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {MidasAccessControl} from "../access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "../access/MidasAccessControlRoles.sol";
import {FunctionPausable} from "../access/FunctionPausable.sol";
import {DecimalsCorrectionLibrary} from "../libraries/DecimalsCorrectionLibrary.sol";
import {IDataFeed} from "../interfaces/IDataFeed.sol";
import {IProductToken} from "../interfaces/IProductToken.sol";

/// @notice Frozen copy of the LIVE ArcoDepositVault implementation (withdrawTo, no
///         setPaymentPriceFeed). Test-only: proves the payment-feed upgrade is layout-safe
///         and repairs a vault initialized with the product feed twice.
contract ArcoDepositVaultLiveLayout is MidasAccessControl, FunctionPausable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20MetadataUpgradeable;
    using DecimalsCorrectionLibrary for uint256;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct DepositRequest {
        address sender;
        address recipient;
        uint256 paymentAssets;
        uint256 sharesOut;
        uint256 paymentRate;
        uint256 productRate;
        bool fulfilled;
    }

    IProductToken public productToken;
    IERC20MetadataUpgradeable public paymentToken;
    IDataFeed public productPriceFeed;
    IDataFeed public paymentPriceFeed;
    uint8 public paymentDecimals;
    uint256 public minimumDeposit;
    uint256 public maxSupplyCap;
    uint256 public vaultMintAllowance;
    uint256 public mintedByVault;
    uint256 public nextRequestId;

    mapping(uint256 requestId => DepositRequest request) public depositRequests;

    event ProductDeposit(
        address indexed sender,
        address indexed recipient,
        uint256 paymentAssets,
        uint256 sharesOut
    );
    event ProductDepositRequested(
        uint256 indexed requestId,
        address indexed sender,
        address indexed recipient,
        uint256 paymentAssets,
        uint256 sharesOut,
        uint256 paymentRate,
        uint256 productRate
    );
    event ProductDepositFulfilled(
        uint256 indexed requestId,
        address indexed recipient,
        uint256 sharesOut
    );
    event VaultWithdrawal(address indexed to, uint256 amount);

    function initialize(
        address productToken_,
        address paymentToken_,
        address productPriceFeed_,
        address paymentPriceFeed_,
        uint256 minimumDeposit_,
        uint256 maxSupplyCap_,
        uint256 vaultMintAllowance_,
        address admin
    ) external initializer {
        require(productToken_ != address(0), "ADV: product zero");
        require(paymentToken_ != address(0), "ADV: payment zero");
        require(productPriceFeed_ != address(0), "ADV: product feed zero");
        require(paymentPriceFeed_ != address(0), "ADV: payment feed zero");
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
        __ReentrancyGuard_init();
        productToken = IProductToken(productToken_);
        paymentToken = IERC20MetadataUpgradeable(paymentToken_);
        productPriceFeed = IDataFeed(productPriceFeed_);
        paymentPriceFeed = IDataFeed(paymentPriceFeed_);
        paymentDecimals = IERC20MetadataUpgradeable(paymentToken_).decimals();
        minimumDeposit = minimumDeposit_;
        maxSupplyCap = maxSupplyCap_;
        vaultMintAllowance = vaultMintAllowance_;
        nextRequestId = 1;
    }

    function quoteDeposit(uint256 paymentAssets) public view returns (uint256 sharesOut) {
        (sharesOut, , ) = _quoteDeposit(paymentAssets);
    }

    function deposit(
        uint256 paymentAssets,
        uint256 minSharesOut,
        address recipient
    ) external nonReentrant whenFnNotPaused(this.deposit.selector) returns (uint256 sharesOut) {
        require(recipient != address(0), "ADV: recipient zero");
        require(paymentAssets >= minimumDeposit, "ADV: below minimum");
        sharesOut = quoteDeposit(paymentAssets);
        require(sharesOut >= minSharesOut, "ADV: min shares");
        _validateMint(sharesOut);
        mintedByVault += sharesOut;
        paymentToken.safeTransferFrom(_msgSender(), address(this), paymentAssets);
        productToken.mint(recipient, sharesOut);
        emit ProductDeposit(_msgSender(), recipient, paymentAssets, sharesOut);
    }

    function requestDeposit(
        uint256 paymentAssets,
        uint256 minSharesOut,
        address recipient
    )
        external
        nonReentrant
        whenFnNotPaused(this.requestDeposit.selector)
        returns (uint256 requestId)
    {
        require(recipient != address(0), "ADV: recipient zero");
        require(paymentAssets >= minimumDeposit, "ADV: below minimum");
        (uint256 sharesOut, uint256 paymentRate, uint256 productRate) = _quoteDeposit(
            paymentAssets
        );
        require(sharesOut >= minSharesOut, "ADV: min shares");
        _validateMint(sharesOut);
        paymentToken.safeTransferFrom(_msgSender(), address(this), paymentAssets);

        requestId = nextRequestId++;
        depositRequests[requestId] = DepositRequest({
            sender: _msgSender(),
            recipient: recipient,
            paymentAssets: paymentAssets,
            sharesOut: sharesOut,
            paymentRate: paymentRate,
            productRate: productRate,
            fulfilled: false
        });
        emit ProductDepositRequested(
            requestId,
            _msgSender(),
            recipient,
            paymentAssets,
            sharesOut,
            paymentRate,
            productRate
        );
    }

    function fulfillDeposit(
        uint256 requestId
    )
        external
        onlyRole(MidasAccessControlRoles.DEPOSIT_VAULT_ADMIN_ROLE)
        nonReentrant
        whenFnNotPaused(this.fulfillDeposit.selector)
    {
        DepositRequest storage request = depositRequests[requestId];
        require(request.sender != address(0), "ADV: unknown request");
        require(!request.fulfilled, "ADV: fulfilled");
        _validateMint(request.sharesOut);
        request.fulfilled = true;
        mintedByVault += request.sharesOut;
        productToken.mint(request.recipient, request.sharesOut);
        emit ProductDepositFulfilled(requestId, request.recipient, request.sharesOut);
    }

    function setLimits(
        uint256 minimumDeposit_,
        uint256 maxSupplyCap_,
        uint256 vaultMintAllowance_
    ) external onlyRole(MidasAccessControlRoles.DEPOSIT_VAULT_ADMIN_ROLE) {
        minimumDeposit = minimumDeposit_;
        maxSupplyCap = maxSupplyCap_;
        vaultMintAllowance = vaultMintAllowance_;
    }

    /// @notice Admin withdrawal of pooled payment assets (e.g. to settle redemptions off-vault).
    /// @dev CUSTODY POINT: this moves user deposits out of the vault. On mainnet,
    ///      DEPOSIT_VAULT_ADMIN_ROLE and the ProxyAdmin owner MUST both be the multisig —
    ///      never an EOA. Storage-layout safe: no new or reordered storage variables.
    function withdrawTo(
        address to,
        uint256 amount
    )
        external
        onlyRole(MidasAccessControlRoles.DEPOSIT_VAULT_ADMIN_ROLE)
        nonReentrant
        whenFnNotPaused(this.withdrawTo.selector)
    {
        require(to != address(0), "ADV: to zero");
        paymentToken.safeTransfer(to, amount);
        emit VaultWithdrawal(to, amount);
    }

    function _quoteDeposit(
        uint256 paymentAssets
    ) internal view returns (uint256 sharesOut, uint256 paymentRate, uint256 productRate) {
        paymentRate = paymentPriceFeed.getDataInBase18();
        productRate = productPriceFeed.getDataInBase18();
        uint256 paymentBase18 = paymentAssets.convertToBase18(paymentDecimals);
        sharesOut = (paymentBase18 * paymentRate) / productRate;
    }

    function _validateMint(uint256 sharesOut) internal view {
        require(productToken.totalSupply() + sharesOut <= maxSupplyCap, "ADV: max supply");
        require(mintedByVault + sharesOut <= vaultMintAllowance, "ADV: vault allowance");
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }
}
