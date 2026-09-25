// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stand-in for the Chainalysis sanctions oracle the agreement names as definitive.
/// Same read shape (`isSanctioned(address)`), admin-settable for demos and tests.
contract MockSanctionsOracle {
    address public immutable admin;
    mapping(address => bool) private _sanctioned;

    error NotAdmin();

    event Designated(address indexed subject, bool sanctioned);

    constructor(address admin_) {
        admin = admin_;
    }

    function isSanctioned(address subject) external view returns (bool) {
        return _sanctioned[subject];
    }

    function setSanctioned(address subject, bool sanctioned) external {
        if (msg.sender != admin) revert NotAdmin();
        _sanctioned[subject] = sanctioned;
        emit Designated(subject, sanctioned);
    }
}
