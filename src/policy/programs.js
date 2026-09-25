// Assembles SwapVM programs and orders for the buyback template. Opcode numbers are read from the
// vendored LimitOpcodes.sol (the router's instruction set) so the JavaScript builder and the compiled router can never disagree; the
// PolicyGuard opcode is appended after them by MirrortechRouter and is read from the router.
import { readFileSync } from 'node:fs';
import { AbiCoder, concat, getBytes, toBeHex, zeroPadValue } from 'ethers';

const OPCODES_SOURCE = 'vendor/swap-vm/src/opcodes/LimitOpcodes.sol';

// The Solidity array lists `_notInstruction` first and drops it, so opcode = position - 1.
export function loadOpcodes(path = OPCODES_SOURCE) {
  const source = readFileSync(path, 'utf8');
  const body = source.slice(source.indexOf('memory instructions = ['), source.indexOf('];'));
  const names = [...body.matchAll(/^\s*([A-Za-z]+\.[_A-Za-z0-9]+|_notInstruction),?\s*$/gm)].map((match) => match[1]);
  const table = {};
  names.forEach((name, index) => { if (name !== '_notInstruction') table[name] = index - 1; });
  // Debug slots are unnamed, so the set's size is the last opcode plus one, not the number of names.
  Object.defineProperty(table, 'count', { value: names.length - 1, enumerable: false });
  return table;
}

const instruction = (opcode, args = '0x') => {
  const bytes = getBytes(args);
  if (bytes.length > 255) throw new Error('Instruction arguments exceed one byte of length');
  return concat([toBeHex(opcode, 1), toBeHex(bytes.length, 1), bytes]);
};

export const encoders = {
  deadline: (opcodes, timestamp) => instruction(opcodes['Controls._deadline'], zeroPadValue(toBeHex(timestamp), 5)),
  staticBalances: (opcodes, tokens, balances) => instruction(opcodes['Balances._staticBalancesXD'], concat([
    zeroPadValue(toBeHex(tokens.length), 2), ...tokens, ...balances.map((amount) => zeroPadValue(toBeHex(amount), 32)),
  ])),
  limitSwap: (opcodes, tokenIn, tokenOut) => instruction(opcodes['LimitSwap._limitSwap1D'],
    toBeHex(BigInt(tokenIn) < BigInt(tokenOut) ? 1 : 0, 1)),
  invalidateTokenIn: (opcodes) => instruction(opcodes['Invalidators._invalidateTokenIn1D']),
  policyGuard: (opcode, policyHash, action) => instruction(opcode, concat([policyHash, toBeHex(action, 1)])),
  fixedRateBalances: (opcode, tokenA, balanceA, tokenB, balanceB) => instruction(opcode, concat([
    tokenA, zeroPadValue(toBeHex(balanceA), 32), tokenB, zeroPadValue(toBeHex(balanceB), 32),
  ])),
};

// The buyback template: a fixed price, a cumulative cap, an expiry, and the agreement in between.
// The maker receives the position token (taker's tokenIn) and pays the asset (taker's tokenOut).
// In Aqua mode the shipped balances are the settlement allowance; the rate comes from the terms.
export function buildBuybackProgram({ opcodes, policyGuardOpcode, fixedRateBalancesOpcode, policyHash, action, deadline, positionToken, asset, capPosition, capAsset }) {
  return concat([
    encoders.deadline(opcodes, deadline),
    encoders.policyGuard(policyGuardOpcode, policyHash, action),
    encoders.fixedRateBalances(fixedRateBalancesOpcode, positionToken, capPosition, asset, capAsset),
    encoders.limitSwap(opcodes, positionToken, asset),
    encoders.invalidateTokenIn(opcodes),
  ]);
}

// Maker traits for a hookless Aqua strategy: only the Aqua flag is set, the receiver is the maker,
// and with no hook slices the whole of `data` is the program.
const USE_AQUA_INSTEAD_OF_SIGNATURE = 1n << 254n;
export function buildAquaOrder(maker, program) {
  return { maker, traits: USE_AQUA_INSTEAD_OF_SIGNATURE, data: program };
}

export const encodeOrder = (order) =>
  AbiCoder.defaultAbiCoder().encode(['tuple(address,uint256,bytes)'], [[order.maker, order.traits, order.data]]);

// Taker traits: a 22-byte header (ten uint16 slice ends packed into a uint160, then uint16 flags)
// followed by the slices. This packs a threshold and a deadline and nothing else.
const IS_EXACT_IN = 0x0001n;
const USE_TRANSFER_FROM_AND_AQUA_PUSH = 0x0040n;
export function buildTakerData({ isExactIn = true, threshold, deadline, useTransferFromAndAquaPush = true }) {
  const thresholdBytes = threshold === undefined ? '0x' : zeroPadValue(toBeHex(threshold), 32);
  const deadlineBytes = deadline === undefined ? '0x' : zeroPadValue(toBeHex(deadline), 5);
  const ends = [];
  let cursor = getBytes(thresholdBytes).length;
  ends.push(cursor);            // 0 threshold
  ends.push(cursor);            // 1 to (none)
  cursor += getBytes(deadlineBytes).length;
  ends.push(cursor);            // 2 deadline
  for (let slice = 3; slice < 10; slice++) ends.push(cursor); // hooks, callbacks, instruction args: empty
  let slices = 0n;
  ends.forEach((end, index) => { slices |= BigInt(end) << BigInt(16 * index); });
  const flags = (isExactIn ? IS_EXACT_IN : 0n) | (useTransferFromAndAquaPush ? USE_TRANSFER_FROM_AND_AQUA_PUSH : 0n);
  return concat([zeroPadValue(toBeHex(slices), 20), zeroPadValue(toBeHex(flags), 2), thresholdBytes, deadlineBytes]);
}

// Terms compiled from the addendum, in the units the template needs. Prices are quoted as asset per
// position token with both at six decimals, so the cap in asset is cap × price.
export function buybackTermsFrom(policy) {
  const term = (name) => policy.ast.terms.find((entry) => entry.name === name)?.value;
  const price = term('buybackPrice');
  const cap = term('buybackCap');
  const deadline = term('buybackDeadline');
  if (!price || !cap || !deadline) throw new Error('The policy does not carry buyback terms');
  const priceMicro = BigInt(Math.round(Number(price) * 1_000_000));
  const capPosition = BigInt(cap) * 1_000_000n;
  return {
    price, cap, deadline,
    capPosition,
    capAsset: capPosition * priceMicro / 1_000_000n,
    deadlineTimestamp: Math.floor(Date.parse(`${deadline}T23:59:59Z`) / 1000),
  };
}
