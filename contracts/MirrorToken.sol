// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Custodial MVP: the signer authorizes policy decisions and all supply stays in custody.
/// @dev The hash commits to the compiled policy; it does not prove off-chain KYC or settlement.
contract MirrorToken is ERC20, AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    address public immutable custodian;
    bytes32 public immutable policyHash;
    uint256 public immutable maxSupply;
    bool public immutable mintEnabled;
    bool public immutable burnEnabled;
    mapping(bytes32 => bool) public processed;

    error InvalidConfiguration();
    error InvalidOperation();
    error AlreadyProcessed();
    error SupplyCapExceeded();
    error TransfersDisabled();
    error ActionDisabled();
    event Operation(bytes32 indexed operationId, bool indexed isMint, uint256 amount);

    constructor(string memory name_, string memory symbol_, address admin, address minter,
        bytes32 policyHash_, uint256 maxSupply_, bool mintEnabled_, bool burnEnabled_)
        ERC20(name_, symbol_) {
        if (admin == address(0) || minter == address(0) || policyHash_ == bytes32(0) || maxSupply_ == 0) revert InvalidConfiguration();
        custodian = minter;
        policyHash = policyHash_;
        maxSupply = maxSupply_;
        mintEnabled = mintEnabled_;
        burnEnabled = burnEnabled_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
    }

    function decimals() public pure override returns (uint8) { return 6; }
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function mint(bytes32 operationId, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (!mintEnabled) revert ActionDisabled();
        _consume(operationId, amount);
        if (amount > maxSupply - totalSupply()) revert SupplyCapExceeded();
        _mint(custodian, amount);
        emit Operation(operationId, true, amount);
    }

    function burn(bytes32 operationId, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        if (!burnEnabled) revert ActionDisabled();
        _consume(operationId, amount);
        _burn(custodian, amount);
        emit Operation(operationId, false, amount);
    }

    function _consume(bytes32 operationId, uint256 amount) private {
        if (operationId == bytes32(0) || amount == 0) revert InvalidOperation();
        if (processed[operationId]) revert AlreadyProcessed();
        processed[operationId] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert TransfersDisabled();
        super._update(from, to, value);
    }
}
