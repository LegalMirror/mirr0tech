// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
import {MirrorPolicyHook} from "./MirrorPolicyHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PolicyOracle} from "./PolicyOracle.sol";
import {PolicyEval} from "./PolicyEval.sol";
import {CompiledPolicy} from "../generated/CompiledPolicy.sol";
interface IUniswapSender { function msgSender() external view returns (address); }

/// @notice Policy enforcement for canonical Universal Router and PositionManager.
/// hookData is never accepted as proof of wallet identity.
contract MirrorUniswapHook is MirrorPolicyHook {
    using PoolIdLibrary for PoolKey;
    address public immutable positionManager;
    address public immutable quoter;
    constructor(IPoolManager manager, PolicyOracle policy, address universalRouter, address token_, address positions, address quote)
        MirrorPolicyHook(manager, policy, universalRouter, token_) {
        require(universalRouter.code.length > 0 && positions.code.length > 0 && quote.code.length > 0, "Missing Uniswap periphery");
        positionManager = positions;
        quoter = quote;
    }
    function isSettlementRouter(address account) external view returns (bool) {
        return account == router || account == positionManager;
    }
    function _enforce(address sender, PoolKey calldata key, bytes calldata) internal override {
        // The canonical quoter always reverts its unlocked simulation and cannot settle tokens.
        // Do not authorize a settlement on this path; API quoting need not attest its service wallet.
        if (sender == quoter) return;
        if (sender != router && sender != positionManager) revert NotRouter(sender);
        address subject = IUniswapSender(sender).msgSender();
        if (subject == address(0)) revert MissingSubject();
        (uint256 known, uint256 value,) = oracle.facts(subject);
        (bool allowed, uint16 clauseId) = PolicyEval.decide(CompiledPolicy.program(CompiledPolicy.ACTION_TRANSFER), known, value);
        emit PolicyChecked(key.toId(), subject, CompiledPolicy.ACTION_TRANSFER, allowed, clauseId);
        if (!allowed) revert LegalClauseViolation(clauseId, policyHash);
        bytes32 slot = APPROVED_SUBJECT_SLOT;
        assembly ("memory-safe") { tstore(slot, subject) }
    }
}
