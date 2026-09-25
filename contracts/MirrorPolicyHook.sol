// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PolicyAttestor} from "./PolicyAttestor.sol";
import {PolicyEval} from "./PolicyEval.sol";
import {CompiledPolicy} from "../generated/CompiledPolicy.sol";

/// @notice The same compiled agreement, enforced at a Uniswap v4 pool instead of a credit market.
///
/// @dev A private-credit position is only transferable to someone the agreement admits. That makes
/// an ordinary pool unusable for it: the moment the position reaches an AMM, the clause stops being
/// enforced by anything. This hook puts it back.
///
/// The agreement has no concept of a swap or of a liquidity position. It has a concept of a
/// transfer, and adding liquidity, removing liquidity and swapping are all transfers of the
/// position. All three are therefore evaluated against the agreement's transfer action, which is
/// the faithful reading rather than an invented one.
///
/// Identity does not come from `sender`: the pool manager passes the router, not the person. The
/// subject is supplied in `hookData` and must be the account that signed for the operation, which
/// is why liquidity and swaps must be routed through a contract that sets it honestly.
contract MirrorPolicyHook is IHooks {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    PolicyAttestor public immutable attestor;

    /// @notice The agreement this hook speaks for.
    bytes32 public immutable policyHash;

    /// @notice Hash of the clause table that decodes a denial back to its verbatim quote.
    bytes32 public immutable clauseTableHash;

    /// @notice The router permitted to assert who the subject of an operation is.
    address public immutable router;

    error NotPoolManager();
    error NotRouter(address caller);
    error HookNotImplemented();
    error MissingSubject();
    error InvalidHookAddress(address deployed, uint160 expected);

    /// @notice A pool operation was refused by a clause of the source agreement.
    /// @param clauseId Index into the clause table; the front end renders the quote it names.
    error LegalClauseViolation(uint16 clauseId, bytes32 policyHash);

    event PolicyChecked(PoolId indexed poolId, address indexed subject, uint8 action, bool allowed, uint16 clauseId);

    /// @dev beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap.
    uint160 internal constant REQUIRED_FLAGS =
        Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;

    constructor(IPoolManager poolManager_, PolicyAttestor attestor_, address router_) {
        if (uint160(address(this)) & Hooks.ALL_HOOK_MASK != REQUIRED_FLAGS) {
            revert InvalidHookAddress(address(this), REQUIRED_FLAGS);
        }
        poolManager = poolManager_;
        attestor = attestor_;
        router = router_;
        policyHash = CompiledPolicy.POLICY_HASH;
        clauseTableHash = CompiledPolicy.CLAUSE_TABLE_HASH;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice Evaluate without transacting, so a front end can explain a refusal before it happens.
    function explain(address subject) external view returns (bool allowed, uint16 clauseId) {
        (uint256 known, uint256 value,) = attestor.factsOf(subject, policyHash);
        return PolicyEval.decide(CompiledPolicy.program(CompiledPolicy.ACTION_TRANSFER), known, value);
    }

    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4)
    {
        _enforce(sender, key, hookData);
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeRemoveLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4)
    {
        _enforce(sender, key, hookData);
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata hookData)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        _enforce(sender, key, hookData);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _enforce(address sender, PoolKey calldata key, bytes calldata hookData) private {
        if (sender != router) revert NotRouter(sender);
        if (hookData.length < 32) revert MissingSubject();
        address subject = abi.decode(hookData, (address));
        (uint256 known, uint256 value,) = attestor.factsOf(subject, policyHash);
        (bool allowed, uint16 clauseId) =
            PolicyEval.decide(CompiledPolicy.program(CompiledPolicy.ACTION_TRANSFER), known, value);
        emit PolicyChecked(key.toId(), subject, CompiledPolicy.ACTION_TRANSFER, allowed, clauseId);
        if (!allowed) revert LegalClauseViolation(clauseId, policyHash);
    }

    // Hooks this contract's address does not enable. The pool manager never calls them; anything
    // else that does is asking the wrong question.
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external pure returns (bytes4, int128) { revert HookNotImplemented(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
}
