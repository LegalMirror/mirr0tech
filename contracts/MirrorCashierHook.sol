// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MirrorCashierToken} from "./MirrorCashierToken.sol";
import {PolicyOracle} from "./PolicyOracle.sol";
import {CompiledPolicy} from "../generated/CompiledPolicy.sol";
import {CompiledCashierTerms as Terms} from "../generated/CompiledCashierTerms.sol";
import {CashierConfig} from "./CashierConfig.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICashierPayer {
    function poolManager() external view returns (IPoolManager);
    function configurationHash() external view returns (bytes32);
    function payInput() external;
}

/// @notice Fixed DEMO NAV custom accounting, not a NAV oracle or an arbitrage/LP-loss guarantee.
contract MirrorCashierHook is IHooks {
    using SafeERC20 for IERC20;
    IPoolManager public immutable poolManager;
    PolicyOracle public immutable oracle;
    address public immutable router;
    MirrorCashierToken public immutable token;
    IERC20 public immutable asset;
    bytes32 public constant policyHash = CompiledPolicy.POLICY_HASH;
    bytes32 public constant clauseTableHash = CompiledPolicy.CLAUSE_TABLE_HASH;
    bytes32 public immutable configurationHash;
    bytes32 public immutable termsHash;
    uint128 public immutable nav;
    uint16 public immutable subscriptionFeeBps;
    uint16 public immutable redemptionFeeBps;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    uint16 public immutable navClauseId;
    uint16 public immutable subscriptionClauseId;
    uint16 public immutable redemptionClauseId;
    uint16 public immutable supplyCapClauseId;
    uint16 public immutable executionClauseId;
    uint160 private constant FLAGS = Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
    bytes32 private constant APPROVAL = keccak256("mirrortech.cashier.approvedSubject");

    error InvalidConfiguration();
    error NotPoolManager();
    error NotRouter();
    error NotToken();
    error InvalidPool();
    error HookNotImplemented();
    error LegalClauseViolation(uint16 clauseId, bytes32 policyHash);
    // reason: 1 unsupported/tiny input; 2 insufficient reserves; 3 supply cap.
    error CashierRefused(uint16 clauseId, bytes32 policyHash, uint8 reason);
    event CashierExecuted(address indexed subject, bool indexed buy, uint256 amountIn, uint256 amountOut, bytes32 termsHash);

    constructor(IPoolManager manager_, PolicyOracle oracle_, address router_, MirrorCashierToken token_, IERC20 asset_, CashierConfig.Parameters memory config) {
        CashierConfig.validate(config, Terms.CONFIGURATION_HASH);
        if (uint160(address(this)) & Hooks.ALL_HOOK_MASK != FLAGS || address(manager_).code.length == 0
            || router_.code.length == 0 || address(token_) == address(asset_) || address(asset_).code.length == 0
            || address(ICashierPayer(router_).poolManager()) != address(manager_)
            || ICashierPayer(router_).configurationHash() != Terms.CONFIGURATION_HASH
            || oracle_.policyHash() != policyHash || token_.policyHash() != policyHash || token_.maxSupply() != config.maxSupply
            || IERC20Metadata(address(asset_)).decimals() != config.assetDecimals || token_.decimals() != config.shareDecimals) revert InvalidConfiguration();
        poolManager = manager_; oracle = oracle_; router = router_; token = token_; asset = asset_;
        configurationHash = Terms.CONFIGURATION_HASH;
        termsHash = config.termsHash;
        nav = config.navMicroUsd;
        subscriptionFeeBps = config.subscriptionFeeBps;
        redemptionFeeBps = config.redemptionFeeBps;
        poolFee = config.pool.fee;
        tickSpacing = config.pool.tickSpacing;
        navClauseId = config.clauseIds.navUsd;
        subscriptionClauseId = config.clauseIds.subscriptionFeeBps;
        redemptionClauseId = config.clauseIds.redemptionFeeBps;
        supplyCapClauseId = config.clauseIds.cashierSupplyCap;
        executionClauseId = config.clauseIds.cashierExecution;
    }

    modifier onlyManager() { if (msg.sender != address(poolManager)) revert NotPoolManager(); _; }

    function _approve(address subject) private {
        bytes32 slot = APPROVAL;
        assembly ("memory-safe") { tstore(slot, subject) }
    }
    function clearApproval() external {
        if (msg.sender != router) revert NotRouter();
        _approve(address(0));
    }
    function approvedSubject() external view returns (address subject) {
        bytes32 slot = APPROVAL;
        assembly ("memory-safe") { subject := tload(slot) }
    }
    function consumeApproval() external returns (address subject) {
        if (msg.sender != address(token)) revert NotToken();
        bytes32 slot = APPROVAL;
        assembly ("memory-safe") { subject := tload(slot) tstore(slot, 0) }
    }
    function explain(address subject) external view returns (bool, uint16) {
        return oracle.decide(subject, CompiledPolicy.ACTION_TRANSFER);
    }
    function _policy(address subject, uint8 action) private view {
        (bool allowed, uint16 clauseId) = oracle.decide(subject, action);
        if (!allowed) revert LegalClauseViolation(clauseId, policyHash);
    }
    function _check(address sender, PoolKey calldata key, address subject) private view {
        if (sender != router || subject == address(0)) revert NotRouter();
        bool sorted = uint160(address(token)) < uint160(address(asset));
        if (Currency.unwrap(key.currency0) != (sorted ? address(token) : address(asset))
            || Currency.unwrap(key.currency1) != (sorted ? address(asset) : address(token))
            || address(key.hooks) != address(this) || key.fee != poolFee || key.tickSpacing != tickSpacing) revert InvalidPool();
        _policy(subject, CompiledPolicy.ACTION_TRANSFER);
    }
    function quote(bool buy, uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max)))
            revert CashierRefused(executionClauseId, policyHash, 1);
        amountOut = buy
            ? Math.mulDiv(amountIn, CashierConfig.UNIT * CashierConfig.BPS, uint256(nav) * (CashierConfig.BPS + subscriptionFeeBps))
            : Math.mulDiv(amountIn, uint256(nav) * (CashierConfig.BPS - redemptionFeeBps), CashierConfig.UNIT * CashierConfig.BPS);
        if (amountOut == 0 || amountOut > uint256(uint128(type(int128).max)))
            revert CashierRefused(executionClauseId, policyHash, 1);
    }
    function beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata data)
        external onlyManager returns (bytes4) {
        address subject = abi.decode(data, (address)); _check(sender, key, subject); _approve(subject);
        return IHooks.beforeAddLiquidity.selector;
    }
    function beforeRemoveLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata data)
        external onlyManager returns (bytes4) {
        address subject = abi.decode(data, (address)); _check(sender, key, subject); _approve(subject);
        return IHooks.beforeRemoveLiquidity.selector;
    }
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata data)
        external onlyManager returns (bytes4, BeforeSwapDelta, uint24) {
        (address subject, bool cashier) = abi.decode(data, (address, bool));
        _check(sender, key, subject);
        if (params.amountSpecified >= 0 || params.amountSpecified < -int256(type(int128).max))
            revert CashierRefused(executionClauseId, policyHash, 1);
        bool buy = Currency.unwrap(params.zeroForOne ? key.currency0 : key.currency1) == address(asset);
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 amountOut = quote(buy, amountIn);
        _approve(subject);
        if (!cashier) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
        _policy(subject, buy ? CompiledPolicy.ACTION_MINT : CompiledPolicy.ACTION_BURN);
        if (buy && amountOut > token.maxSupply() - token.totalSupply())
            revert CashierRefused(supplyCapClauseId, policyHash, 3);
        if (!buy && asset.balanceOf(address(this)) < amountOut)
            revert CashierRefused(executionClauseId, policyHash, 2);
        // Prepay inside the callback: works even when the singleton holds no input currency yet.
        // settle() credits the router; its final negative swap delta consumes that credit.
        ICashierPayer(router).payInput();
        if (buy) {
            poolManager.take(Currency.wrap(address(asset)), address(this), amountIn);
            poolManager.sync(Currency.wrap(address(token)));
            _approve(address(poolManager));
            token.cashierMint(amountOut);
            poolManager.settle();
            _approve(subject);
        } else {
            _approve(address(this));
            poolManager.take(Currency.wrap(address(token)), address(this), amountIn);
            token.cashierBurn(amountIn);
            poolManager.sync(Currency.wrap(address(asset)));
            asset.safeTransfer(address(poolManager), amountOut);
            poolManager.settle();
            _approve(address(0));
        }
        emit CashierExecuted(subject, buy, amountIn, amountOut, termsHash);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(uint128(amountIn)), -int128(uint128(amountOut))), 0);
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external pure returns (bytes4, int128) { revert HookNotImplemented(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert HookNotImplemented(); }
}
