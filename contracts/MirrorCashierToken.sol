// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {MirrorToken} from "./MirrorToken.sol";

/// @notice Opt-in token extension. No arbitrary recipient, burn source, or admin cashier role.
contract MirrorCashierToken is MirrorToken {
    error NotCashier();

    constructor(string memory name_, string memory symbol_, address admin, address minter,
        bytes32 policyHash_, uint256 maxSupply_, bool mintEnabled_, bool burnEnabled_)
        MirrorToken(name_, symbol_, admin, minter, policyHash_, maxSupply_, mintEnabled_, burnEnabled_) {}

    function cashierMint(uint256 amount) external whenNotPaused {
        if (msg.sender != address(venueHook)) revert NotCashier();
        if (!mintEnabled) revert ActionDisabled();
        if (amount == 0) revert InvalidOperation();
        if (amount > maxSupply - totalSupply()) revert SupplyCapExceeded();
        address manager = venueHook.poolManager();
        if (venueHook.consumeApproval() != manager) revert NoPolicyDoor(manager);
        _mint(manager, amount);
    }

    function cashierBurn(uint256 amount) external whenNotPaused {
        if (msg.sender != address(venueHook)) revert NotCashier();
        if (!burnEnabled) revert ActionDisabled();
        if (amount == 0) revert InvalidOperation();
        // The hook first takes shares from PoolManager through the normal single-use token door.
        _burn(msg.sender, amount);
    }
}
