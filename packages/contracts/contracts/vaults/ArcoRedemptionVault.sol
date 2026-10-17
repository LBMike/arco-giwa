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

contract ArcoRedemptionVault is MidasAccessControl, FunctionPausable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20MetadataUpgradeable;
    using DecimalsCorrectionLibrary for uint256;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct RedemptionRequest {
        address sender;
        address recipient;
        uint256 sharesIn;
        uint256 assetsOut;
        uint256 productRate;
        uint256 paymentRate;
        bool fulfilled;
        bool claimed;
    }

    IProductToken public productToken;
    IERC20MetadataUpgradeable public paymentToken;
    IDataFeed public productPriceFeed;
    IDataFeed public paymentPriceFeed;
    uint8 public paymentDecimals;
    uint256 public minimumRedeem;
    uint256 public vaultRedeemAllowance;
    uint256 public redeemedByVault;
    uint256 public reservedAssets;
    uint256 public nextRequestId;

    mapping(uint256 requestId => RedemptionRequest request) public redemptionRequests;

    event ProductRedeemInstant(
        address indexed sender,
        address indexed recipient,
        uint256 sharesIn,
        uint256 assetsOut
    );
    event ProductRedeemRequested(
        uint256 indexed requestId,
        address indexed sender,
        address indexed recipient,
        uint256 sharesIn,
        uint256 assetsOut,
        uint256 productRate,
        uint256 paymentRate
    );
    event ProductRedeemFulfilled(uint256 indexed requestId, uint256 assetsOut);
    event ProductRedeemClaimed(
        uint256 indexed requestId,
        address indexed recipient,
        uint256 assetsOut
    );
    event PaymentPriceFeedSet(address indexed previousFeed, address indexed newFeed);

    function initialize(
        address productToken_,
        address paymentToken_,
        address productPriceFeed_,
        address paymentPriceFeed_,
        uint256 minimumRedeem_,
        uint256 vaultRedeemAllowance_,
        address admin
    ) external initializer {
        require(productToken_ != address(0), "ARV: product zero");
        require(paymentToken_ != address(0), "ARV: payment zero");
        require(productPriceFeed_ != address(0), "ARV: product feed zero");
        require(paymentPriceFeed_ != address(0), "ARV: payment feed zero");
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
        __ReentrancyGuard_init();
        productToken = IProductToken(productToken_);
        paymentToken = IERC20MetadataUpgradeable(paymentToken_);
        productPriceFeed = IDataFeed(productPriceFeed_);
        paymentPriceFeed = IDataFeed(paymentPriceFeed_);
        paymentDecimals = IERC20MetadataUpgradeable(paymentToken_).decimals();
        minimumRedeem = minimumRedeem_;
        vaultRedeemAllowance = vaultRedeemAllowance_;
        nextRequestId = 1;
    }

    function quoteRedeem(uint256 sharesIn) public view returns (uint256 assetsOut) {
        (assetsOut, , ) = _quoteRedeem(sharesIn);
    }

    function redeemInstant(
        uint256 sharesIn,
        uint256 minAssetsOut,
        address recipient
    )
        external
        nonReentrant
        whenFnNotPaused(this.redeemInstant.selector)
        returns (uint256 assetsOut)
    {
        require(recipient != address(0), "ARV: recipient zero");
        require(sharesIn >= minimumRedeem, "ARV: below minimum");
        assetsOut = quoteRedeem(sharesIn);
        require(assetsOut >= minAssetsOut, "ARV: min assets");
        _validateRedeem(assetsOut);
        redeemedByVault += assetsOut;
        productToken.burn(_msgSender(), sharesIn);
        paymentToken.safeTransfer(recipient, assetsOut);
        emit ProductRedeemInstant(_msgSender(), recipient, sharesIn, assetsOut);
    }

    function requestRedeem(
        uint256 sharesIn,
        uint256 minAssetsOut,
        address recipient
    )
        external
        nonReentrant
        whenFnNotPaused(this.requestRedeem.selector)
        returns (uint256 requestId)
    {
        require(recipient != address(0), "ARV: recipient zero");
        require(sharesIn >= minimumRedeem, "ARV: below minimum");
        (uint256 assetsOut, uint256 productRate, uint256 paymentRate) = _quoteRedeem(sharesIn);
        require(assetsOut >= minAssetsOut, "ARV: min assets");
        require(redeemedByVault + assetsOut <= vaultRedeemAllowance, "ARV: vault allowance");
        productToken.burn(_msgSender(), sharesIn);

        requestId = nextRequestId++;
        redemptionRequests[requestId] = RedemptionRequest({
            sender: _msgSender(),
            recipient: recipient,
            sharesIn: sharesIn,
            assetsOut: assetsOut,
            productRate: productRate,
            paymentRate: paymentRate,
            fulfilled: false,
            claimed: false
        });
        emit ProductRedeemRequested(
            requestId,
            _msgSender(),
            recipient,
            sharesIn,
            assetsOut,
            productRate,
            paymentRate
        );
    }

    function fulfillRedeem(
        uint256 requestId
    )
        external
        onlyRole(MidasAccessControlRoles.REDEMPTION_VAULT_ADMIN_ROLE)
        nonReentrant
        whenFnNotPaused(this.fulfillRedeem.selector)
    {
        RedemptionRequest storage request = redemptionRequests[requestId];
        require(request.sender != address(0), "ARV: unknown request");
        require(!request.fulfilled, "ARV: fulfilled");
        _validateLiquidity(request.assetsOut);
        request.fulfilled = true;
        redeemedByVault += request.assetsOut;
        reservedAssets += request.assetsOut;
        emit ProductRedeemFulfilled(requestId, request.assetsOut);
    }

    function claimRedeem(
        uint256 requestId
    ) external nonReentrant whenFnNotPaused(this.claimRedeem.selector) {
        RedemptionRequest storage request = redemptionRequests[requestId];
        require(request.sender != address(0), "ARV: unknown request");
        require(request.fulfilled, "ARV: not fulfilled");
        require(!request.claimed, "ARV: claimed");
        require(_msgSender() == request.recipient, "ARV: not recipient");
        request.claimed = true;
        reservedAssets -= request.assetsOut;
        paymentToken.safeTransfer(request.recipient, request.assetsOut);
        emit ProductRedeemClaimed(requestId, request.recipient, request.assetsOut);
    }

    function setLimits(
        uint256 minimumRedeem_,
        uint256 vaultRedeemAllowance_
    ) external onlyRole(MidasAccessControlRoles.REDEMPTION_VAULT_ADMIN_ROLE) {
        minimumRedeem = minimumRedeem_;
        vaultRedeemAllowance = vaultRedeemAllowance_;
    }

    function _quoteRedeem(
        uint256 sharesIn
    ) internal view returns (uint256 assetsOut, uint256 productRate, uint256 paymentRate) {
        productRate = productPriceFeed.getDataInBase18();
        paymentRate = paymentPriceFeed.getDataInBase18();
        uint256 assetsBase18 = (sharesIn * productRate) / paymentRate;
        assetsOut = assetsBase18.convertFromBase18(paymentDecimals);
    }

    function _validateRedeem(uint256 assetsOut) internal view {
        require(redeemedByVault + assetsOut <= vaultRedeemAllowance, "ARV: vault allowance");
        _validateLiquidity(assetsOut);
    }

    function _validateLiquidity(uint256 assetsOut) internal view {
        require(
            paymentToken.balanceOf(address(this)) >= reservedAssets + assetsOut,
            "ARV: liquidity"
        );
    }

    /// @notice Point the vault at a new payment-asset feed. Repairs vaults initialized with the
    ///         product feed as both feeds, which priced every quote 1:1 regardless of NAV.
    /// @dev Upgrade-safe: writes the existing paymentPriceFeed slot only (no new storage).
    ///      Open requests keep the rates locked at request time. DEFAULT_ADMIN_ROLE only; on
    ///      mainnet that is the multisig.
    function setPaymentPriceFeed(
        address paymentPriceFeed_
    ) external onlyRole(MidasAccessControlRoles.DEFAULT_ADMIN_ROLE) {
        require(paymentPriceFeed_ != address(0), "ARV: payment feed zero");
        require(paymentPriceFeed_ != address(productPriceFeed), "ARV: same as product feed");
        require(IDataFeed(paymentPriceFeed_).getDataInBase18() > 0, "ARV: payment feed answer zero");
        emit PaymentPriceFeedSet(address(paymentPriceFeed), paymentPriceFeed_);
        paymentPriceFeed = IDataFeed(paymentPriceFeed_);
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }
}
