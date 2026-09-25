// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPolicyOracleTransfer {
    function mayTransfer(address subject) external view returns (bool allowed, uint16 clauseId);
}

interface IVenueHook {
    function poolManager() external view returns (address);
    function consumeApproval() external returns (address);
}

/// @notice Custodial by default: the signer authorizes policy decisions and all supply stays in
/// custody. Once a secondary venue is configured, shares may be released to an onboarded investor
/// and pooled — but only through a pool carrying the policy hook.
/// @dev The hash commits to the compiled policy; it does not prove off-chain KYC or settlement.
/// The pool manager is a singleton, so a token cannot tell which pool a transfer belongs to; the
/// hook can, and it records the subject it admitted in transient storage for the token to check.
contract MirrorToken is ERC20, AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    address public immutable custodian;
    bytes32 public immutable policyHash;
    uint256 public immutable maxSupply;
    bool public immutable mintEnabled;
    bool public immutable burnEnabled;
    mapping(bytes32 => bool) public processed;
    IPolicyOracleTransfer public policyOracle;
    IVenueHook public venueHook;

    error InvalidConfiguration();
    error InvalidOperation();
    error AlreadyProcessed();
    error SupplyCapExceeded();
    error TransfersDisabled();
    error ActionDisabled();
    error SecondaryAlreadyConfigured();
    error TransferRefused(address to, uint16 clauseId);
    error NoPolicyDoor(address subject);
    event Operation(bytes32 indexed operationId, bool indexed isMint, uint256 amount);
    event SecondaryConfigured(address policyOracle, address venueHook);
    event Released(bytes32 indexed operationId, address indexed investor, uint256 amount);

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

    /// @notice Bind the compiled policy oracle and the venue hook, once. Enables transfers.
    function configureSecondary(IPolicyOracleTransfer oracle, IVenueHook hook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(venueHook) != address(0)) revert SecondaryAlreadyConfigured();
        if (address(oracle) == address(0) || address(hook) == address(0)) revert InvalidConfiguration();
        policyOracle = oracle;
        venueHook = hook;
        emit SecondaryConfigured(address(oracle), address(hook));
    }

    /// @notice Move shares from custody to an onboarded investor's own wallet.
    function release(bytes32 operationId, address investor, uint256 amount) external onlyRole(MINTER_ROLE) whenNotPaused {
        _consume(operationId, amount);
        _transfer(custodian, investor, amount);
        emit Released(operationId, investor, amount);
    }

    function _admitted(address party) private view {
        (bool allowed, uint16 clauseId) = policyOracle.mayTransfer(party);
        if (!allowed) revert TransferRefused(party, clauseId);
    }

    function _consume(bytes32 operationId, uint256 amount) private {
        if (operationId == bytes32(0) || amount == 0) revert InvalidOperation();
        if (processed[operationId]) revert AlreadyProcessed();
        processed[operationId] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (address(venueHook) == address(0)) revert TransfersDisabled();
            address poolManager = venueHook.poolManager();
            if (from == poolManager || to == poolManager) {
                // The only door into Uniswap: a pool that ran the policy hook in this transaction,
                // and each admitted operation opens it for exactly one settlement leg.
                address subject = from == poolManager ? to : from;
                if (venueHook.consumeApproval() != subject) revert NoPolicyDoor(subject);
            } else {
                // Shares move neither to nor from a wallet the agreement refuses; custody is the issuer.
                _admitted(to);
                if (from != custodian) _admitted(from);
            }
        }
        super._update(from, to, value);
    }
}
