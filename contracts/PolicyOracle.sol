// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {PolicyAttestor} from "./PolicyAttestor.sol";
import {PolicyEval} from "./PolicyEval.sol";
import {CompiledPolicy} from "../generated/CompiledPolicy.sol";

interface ISanctionsOracle {
    function isSanctioned(address subject) external view returns (bool);
}

interface IOpenTermMarket {
    function isOpenTerm() external view returns (bool);
}

/// @notice Assembles the two words every venue decides from.
/// @dev Attested facts come from the attestor and expire with it. Observable facts are read from
/// their source at decision time and never from the attestor: the sanctions oracle the agreement
/// names as definitive, and the market's own state. Derived facts follow from attestation state.
/// Every venue — role provider, SwapVM guard, Uniswap hook — calls this, so the assembly is done
/// once and identically.
contract PolicyOracle {
    PolicyAttestor public immutable attestor;
    ISanctionsOracle public immutable sanctions;
    address public immutable deployer;
    /// @dev Bound once after deployment: the market needs the role provider, which needs this oracle.
    IOpenTermMarket public market;

    error NotDeployer();
    error MarketAlreadyBound();

    uint256 private constant OBSERVABLE = CompiledPolicy.FACT_SANCTIONS_CLEAR | CompiledPolicy.FACT_OPEN_TERM_STATE;

    constructor(PolicyAttestor attestor_, ISanctionsOracle sanctions_) {
        attestor = attestor_;
        sanctions = sanctions_;
        deployer = msg.sender;
    }

    function bindMarket(IOpenTermMarket market_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(market) != address(0)) revert MarketAlreadyBound();
        market = market_;
    }

    function policyHash() external pure returns (bytes32) {
        return CompiledPolicy.POLICY_HASH;
    }

    /// @return known Which facts are established right now.
    /// @return value Their truth; only bits set in `known` are meaningful.
    /// @return screenedAt When the attested facts were established, or zero if none hold.
    function facts(address subject) public view returns (uint256 known, uint256 value, uint32 screenedAt) {
        (known, value, screenedAt) = attestor.factsOf(subject, CompiledPolicy.POLICY_HASH);
        // Observable facts are read, not attested: drop any attested copy before reading.
        known &= ~OBSERVABLE;
        value &= ~OBSERVABLE;
        // Derived: a live attestation is, by definition, a current screening.
        if (screenedAt != 0) {
            known |= CompiledPolicy.FACT_SCREENING_CURRENT;
            value |= CompiledPolicy.FACT_SCREENING_CURRENT;
        }
        // Observable: the sanctions oracle is the definitive source (MLA 13(b)).
        known |= CompiledPolicy.FACT_SANCTIONS_CLEAR;
        if (!sanctions.isSanctioned(subject)) value |= CompiledPolicy.FACT_SANCTIONS_CLEAR;
        // Observable: the market's term state, when a market is bound.
        if (address(market) != address(0)) {
            known |= CompiledPolicy.FACT_OPEN_TERM_STATE;
            if (market.isOpenTerm()) value |= CompiledPolicy.FACT_OPEN_TERM_STATE;
        }
    }

    /// @notice The decision itself, so venues that must stay small (a SwapVM router is near the
    /// contract size limit) do not carry the compiled programs or the evaluator.
    function decide(address subject, uint8 action) external view returns (bool allowed, uint16 clauseId) {
        (uint256 known, uint256 value,) = facts(subject);
        return PolicyEval.decide(CompiledPolicy.program(action), known, value);
    }

    /// @notice Whether the agreement lets this wallet receive the asset — the question a token
    /// or a pool asks at the boundary.
    function mayTransfer(address subject) external view returns (bool allowed, uint16 clauseId) {
        (uint256 known, uint256 value,) = facts(subject);
        return PolicyEval.decide(CompiledPolicy.program(CompiledPolicy.ACTION_TRANSFER), known, value);
    }
}
