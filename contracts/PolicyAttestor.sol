// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Holds the facts a compliance team has established about a wallet, as two words: which
/// facts are known, and what they are.
/// @dev Attestations expire. An expired attestation reports nothing rather than reporting stale
/// truth, so every fact reverts to unknown and the policy denies. Point-in-time screening becomes
/// continuous screening without any new logic. A watcher can clear individual bits the moment a
/// hit lands, and the borrower can set the override bit the agreement reserves for it. Nothing
/// here carries a reason or an identity: facts only.
contract PolicyAttestor is AccessControl, EIP712 {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    bytes32 public constant WATCHER_ROLE = keccak256("WATCHER_ROLE");
    bytes32 public constant BORROWER_ROLE = keccak256("BORROWER_ROLE");

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

    error InvalidWindow();
    error NothingOnFile();
    error UnauthorizedAttestor(address signer);

    event Attested(address indexed subject, bytes32 indexed policyHash, uint256 known, uint256 value, uint32 expiresAt);
    event Revoked(address indexed subject, bytes32 indexed policyHash, uint256 clearedBits);
    event Overridden(address indexed subject, bytes32 indexed policyHash, uint256 bits);

    constructor(address admin) EIP712("Mirrortech Policy Attestor", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function _key(address subject, bytes32 policyHash) private pure returns (bytes32) {
        return keccak256(abi.encode(subject, policyHash));
    }

    /// @notice What is attested about a subject right now. Everything reads unknown once stale.
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
    /// function never needs a funded key or to be online at the moment a lender acts.
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

    /// @notice Clear individual facts immediately. The bits go back to unknown and the policy
    /// stops permitting the action on the next call. No reason is recorded on chain.
    function revokeFacts(address subject, bytes32 policyHash, uint256 bits) external onlyRole(WATCHER_ROLE) {
        Attestation storage attestation = _attestations[_key(subject, policyHash)];
        attestation.known &= ~bits;
        attestation.value &= ~bits;
        emit Revoked(subject, policyHash, bits);
    }

    /// @notice Assert facts the agreement reserves to the borrower, such as the Section 13(c)(y)
    /// sanctions override. Lives and dies with the subject's current attestation window.
    function overrideFacts(address subject, bytes32 policyHash, uint256 bits) external onlyRole(BORROWER_ROLE) {
        Attestation storage attestation = _attestations[_key(subject, policyHash)];
        if (attestation.expiresAt <= block.timestamp) revert NothingOnFile();
        attestation.known |= bits;
        attestation.value |= bits;
        emit Overridden(subject, policyHash, bits);
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
