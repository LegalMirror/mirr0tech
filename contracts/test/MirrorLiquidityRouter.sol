// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice A router that tells the hook who is actually trading.
/// @dev The pool manager reports the router as `sender`, so a hook that inspects `sender` inspects
/// the router's eligibility rather than the trader's. This router therefore writes the hook data
/// itself, from `msg.sender`, and never accepts it from the caller. A hook that trusts exactly one
/// router is relying on that substitution being impossible.
contract MirrorLiquidityRouter is IUnlockCallback {
    IPoolManager public immutable poolManager;

    error NotPoolManager();

    enum Op { ModifyLiquidity, Swap }

    struct CallbackData {
        Op op;
        address subject;
        PoolKey key;
        ModifyLiquidityParams liquidity;
        SwapParams swap;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params) external {
        SwapParams memory empty;
        poolManager.unlock(abi.encode(CallbackData(Op.ModifyLiquidity, msg.sender, key, params, empty)));
    }

    function swap(PoolKey calldata key, SwapParams calldata params) external {
        ModifyLiquidityParams memory empty;
        poolManager.unlock(abi.encode(CallbackData(Op.Swap, msg.sender, key, empty, params)));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory data = abi.decode(raw, (CallbackData));
        bytes memory hookData = abi.encode(data.subject);
        BalanceDelta delta;
        if (data.op == Op.ModifyLiquidity) {
            (delta,) = poolManager.modifyLiquidity(data.key, data.liquidity, hookData);
        } else {
            delta = poolManager.swap(data.key, data.swap, hookData);
        }
        _settle(data.key.currency0, data.subject, delta.amount0());
        _settle(data.key.currency1, data.subject, delta.amount1());
        return "";
    }

    function _settle(Currency currency, address subject, int128 amount) private {
        if (amount == 0) return;
        if (amount < 0) {
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(subject, address(poolManager), uint128(-amount));
            poolManager.settle();
        } else {
            poolManager.take(currency, subject, uint128(amount));
        }
    }
}
