// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Wildcat V2's role provider interface, reproduced from
/// wildcat-finance/v2-protocol `src/access/IRoleProvider.sol` so this repository can build against
/// it without vendoring the protocol. A borrower's access-control hooks contract queries every
/// registered provider; returning a non-zero timestamp grants the lender a deposit credential,
/// which the hooks contract then expires according to the provider's time-to-live.
interface IRoleProvider {
    function isPullProvider() external view returns (bool);

    function getCredential(address account) external view returns (uint32 timestamp);

    function validateCredential(address account, bytes calldata data) external returns (uint32 timestamp);
}
