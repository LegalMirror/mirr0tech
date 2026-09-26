// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Evaluates a compiled policy from two machine words: which facts are known, and what
/// they are. Unknown is a real third value and it never satisfies anything, so a fact that was
/// never attested — or whose attestation has expired — denies the operation.
/// @dev The compiler converts each rule's condition to disjunctive normal form and proves the
/// conversion against the JavaScript interpreter over every three-valued assignment.
library PolicyEval {
    uint8 internal constant PERMIT = 0;
    uint8 internal constant REQUIRE = 1;
    uint8 internal constant FORBID = 2;

    /// @param pos Facts that must be true in each term; `neg` are the facts that must be false.
    struct Rule {
        uint8 effect;
        uint16 clauseId;
        uint256[] pos;
        uint256[] neg;
    }

    /// @return allowed Whether the action is permitted.
    /// @return clauseId The clause that denied it: the failing requirement or prohibition, or the
    /// first permission when none held — the permission the subject lacks. Zero only when the
    /// action has no rules at all.
    function decide(bytes memory program, uint256 known, uint256 value)
        internal
        pure
        returns (bool allowed, uint16 clauseId)
    {
        Rule[] memory rules = abi.decode(program, (Rule[]));
        bool permitted;
        uint16 firstPermit;
        for (uint256 i; i < rules.length; ++i) {
            (bool isTrue, bool isFalse) = evaluate(rules[i], known, value);
            if (rules[i].effect == PERMIT) {
                if (firstPermit == 0) firstPermit = rules[i].clauseId;
                if (isTrue) permitted = true;
            } else if (rules[i].effect == REQUIRE) {
                if (!isTrue) return (false, rules[i].clauseId);
            } else if (!isFalse) {
                return (false, rules[i].clauseId);
            }
        }
        return (permitted, permitted ? 0 : firstPermit);
    }

    /// @dev Neither flag set means unknown. A fact on both sides of one term is left in place:
    /// it reads false once the fact is known and unknown until then, which is the correct result.
    function evaluate(Rule memory rule, uint256 known, uint256 value)
        internal
        pure
        returns (bool isTrue, bool isFalse)
    {
        bool unknown;
        for (uint256 i; i < rule.pos.length; ++i) {
            uint256 pos = rule.pos[i];
            uint256 neg = rule.neg[i];
            uint256 knownPos = known & pos;
            uint256 knownNeg = known & neg;
            if (value & knownPos != knownPos) continue;
            if (value & knownNeg != 0) continue;
            if (knownPos == pos && knownNeg == neg) return (true, false);
            unknown = true;
        }
        return (false, !unknown);
    }
}
