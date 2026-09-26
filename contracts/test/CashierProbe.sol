// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILiquidityDoor {
    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params) external;
}

/// @dev Adversarial router: attempts to claim someone else's eligible identity in hookData.
contract CashierProbe is IUnlockCallback {
    IPoolManager immutable manager;
    constructor(IPoolManager manager_) { manager = manager_; }
    function forge(PoolKey calldata key, SwapParams calldata params, address subject) external {
        manager.unlock(abi.encode(key, params, subject));
    }
    function emptyApprovalAttack(ILiquidityDoor router, PoolKey calldata key, ModifyLiquidityParams memory params, IERC20 token) external {
        IERC20(Currency.unwrap(key.currency0)).approve(address(router), type(uint256).max);
        IERC20(Currency.unwrap(key.currency1)).approve(address(router), type(uint256).max);
        router.modifyLiquidity(key, params);
        params.liquidityDelta = 0;
        router.modifyLiquidity(key, params);
        token.transfer(address(manager), 1);
    }
    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (PoolKey memory key, SwapParams memory params, address subject) = abi.decode(raw, (PoolKey, SwapParams, address));
        manager.swap(key, params, abi.encode(subject, true));
        return "";
    }
}
