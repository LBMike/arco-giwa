// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IDataFeed {
    function getDataInBase18() external view returns (uint256 answer);
}
