// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockERC20} from "./MockERC20.sol";

/// @notice Six-decimal faucet money, no real USD backing. Separate from the legacy 18-decimal mock.
contract MockUSD is MockERC20 {
    constructor() MockERC20("DEMO Mock USD", "mockUSD") {}
    function decimals() public pure override returns (uint8) { return 6; }
}
