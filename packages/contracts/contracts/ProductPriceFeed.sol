// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.28;

import {MidasAccessControl} from "./access/MidasAccessControl.sol";
import {MidasAccessControlRoles} from "./access/MidasAccessControlRoles.sol";
import {FunctionPausable} from "./access/FunctionPausable.sol";
import {DecimalsCorrectionLibrary} from "./libraries/DecimalsCorrectionLibrary.sol";
import {IDataFeed} from "./interfaces/IDataFeed.sol";

contract ProductPriceFeed is MidasAccessControl, FunctionPausable, IDataFeed {
    using DecimalsCorrectionLibrary for uint256;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct RoundData {
        uint80 roundId;
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
        uint80 answeredInRound;
    }

    uint8 public feedDecimals;
    uint256 public healthyDiff;
    uint256 public minExpectedAnswer;
    uint256 public maxExpectedAnswer;
    uint256 public maxDeviationBps;
    RoundData private _latestRound;

    event PriceUpdated(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    function initialize(
        uint8 feedDecimals_,
        int256 initialAnswer,
        uint256 healthyDiff_,
        uint256 minExpectedAnswer_,
        uint256 maxExpectedAnswer_,
        uint256 maxDeviationBps_,
        address admin
    ) external initializer {
        require(initialAnswer > 0, "PPF: answer <= 0");
        require(maxExpectedAnswer_ > minExpectedAnswer_, "PPF: bad bounds");
        __MidasAccessControl_init(admin);
        __FunctionPausable_init();
        feedDecimals = feedDecimals_;
        healthyDiff = healthyDiff_;
        minExpectedAnswer = minExpectedAnswer_;
        maxExpectedAnswer = maxExpectedAnswer_;
        maxDeviationBps = maxDeviationBps_;
        _setRoundData(initialAnswer);
    }

    function decimals() external view returns (uint8) {
        return feedDecimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        RoundData memory round = _latestRound;
        return (
            round.roundId,
            round.answer,
            round.startedAt,
            round.updatedAt,
            round.answeredInRound
        );
    }

    function getDataInBase18() external view override returns (uint256 answer) {
        RoundData memory round = _latestRound;
        require(round.answer > 0, "PPF: answer <= 0");
        require(block.timestamp - round.updatedAt <= healthyDiff, "PPF: stale");
        uint256 rawAnswer = uint256(round.answer);
        require(
            rawAnswer >= minExpectedAnswer && rawAnswer <= maxExpectedAnswer,
            "PPF: outside bounds"
        );
        return rawAnswer.convertToBase18(feedDecimals);
    }

    function setRoundDataSafe(
        int256 answer
    )
        external
        onlyRole(MidasAccessControlRoles.FEED_ADMIN_ROLE)
        whenFnNotPaused(this.setRoundDataSafe.selector)
    {
        require(answer > 0, "PPF: answer <= 0");
        uint256 next = uint256(answer);
        require(next >= minExpectedAnswer && next <= maxExpectedAnswer, "PPF: outside bounds");
        if (_latestRound.answer > 0 && maxDeviationBps > 0) {
            uint256 prev = uint256(_latestRound.answer);
            uint256 diff = prev > next ? prev - next : next - prev;
            require((diff * 10_000) / prev <= maxDeviationBps, "PPF: deviation");
        }
        _setRoundData(answer);
    }

    function setExpectedAnswers(
        uint256 minExpectedAnswer_,
        uint256 maxExpectedAnswer_
    ) external onlyRole(MidasAccessControlRoles.FEED_ADMIN_ROLE) {
        require(maxExpectedAnswer_ > minExpectedAnswer_, "PPF: bad bounds");
        minExpectedAnswer = minExpectedAnswer_;
        maxExpectedAnswer = maxExpectedAnswer_;
    }

    function setHealthyDiff(
        uint256 healthyDiff_
    ) external onlyRole(MidasAccessControlRoles.FEED_ADMIN_ROLE) {
        healthyDiff = healthyDiff_;
    }

    function _setRoundData(int256 answer) private {
        uint80 nextRoundId = _latestRound.roundId + 1;
        _latestRound = RoundData({
            roundId: nextRoundId,
            answer: answer,
            startedAt: block.timestamp,
            updatedAt: block.timestamp,
            answeredInRound: nextRoundId
        });
        emit PriceUpdated(nextRoundId, answer, block.timestamp);
    }

    function _requirePauseAdmin() internal view override {
        _checkRole(MidasAccessControlRoles.PAUSER_ROLE, _msgSender());
    }
}
