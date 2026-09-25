// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Holds the facts a compliance team has established about a wallet, as two words: which
/// facts are known, and what they are.
/// @dev Attestations expire. An expired attestation reports nothing rather than reporting stale
/// truth, so every fact reverts to unknown and the policy denies. Point-in-time screening becomes
/// continuous screening without any new logic: a lender who is not re-screened simply stops
/// qualifying. A watcher can also clear individual bits the moment a hit lands.
contract PolicyAttestor is AccessControl, EIP712 {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address subject,bytes32 policyHash,uint256 known,uint256 value,uint32 issuedAt,uint32 expiresAt,uint256 nonce)"
    );

    struct Attestation {
        uint256 known;
        uint256 value;
        uint32 issuedAt;
        uint32 expiresAt;
    }

    mapping(bytes32 => Attestation) private _attestations;
    mapping(address => uint256) public nonces;

    error AttestationExpired();
    error InvalidWindow();
    error UnauthorizedAttestor(address signer);

    event Attested(address indexed subject, bytes32 indexed policyHash, uint256 known, uint256 value, uint32 expiresAt);
    event Revoked(address indexed subject, bytes32 indexed policyHash, uint256 clearedBits, string reason);

    constructor(address admin) EIP712("Mirrortech Policy Attestor", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function _key(address subject, bytes32 policyHash) private pure returns (bytes32) {
        return keccak256(abi.encode(subject, policyHash));
    }

    /// @notice What is known about a subject right now. Everything reads unknown once stale.
    /// @return known Bitmap of facts that have been established.
    /// @return value Bitmap of their truth values; only bits set in `known` are meaningful.
    /// @return issuedAt When the screening behind these facts was performed, or zero if none holds.
    function factsOf(address subject, bytes32 policyHash)
        external
        view
        returns (uint256 known, uint256 value, uint32 issuedAt)
    {
        Attestation storage attestation = _attestations[_key(subject, policyHash)];
        if (attestation.expiresAt <= block.timestamp) return (0, 0, 0);
        return (attestation.known, attestation.value, attestation.issuedAt);
    }

    /// @notice Whether a subject's screening is still inside its validity window.
    function isCurrent(address subject, bytes32 policyHash) external view returns (bool) {
        return _attestations[_key(subject, policyHash)].expiresAt > block.timestamp;
    }

    function expiresAt(address subject, bytes32 policyHash) external view returns (uint32) {
        return _attestations[_key(subject, policyHash)].expiresAt;
    }

    function attest(address subject, bytes32 policyHash, uint256 known, uint256 value, uint32 issuedAt, uint32 validUntil)
        external
        onlyRole(ATTESTOR_ROLE)
    {
        _record(subject, policyHash, known, value, issuedAt, validUntil);
    }

    /// @notice Relay an attestation signed off chain by an authorized attestor. The screening
    /// service never needs a funded key or to be online at the moment a lender acts.
    function attestWithSignature(
        address subject,
        bytes32 policyHash,
        uint256 known,
        uint256 value,
        uint32 issuedAt,
        uint32 validUntil,
        uint256 nonce,
        bytes calldata signature
    ) external {
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, subject, policyHash, known, value, issuedAt, validUntil, nonce))
        );
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ATTESTOR_ROLE, signer)) revert UnauthorizedAttestor(signer);
        if (nonce != nonces[subject]) revert InvalidWindow();
        nonces[subject] = nonce + 1;
        _record(subject, policyHash, known, value, issuedAt, validUntil);
    }

    /// @notice Clear individual facts immediately. Used when a sanctions or adverse-media hit
    /// lands between scheduled screens: the bit goes back to unknown and the policy stops
    /// permitting the action on the next call, with no further coordination.
    function revokeFacts(address subject, bytes32 policyHash, uint256 bits, string calldata reason)
        external
        onlyRole(WATCHER_ROLE)
    {
        Attestation storage attestation = _attestations[_key(subject, policyHash)];
        attestation.known &= ~bits;
        attestation.value &= ~bits;
        emit Revoked(subject, policyHash, bits, reason);
    }

    function _record(address subject, bytes32 policyHash, uint256 known, uint256 value, uint32 issuedAt, uint32 validUntil)
        private
    {
        if (validUntil <= block.timestamp || issuedAt > block.timestamp) revert InvalidWindow();
        // A fact cannot be asserted true without also being asserted known.
        _attestations[_key(subject, policyHash)] =
            Attestation({known: known, value: value & known, issuedAt: issuedAt, expiresAt: validUntil});
        emit Attested(subject, policyHash, known, value & known, validUntil);
    }
}
