// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IRoleProvider} from "./wildcat/IRoleProvider.sol";
import {PolicyAttestor} from "./PolicyAttestor.sol";
import {PolicyOracle} from "./PolicyOracle.sol";
import {PolicyEval} from "./PolicyEval.sol";
import {CompiledPolicy} from "../generated/CompiledPolicy.sol";

/// @notice Grants Wildcat deposit credentials by running the borrower's Master Loan Agreement.
/// @dev A borrower registers this as a pull provider on their access-control hooks contract with
/// `addRoleProvider(provider, timeToLive)`. Nothing about the market or the protocol changes. The
/// lender check process that a compliance team runs by hand becomes an `eth_call`, and the answer
/// carries the clause that produced it.
///
/// Two expiries apply and the tighter one wins: the attestation's own validity window, and the
/// time-to-live the borrower set when registering this provider.
contract MirrortechRoleProvider is IRoleProvider {
    bytes32 public immutable policyHash;
    bytes32 public immutable clauseTableHash;
    PolicyOracle public immutable oracle;

    error PolicyDenied(uint16 clauseId, bytes32 policyHash);

    /// @notice Emitted on every credential decision so the audit trail is the chain itself.
    event CredentialDecision(address indexed account, bool allowed, uint16 clauseId, uint32 screenedAt);

    constructor(PolicyOracle oracle_) {
        oracle = oracle_;
        policyHash = CompiledPolicy.POLICY_HASH;
        clauseTableHash = CompiledPolicy.CLAUSE_TABLE_HASH;
    }

    function isPullProvider() external pure returns (bool) {
        return true;
    }

    /// @notice Wildcat's hooks contract calls this to decide whether a lender may deposit.
    /// @return timestamp When the screening behind the decision was performed, or zero to deny.
    function getCredential(address account) external view returns (uint32 timestamp) {
        (bool allowed, , uint32 screenedAt) = _decide(account, CompiledPolicy.ACTION_DEPOSIT);
        return allowed ? screenedAt : 0;
    }

    /// @notice Present a freshly signed screening certificate and be admitted in one transaction.
    /// @param data An abi-encoded PolicyAttestor.attestWithSignature payload, or empty to rely on
    /// an attestation already on file.
    function validateCredential(address account, bytes calldata data) external returns (uint32 timestamp) {
        if (data.length > 0) {
            (uint256 known, uint256 value, uint32 issuedAt, uint32 validUntil, uint256 nonce, bytes memory signature) =
                abi.decode(data, (uint256, uint256, uint32, uint32, uint256, bytes));
            oracle.attestor().attestWithSignature(account, policyHash, known, value, issuedAt, validUntil, nonce, signature);
        }
        (bool allowed, uint16 clauseId, uint32 screenedAt) = _decide(account, CompiledPolicy.ACTION_DEPOSIT);
        emit CredentialDecision(account, allowed, clauseId, screenedAt);
        if (!allowed) revert PolicyDenied(clauseId, policyHash);
        return screenedAt;
    }

    /// @notice Why was this wallet allowed, blocked or paid? One call, for any action.
    /// @dev The returned `clauseId` indexes the clause table whose hash is committed above, so the
    /// quote a front end renders cannot be swapped for a different sentence.
    function explain(address account, uint8 action)
        external
        view
        returns (bool allowed, uint16 clauseId, uint32 screenedAt, uint256 known, uint256 value)
    {
        (known, value, screenedAt) = oracle.facts(account);
        (allowed, clauseId) = PolicyEval.decide(CompiledPolicy.program(action), known, value);
    }

    /// @notice Whether this lender may be paid, evaluated fresh at the moment of payment.
    function mayWithdraw(address account) external view returns (bool allowed, uint16 clauseId) {
        (allowed, clauseId, ) = _decide(account, CompiledPolicy.ACTION_WITHDRAW);
    }

    /// @notice Whether market tokens may move to this wallet.
    function mayTransfer(address account) external view returns (bool allowed, uint16 clauseId) {
        (allowed, clauseId, ) = _decide(account, CompiledPolicy.ACTION_TRANSFER);
    }

    function _decide(address account, uint8 action)
        private
        view
        returns (bool allowed, uint16 clauseId, uint32 screenedAt)
    {
        uint256 known;
        uint256 value;
        (known, value, screenedAt) = oracle.facts(account);
        (allowed, clauseId) = PolicyEval.decide(CompiledPolicy.program(action), known, value);
    }
}
