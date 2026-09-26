// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CompiledPolicy} from "../generated/CompiledPolicy.sol";
import {CompiledCashierTerms as Terms} from "../generated/CompiledCashierTerms.sol";
import {CashierConfig} from "./CashierConfig.sol";

interface ICashierQuote {
    function asset() external view returns (address);
    function clearApproval() external;
    function quote(bool buy, uint256 amountIn) external view returns (uint256);
}

/// @notice Atomic execution comparison, not a spot-price oracle. Identity is always msg.sender.
/// @dev The AMM attempt is a reverting self-call: PoolManager ticks, balances and transient state
/// roll back together. Only an output-bound failure triggers fallback; policy/settlement errors do not.
contract MirrorCashierRouter is IUnlockCallback {
    using SafeERC20 for IERC20;
    IPoolManager public immutable poolManager;
    bytes32 public immutable configurationHash;
    uint16 public immutable executionClauseId;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    enum Route { Auto, Amm, Cashier }
    struct Order { address subject; PoolKey key; SwapParams params; uint256 minOut; Route route; }
    bool private entered;
    address private payingHook;
    address private payer;
    Currency private input;
    uint256 private inputAmount;
    error Unauthorized();
    error InvalidPool();
    error AmmBelowBound();
    // reason: 1 unsupported input; 4 slippage/partial fill; 5 expired deadline.
    error ExecutionRefused(uint16 clauseId, bytes32 policyHash, uint8 reason);
    event Executed(address indexed subject, Route route, uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager manager_, CashierConfig.Parameters memory config) {
        CashierConfig.validate(config, Terms.CONFIGURATION_HASH);
        if (address(manager_).code.length == 0) revert Unauthorized();
        poolManager = manager_;
        configurationHash = Terms.CONFIGURATION_HASH;
        executionClauseId = config.clauseIds.cashierExecution;
        poolFee = config.pool.fee;
        tickSpacing = config.pool.tickSpacing;
    }
    modifier lock() { if (entered) revert Unauthorized(); entered = true; _; entered = false; }
    function _refuse(uint8 reason) private view {
        revert ExecutionRefused(executionClauseId, CompiledPolicy.POLICY_HASH, reason);
    }
    function _checkPool(PoolKey calldata key) private view {
        if (key.fee != poolFee || key.tickSpacing != tickSpacing) revert InvalidPool();
    }
    function swap(PoolKey calldata key, SwapParams calldata params, uint256 minOut, uint256 deadline, Route route)
        external lock returns (uint256 amountOut) {
        _checkPool(key);
        if (deadline < block.timestamp) _refuse(5);
        if (params.amountSpecified >= 0 || params.amountSpecified < -int256(type(int128).max) || minOut == 0) _refuse(1);
        return abi.decode(poolManager.unlock(abi.encode(false, abi.encode(Order(msg.sender, key, params, minOut, route)))), (uint256));
    }
    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params) external lock {
        _checkPool(key);
        poolManager.unlock(abi.encode(true, abi.encode(msg.sender, key, params)));
    }
    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !entered) revert Unauthorized();
        (bool liquidity, bytes memory data) = abi.decode(raw, (bool, bytes));
        if (liquidity) {
            (address subject, PoolKey memory key, ModifyLiquidityParams memory params) = abi.decode(data, (address, PoolKey, ModifyLiquidityParams));
            (BalanceDelta delta,) = poolManager.modifyLiquidity(key, params, abi.encode(subject));
            _settle(key.currency0, subject, delta.amount0());
            _settle(key.currency1, subject, delta.amount1());
            ICashierQuote(address(key.hooks)).clearApproval();
            return "";
        }
        Order memory order = abi.decode(data, (Order));
        uint256 amountIn = uint256(-order.params.amountSpecified);
        uint256 bound = order.minOut;
        if (order.route == Route.Auto) {
            ICashierQuote hook = ICashierQuote(address(order.key.hooks));
            bool buy = Currency.unwrap(order.params.zeroForOne ? order.key.currency0 : order.key.currency1) == hook.asset();
            uint256 navOut = hook.quote(buy, amountIn);
            if (navOut > bound) bound = navOut;
        }
        if (order.route != Route.Cashier) {
            try this.attemptAmm(order, bound) returns (uint256 out) {
                emit Executed(order.subject, Route.Amm, amountIn, out);
                return abi.encode(out);
            } catch (bytes memory reason) {
                if (bytes4(reason) != AmmBelowBound.selector) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
                if (order.route == Route.Amm) _refuse(4);
            }
        }
        payingHook = address(order.key.hooks);
        payer = order.subject;
        input = order.params.zeroForOne ? order.key.currency0 : order.key.currency1;
        inputAmount = amountIn;
        BalanceDelta result = poolManager.swap(order.key, order.params, abi.encode(order.subject, true));
        if (payingHook != address(0)) revert Unauthorized();
        uint256 output = _output(order, result, order.minOut, false);
        // Input was prepaid by payInput inside beforeSwap, output is the only unsettled leg.
        poolManager.take(order.params.zeroForOne ? order.key.currency1 : order.key.currency0, order.subject, output);
        ICashierQuote(address(order.key.hooks)).clearApproval();
        delete payer; input = Currency.wrap(address(0)); delete inputAmount;
        emit Executed(order.subject, Route.Cashier, amountIn, output);
        return abi.encode(output);
    }
    function attemptAmm(Order calldata order, uint256 bound) external returns (uint256 output) {
        if (msg.sender != address(this)) revert Unauthorized();
        BalanceDelta delta = poolManager.swap(order.key, order.params, abi.encode(order.subject, false));
        output = _output(order, delta, bound, true);
        _settle(order.key.currency0, order.subject, delta.amount0());
        _settle(order.key.currency1, order.subject, delta.amount1());
        ICashierQuote(address(order.key.hooks)).clearApproval();
    }
    function _output(Order memory order, BalanceDelta delta, uint256 bound, bool trial) private view returns (uint256) {
        int128 spent = order.params.zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = order.params.zeroForOne ? delta.amount1() : delta.amount0();
        if (int256(spent) != order.params.amountSpecified || received <= 0 || uint256(uint128(received)) < bound) {
            if (trial) revert AmmBelowBound();
            _refuse(4);
        }
        return uint256(uint128(received));
    }
    function payInput() external {
        if (msg.sender != payingHook || payingHook == address(0)) revert Unauthorized();
        payingHook = address(0);
        poolManager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransferFrom(payer, address(poolManager), inputAmount);
        if (poolManager.settle() != inputAmount) revert Unauthorized();
    }
    function _settle(Currency currency, address subject, int128 amount) private {
        if (amount < 0) {
            poolManager.sync(currency);
            uint256 debt = uint256(-int256(amount));
            IERC20(Currency.unwrap(currency)).safeTransferFrom(subject, address(poolManager), debt);
            if (poolManager.settle() != debt) revert Unauthorized();
        } else if (amount > 0) poolManager.take(currency, subject, uint128(amount));
    }
}
