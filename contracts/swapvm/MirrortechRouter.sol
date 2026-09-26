// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Simulator} from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";
import {SwapVM} from "../../vendor/swap-vm/src/SwapVM.sol";
import {LimitOpcodes} from "../../vendor/swap-vm/src/opcodes/LimitOpcodes.sol";
import {Context} from "../../vendor/swap-vm/src/libs/VM.sol";
import {PolicyGuard} from "./PolicyGuard.sol";
import {FixedRateBalances} from "./FixedRateBalances.sol";
import {PolicyOracle} from "../PolicyOracle.sol";
import {CompiledPolicy} from "../../generated/CompiledPolicy.sol";

/// @notice 1inch SwapVM router with two instructions added: the compiled agreement, and a fixed
/// rate that survives Aqua's preloaded balances.
/// @dev A redeployment of a modified SwapVM, which the Aqua track allows. The instruction set is
/// the official limit-order set (`LimitOpcodes`: deadline, static balances, limit swap, Dutch
/// auction, invalidators, fees); `PolicyGuard` is appended at the end so existing opcodes keep
/// their numbers and existing programs keep their meaning.
contract MirrortechRouter is Simulator, SwapVM, LimitOpcodes, PolicyGuard, FixedRateBalances {
    constructor(address aqua, address weth, address owner, PolicyOracle oracle)
        SwapVM(aqua, weth, owner, "MirrortechRouter", "1")
        LimitOpcodes(aqua)
        PolicyGuard(oracle)
    {}

    /// @notice The opcode a program uses to invoke the agreement.
    function policyGuardOpcode() external pure returns (uint8) {
        return uint8(LimitOpcodes._opcodes().length);
    }

    /// @notice The opcode that pins a rate over Aqua-loaded balances.
    function fixedRateBalancesOpcode() external pure returns (uint8) {
        return uint8(LimitOpcodes._opcodes().length + 1);
    }

    function policyHash() external pure returns (bytes32) {
        return CompiledPolicy.POLICY_HASH;
    }

    function clauseTableHash() external pure returns (bytes32) {
        return CompiledPolicy.CLAUSE_TABLE_HASH;
    }

    function _instructions() internal pure override returns (function(Context memory, bytes calldata) internal[] memory) {
        return _opcodes();
    }

    function _opcodes() internal pure override returns (function(Context memory, bytes calldata) internal[] memory result) {
        function(Context memory, bytes calldata) internal[] memory base = LimitOpcodes._opcodes();
        result = new function(Context memory, bytes calldata) internal[](base.length + 2);
        for (uint256 i = 0; i < base.length; i++) result[i] = base[i];
        result[base.length] = _policyGuard;
        result[base.length + 1] = _fixedRateBalances;
    }
}
