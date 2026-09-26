// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Context} from "../../vendor/swap-vm/src/libs/VM.sol";
import {PolicyOracle} from "../PolicyOracle.sol";
import {CompiledPolicy} from "../../generated/CompiledPolicy.sol";

/// @notice Builds the arguments of a PolicyGuard instruction: the policy hash the strategy was
/// written against, and the action of the agreement a fill is treated as.
library PolicyGuardArgsBuilder {
    function build(bytes32 policyHash, uint8 action) internal pure returns (bytes memory) {
        return abi.encodePacked(policyHash, action);
    }
}

/// @notice A SwapVM instruction that runs the compiled legal agreement inside the maker's program.
/// @dev Evaluates both parties at every fill and at every quote: `quote()` executes the program in
/// a static context, so a wallet the agreement refuses is refused before any transaction is sent.
/// The maker is checked too — a borrower whose own screening lapsed has a strategy that stops
/// filling on its own. The instruction is view-only and holds no state; expiry and revocation live
/// in the attestor, so a strategy that was fillable yesterday can be unfillable today with no
/// change to the strategy.
///
/// A fill is a transfer of the position, and the agreement has a transfer clause; that is the
/// action a strategy names. Routers inherit this contract and append `_policyGuard` to their
/// instruction set.
abstract contract PolicyGuard {
    PolicyOracle public immutable POLICY_ORACLE;

    error PolicyGuardMissingArgs();
    error PolicyMismatch(bytes32 expected, bytes32 given);
    /// @notice A party to the fill was refused by a clause of the agreement.
    error CounterpartyRefused(address subject, uint16 clauseId, bytes32 policyHash);

    constructor(PolicyOracle oracle) {
        POLICY_ORACLE = oracle;
    }

    /// @param args.policyHash | 32 bytes
    /// @param args.action     | 1 byte
    function _policyGuard(Context memory ctx, bytes calldata args) internal view {
        if (args.length < 33) revert PolicyGuardMissingArgs();
        bytes32 policyHash = bytes32(args[0:32]);
        uint8 action = uint8(args[32]);
        if (policyHash != CompiledPolicy.POLICY_HASH) revert PolicyMismatch(CompiledPolicy.POLICY_HASH, policyHash);
        _check(ctx.query.maker, action);
        _check(ctx.query.taker, action);
    }

    function _check(address subject, uint8 action) private view {
        (bool allowed, uint16 clauseId) = POLICY_ORACLE.decide(subject, action);
        if (!allowed) revert CounterpartyRefused(subject, clauseId, CompiledPolicy.POLICY_HASH);
    }
}
