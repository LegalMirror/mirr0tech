// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRoleProvider} from "./wildcat/IRoleProvider.sol";

interface IPolicyRoleProvider is IRoleProvider {
    function mayWithdraw(address account) external view returns (bool allowed, uint16 clauseId);
    function mayTransfer(address account) external view returns (bool allowed, uint16 clauseId);
}

/// @notice A minimal stand-in for a Wildcat V2 market: deposits need a credential from the role
/// provider, withdrawals need payment-time eligibility, and the market token can only move to a
/// wallet the provider admits. Non-rebasing on purpose. Labeled a mock everywhere it appears.
contract MockWildcatMarket is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    IPolicyRoleProvider public immutable roleProvider;
    address public immutable borrower;
    bool public openTerm = true;

    error NoDepositCredential(address lender);
    error WithdrawalRefused(address lender, uint16 clauseId);
    error TransferRefused(address to, uint16 clauseId);
    error NotBorrower();

    event Deposited(address indexed lender, uint256 amount);
    event Withdrawn(address indexed lender, uint256 amount);

    constructor(IERC20 asset_, IPolicyRoleProvider roleProvider_, address borrower_)
        ERC20("Demo MM Ltd Market Token", "mDEMO")
    {
        asset = asset_;
        roleProvider = roleProvider_;
        borrower = borrower_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function isOpenTerm() external view returns (bool) {
        return openTerm;
    }

    function setOpenTerm(bool value) external {
        if (msg.sender != borrower) revert NotBorrower();
        openTerm = value;
    }

    /// @dev Wildcat grants a credential when a registered role provider returns a non-zero timestamp.
    function deposit(uint256 amount) external {
        if (roleProvider.getCredential(msg.sender) == 0) revert NoDepositCredential(msg.sender);
        asset.safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @dev Eligibility is evaluated at the moment of payment, not at onboarding.
    function withdraw(uint256 amount) external {
        (bool allowed, uint16 clauseId) = roleProvider.mayWithdraw(msg.sender);
        if (!allowed) revert WithdrawalRefused(msg.sender, clauseId);
        _burn(msg.sender, amount);
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @dev Borrower draws the loaned assets; the market is undercollateralized by design.
    function borrow(uint256 amount) external {
        if (msg.sender != borrower) revert NotBorrower();
        asset.safeTransfer(borrower, amount);
    }

    function repay(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Transferability level (ii): only to a wallet holding a valid credential.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            (bool allowed, uint16 clauseId) = roleProvider.mayTransfer(to);
            if (!allowed) revert TransferRefused(to, clauseId);
        }
        super._update(from, to, value);
    }
}
