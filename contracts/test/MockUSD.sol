// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Six-decimal faucet money, no real USD backing. Separate from the legacy 18-decimal mock.
contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD Coin", "mUSDC") {}
    function decimals() public pure override returns (uint8) { return 6; }

    /// @notice Anyone can mint any amount to any recipient. Testnet faucet: no role, cap or cooldown.
    /// @param amount Amount in six-decimal base units (1 mUSDC = 1_000_000).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
