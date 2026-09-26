// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Context} from "../../vendor/swap-vm/src/libs/VM.sol";

/// @notice Builds the arguments of a FixedRateBalances instruction: two tokens and the balances
/// that define the rate between them.
library FixedRateBalancesArgsBuilder {
    function build(address tokenA, uint256 balanceA, address tokenB, uint256 balanceB) internal pure returns (bytes memory) {
        return abi.encodePacked(tokenA, balanceA, tokenB, balanceB);
    }
}

/// @notice Sets the rate registers from the program even when Aqua has already loaded the maker's
/// virtual balances.
/// @dev The official `StaticBalances` refuses to run over preloaded balances, which is right for a
/// signed order and wrong for a term. A buyback clause promises a price, not a curve: "not less than
/// 0.96 per Market Token". With Aqua balances alone, `LimitSwap` would reprice after every fill as
/// the virtual balances shift. This instruction keeps the price fixed and leaves the Aqua balances
/// as what they are in this design — the settlement allowance, drawn down by `pull` and topped up
/// by `push`, so the borrower's exposure is still capped by what it shipped.
abstract contract FixedRateBalances {
    error FixedRateBalancesMissingArgs();
    error FixedRateBalancesTokenMismatch(address tokenIn, address tokenOut);

    /// @param args.tokenA   | 20 bytes
    /// @param args.balanceA | 32 bytes
    /// @param args.tokenB   | 20 bytes
    /// @param args.balanceB | 32 bytes
    function _fixedRateBalances(Context memory ctx, bytes calldata args) internal pure {
        if (args.length < 104) revert FixedRateBalancesMissingArgs();
        address tokenA = address(bytes20(args[0:20]));
        uint256 balanceA = uint256(bytes32(args[20:52]));
        address tokenB = address(bytes20(args[52:72]));
        uint256 balanceB = uint256(bytes32(args[72:104]));
        if (ctx.query.tokenIn == tokenA && ctx.query.tokenOut == tokenB) {
            ctx.swap.balanceIn = balanceA;
            ctx.swap.balanceOut = balanceB;
        } else if (ctx.query.tokenIn == tokenB && ctx.query.tokenOut == tokenA) {
            ctx.swap.balanceIn = balanceB;
            ctx.swap.balanceOut = balanceA;
        } else {
            revert FixedRateBalancesTokenMismatch(ctx.query.tokenIn, ctx.query.tokenOut);
        }
    }
}
