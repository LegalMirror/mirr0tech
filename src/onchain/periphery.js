// Calls into Uniswap's canonical v4 periphery without the Trading API: PositionManager mints a
// position, the Universal Router swaps. Both settle through Permit2 and report the caller as
// msgSender(), which is the wallet the policy hook checks.
import { AbiCoder, Interface, concat } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const POOL_KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const key = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

/// v4-periphery Actions.sol opcodes, as hex bytes.
export const ACTIONS = Object.freeze({ MINT_POSITION: '02', SWAP_EXACT_IN_SINGLE: '06', SETTLE_ALL: '0c', SETTLE_PAIR: '0d', TAKE_ALL: '0f' });
const V4_SWAP = '0x10';
const PERMIT2_PERMIT = '0x0a';

export const POSITION_MANAGER = new Interface(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable']);
export const UNIVERSAL_ROUTER = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const PERMIT2 = new Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

const actions = (...codes) => `0x${codes.join('')}`;

export function mintPositionCall({ key: k, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, deadline }) {
  const params = [
    coder.encode([POOL_KEY, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'], [key(k), tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, '0x']),
    coder.encode(['address', 'address'], [k.currency0, k.currency1]),
  ];
  const unlockData = coder.encode(['bytes', 'bytes[]'], [actions(ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR), params]);
  return POSITION_MANAGER.encodeFunctionData('modifyLiquidities', [unlockData, deadline]);
}

/// The V4_SWAP input: SWAP_EXACT_IN_SINGLE through this pool, SETTLE_ALL what is paid, TAKE_ALL what comes out.
export function v4SwapInput({ key: k, zeroForOne, amountIn, amountOutMinimum }) {
  const [paid, received] = zeroForOne ? [k.currency0, k.currency1] : [k.currency1, k.currency0];
  const params = [
    // Universal Router 2.1 (v4-periphery with per-hop price limits) reads minHopPriceX36 before hookData; 0 means none.
    coder.encode([`tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`], [[key(k), zeroForOne, amountIn, amountOutMinimum, 0n, '0x']]),
    coder.encode(['address', 'uint256'], [paid, amountIn]),
    coder.encode(['address', 'uint256'], [received, amountOutMinimum]),
  ];
  return coder.encode(['bytes', 'bytes[]'], [actions(ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL), params]);
}

export function swapExactInSingleCall({ deadline, ...swap }) {
  return UNIVERSAL_ROUTER.encodeFunctionData('execute', [concat([V4_SWAP]), [v4SwapInput(swap)], deadline]);
}

/// One call a wallet signs for: PERMIT2_PERMIT with its signed PermitSingle, then the V4_SWAP.
export function permitAndSwapCall({ permit, signature, deadline, ...swap }) {
  const d = permit.details;
  const permitInput = coder.encode(['tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline)', 'bytes'],
    [[[d.token, d.amount, d.expiration, d.nonce], permit.spender, permit.sigDeadline], signature]);
  return UNIVERSAL_ROUTER.encodeFunctionData('execute', [concat([PERMIT2_PERMIT, V4_SWAP]), [permitInput, v4SwapInput(swap)], deadline]);
}
