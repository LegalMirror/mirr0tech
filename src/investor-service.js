// The parent authenticates sessions. This service never accepts a proof or signs an investor trade.
import { createHash, randomUUID } from 'node:crypto';
import { Interface, formatUnits, getAddress, id, parseUnits } from 'ethers';
import { AppError, ensure } from './errors.js';
import { indexedAddressEvents } from './multibaas.js';
import { decodeCashierRefusal } from './policy/cashier-refusal.js';
import { decodeRefusal } from './refusal.js';

const ROUTES = ['auto', 'amm', 'cashier'];
const ORDER_SECONDS = 180;
const MAX_INTENTS = 1024;
const DAY = 86400;
const LEGACY = 'Cashier deployment required: the legacy MirrorLiquidityRouter has no minimum output or deadline bounds.';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : null;
const ERC20 = new Interface([
  'function approve(address spender,uint256 amount) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);
const ROUTER = new Interface([
  'function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,uint256 minOut,uint256 deadline,uint8 route) returns (uint256)',
  'event Executed(address indexed subject,uint8 route,uint256 amountIn,uint256 amountOut)',
]);
const HOOK = new Interface(['event CashierExecuted(address indexed subject,bool indexed buy,uint256 amountIn,uint256 amountOut,bytes32 termsHash)']);
const ATTESTOR = new Interface([
  'event Attested(address indexed subject,bytes32 indexed policyHash,uint256 known,uint256 value,uint32 expiresAt)',
  'event Revoked(address indexed subject,bytes32 indexed policyHash,uint256 clearedBits)',
  'event Overridden(address indexed subject,bytes32 indexed policyHash,uint256 bits)',
]);

function amount(value) {
  ensure(typeof value === 'string' && value.length <= 40 && /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value),
    400, 'INVALID_AMOUNT', 'Use a positive decimal string with at most six decimal places');
  const units = parseUnits(value, 6);
  ensure(units > 0n && units < 2n ** 127n, 400, 'INVALID_AMOUNT', 'Amount must fit a positive int128');
  return units;
}
function order(body) {
  ensure(body && typeof body.buy === 'boolean' && ROUTES.includes(body.route ?? 'auto'), 400, 'INVALID_ORDER', 'buy must be boolean; route must be auto, amm or cashier');
  return { buy: body.buy, units: amount(body.amount), route: body.route ?? 'auto' };
}
function publicError(error) {
  if (error instanceof AppError) return error;
  return new AppError(503, 'CHAIN_UNAVAILABLE', 'Chain read or preflight unavailable; no transaction was automatically resent');
}
function receiptSummary(receipt) {
  return { transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: Number(receipt.status) };
}
function binding(session) {
  return createHash('sha256').update(JSON.stringify([session.id, session.wallet.toLowerCase(), session.fundId,
    session.policyHash.toLowerCase(), session.chainId, session.credential, session.environment, session.mock,
    session.expiresAt, session.verification.nullifier])).digest('hex');
}
function clause(table, clauseId) {
  const entry = table?.clauses?.[Number(clauseId) - 1];
  return entry ? { clause: text(entry.clause, 240), quote: text(entry.quote, 4000) } : null;
}

export class InvestorService {
  #intents = new Map();
  #identityBudgets = new Map();
  #identityJobs = new Map();
  #globalAttempts = [];

  constructor({ venues, agreements = null, publishedAgreementIds = [], clock = () => Date.now(), writeQueue = async (operation) => operation() }) {
    ensure(Array.isArray(publishedAgreementIds) && publishedAgreementIds.every((value) => typeof value === 'string' && value.length <= 128),
      500, 'INVALID_PUBLICATION', 'Published agreement IDs must be an explicit array');
    this.venues = venues;
    this.agreements = agreements;
    this.publishedAgreementIds = new Set(publishedAgreementIds);
    this.clock = clock;
    ensure(typeof writeQueue === 'function', 500, 'CONFIG', 'Issuer write queue must be a function');
    this.writeQueue = writeQueue;
  }

  async resolveFund(fundId) {
    ensure(typeof fundId === 'string' && (fundId === 'stack' || this.publishedAgreementIds.has(fundId)), 404, 'FUND_NOT_FOUND', 'Published fund not found');
    let venue; let name;
    if (fundId === 'stack') { venue = this.venues; name = 'Demo fund'; }
    else {
      ensure(this.agreements, 404, 'FUND_NOT_FOUND', 'Published fund not found');
      try {
        // Never enumerate uploaded records, and check publication before consulting Agreements.
        const record = this.agreements.record(fundId);
        ensure(record.status === 'deployed', 404, 'FUND_NOT_FOUND', 'Published fund not found');
        name = text(record.name) ?? 'Published fund';
        venue = await this.agreements.venue(fundId);
      } catch { throw new AppError(404, 'FUND_NOT_FOUND', 'Published fund not found'); }
    }
    ensure(venue?.record?.rwa && venue?.provider, 503, 'FUND_UNAVAILABLE', 'Published fund has no available chain binding');
    return { id: fundId, name, venue };
  }

  config() {
    const verifier = this.venues?.worldId?.verifier;
    return { chainId: Number(this.venues?.record?.chainId) || null, environment: verifier?.mock ? 'mock' : verifier?.environment ?? null,
      credential: verifier?.credential ?? null, mock: verifier?.mock === true };
  }

  async funds() {
    const result = [];
    for (const fundId of ['stack', ...this.publishedAgreementIds].filter((value, index, all) => all.indexOf(value) === index)) {
      let fund;
      try { fund = await this.resolveFund(fundId); } catch { continue; }
      const { venue } = fund; const r = venue.record.rwa;
      const cashier = r.cashier?.enabled === true;
      const disabledReason = !cashier ? LEGACY : ![31337, 11155111].includes(Number(venue.record.chainId)) ? 'Only local Anvil and Sepolia trading are supported' : null;
      const entry = { id: fund.id, name: fund.name, chainId: Number(venue.record.chainId), policyHash: venue.policy('rwa').policy.hash,
        token: r.token, router: r.router, poolManager: r.poolManager, cashier, asset: r.cashier?.asset ?? venue.record.usdc,
        ...(disabledReason ? { disabledReason } : {}) };
      try { entry.symbol = text(await venue.c.token.connect(venue.provider).symbol(), 32); } catch { /* Listing does not imply RPC availability. */ }
      result.push(entry);
    }
    return result;
  }

  async #context(session) {
    ensure(session && typeof session.id === 'string' && session.id.length > 0 && session.id.length <= 128
      && ADDRESS.test(session.wallet) && HASH.test(session.policyHash) && Number.isSafeInteger(session.chainId)
      && Number.isSafeInteger(session.expiresAt) && session.expiresAt > Math.floor(this.clock() / 1000), 401, 'INVALID_SESSION', 'Investor session is invalid or expired');
    const fund = await this.resolveFund(session.fundId);
    const { venue } = fund; const r = venue.record.rwa; const { policy, clauseTable } = venue.policy('rwa');
    const verifier = venue.worldId?.verifier;
    ensure(verifier && session.credential === verifier.credential && session.environment === (verifier.mock ? 'mock' : verifier.environment)
      && session.mock === verifier.mock, 401, 'SESSION_CONTEXT_CHANGED', 'Identity configuration changed; authenticate again');
    ensure(session.verification?.success === true && typeof session.verification.nullifier === 'string' && session.verification.nullifier.length > 0
      && session.verification.nullifier.length <= 256 && session.verification.credential === session.credential
      && session.verification.environment === session.environment && session.verification.mock === session.mock
      && session.verification.action === verifier.action, 401, 'INVALID_VERIFICATION', 'A server-verified session is required');
    ensure(session.chainId === Number(venue.record.chainId) && eq(session.policyHash, policy.hash) && eq(r.policyHash, policy.hash),
      409, 'SESSION_CONTEXT_CHANGED', 'Fund policy or chain changed; authenticate again');
    const c = Object.fromEntries(['token', 'rwaOracle', 'hook', 'v4Router', 'attestor', 'usdc', 'cashierAsset']
      .filter((key) => venue.c[key]).map((key) => [key, venue.c[key].connect(venue.provider)]));
    const [network, block, oracleHash, tokenHash, oracle, hook, attestor] = await Promise.all([
      venue.provider.getNetwork(), venue.provider.getBlock('latest'), c.rwaOracle.policyHash(), c.token.policyHash(),
      c.token.policyOracle(), c.token.venueHook(), c.rwaOracle.attestor(),
    ]);
    ensure(Number(network.chainId) === session.chainId && eq(oracleHash, policy.hash) && eq(tokenHash, policy.hash)
      && eq(oracle, r.oracle) && eq(hook, r.hook) && eq(attestor, venue.record.attestor),
    409, 'CHAIN_BINDING_CHANGED', 'Current on-chain fund binding differs from the session');
    const now = Math.max(Math.floor(this.clock() / 1000), Number(block.timestamp));
    ensure(session.expiresAt > now, 401, 'SESSION_EXPIRED', 'Investor session expired');
    return { fund, venue, r, policy, clauseTable, c, wallet: getAddress(session.wallet), chainId: session.chainId, now, block, session };
  }

  async #run(session, fn) {
    try { return await fn(await this.#context(session)); } catch (error) { throw publicError(error); }
  }

  async #decisions(ctx) {
    return Object.fromEntries(await Promise.all(['mint', 'burn', 'transfer'].map(async (action) => {
      const index = ctx.policy.actionOrder.indexOf(action);
      if (index < 0) return [action, { allowed: false, clauseId: null, clause: null, reason: 'Action not supported by this fund' }];
      const [allowed, clauseId] = await ctx.c.rwaOracle.decide(ctx.wallet, index);
      return [action, { allowed, clauseId: Number(clauseId), clause: clause(ctx.clauseTable, clauseId) }];
    })));
  }

  async #assets(ctx) {
    const asset = ctx.c.cashierAsset ?? ctx.c.usdc;
    const read = async (contract, address) => {
      const [decimals, symbol, balance, allowance] = await Promise.all([contract.decimals(), contract.symbol(), contract.balanceOf(ctx.wallet), contract.allowance(ctx.wallet, ctx.r.router)]);
      ensure(Number.isInteger(Number(decimals)) && Number(decimals) >= 0 && Number(decimals) <= 255, 503, 'INVALID_TOKEN_METADATA', 'Unsupported token metadata');
      return { address, symbol: text(symbol, 32), decimals: Number(decimals), balance: formatUnits(balance, decimals), balanceRaw: String(balance),
        allowance: formatUnits(allowance, decimals), allowanceRaw: String(allowance), spender: ctx.r.router };
    };
    const [token, inputAsset, native] = await Promise.all([read(ctx.c.token, ctx.r.token), read(asset, ctx.r.cashier?.asset ?? ctx.venue.record.usdc), ctx.venue.provider.getBalance(ctx.wallet)]);
    return { token, asset: inputAsset, native: { symbol: 'ETH', decimals: 18, balance: formatUnits(native, 18), balanceRaw: String(native) } };
  }

  async #cashier(ctx) {
    if (!ctx.r.cashier?.enabled) return null;
    const { hook, v4Router, token, cashierAsset } = ctx.c;
    const [manager, router, asset, share, oracle, policyHash, configHash, routerConfigHash, termsHash, nav, buyFee, sellFee, fee, spacing,
      routerManager, reserve, supply, cap, paused, mintEnabled, burnEnabled] = await Promise.all([
      hook.poolManager(), hook.router(), hook.asset(), hook.token(), hook.oracle(), hook.policyHash(), hook.configurationHash(), v4Router.configurationHash(),
      hook.termsHash(), hook.nav(), hook.subscriptionFeeBps(), hook.redemptionFeeBps(), hook.poolFee(), hook.tickSpacing(),
      v4Router.poolManager(), cashierAsset.balanceOf(ctx.r.hook), token.totalSupply(), token.maxSupply(), token.paused(), token.mintEnabled(), token.burnEnabled(),
    ]);
    const key = ctx.r.poolKey;
    const pair = [ctx.r.token, ctx.r.cashier.asset].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    ensure(eq(manager, ctx.r.poolManager) && eq(routerManager, manager) && eq(router, ctx.r.router) && eq(asset, ctx.r.cashier.asset)
      && eq(share, ctx.r.token) && eq(oracle, ctx.r.oracle) && eq(policyHash, ctx.policy.hash) && eq(configHash, routerConfigHash)
      && eq(configHash, ctx.policy.cashier?.configurationHash) && eq(termsHash, ctx.policy.cashier?.termsHash)
      && key && eq(key.currency0, pair[0]) && eq(key.currency1, pair[1])
      && eq(key.hooks, ctx.r.hook) && Number(key.fee) === Number(fee) && Number(key.tickSpacing) === Number(spacing),
    409, 'CASHIER_BINDING_CHANGED', 'Published cashier does not match its current on-chain configuration');
    return { reserve: formatUnits(reserve, 6), reserveRaw: String(reserve), totalSupply: formatUnits(supply, 6), totalSupplyRaw: String(supply),
      maxSupply: formatUnits(cap, 6), maxSupplyRaw: String(cap), nav: formatUnits(nav, 6), navRaw: String(nav), subscriptionFeeBps: Number(buyFee),
      redemptionFeeBps: Number(sellFee), termsHash, configurationHash: configHash, poolKey: { ...key }, paused, mintEnabled, burnEnabled,
      limitations: 'Fixed DEMO NAV; prefunded reserve only. NAV quotes are indicative, not router simulations or execution guarantees.' };
  }

  #disabled(ctx, assets) {
    if (!ctx.r.cashier?.enabled) return LEGACY;
    if (![31337, 11155111].includes(ctx.chainId)) return 'Only local Anvil and Sepolia trading are supported';
    if (assets.token.decimals !== 6 || assets.asset.decimals !== 6) return 'The bounded cashier requires six-decimal share and asset tokens';
    return null;
  }

  async snapshot(session) {
    return this.#run(session, async (ctx) => {
      const [balances, decisions, cashier] = await Promise.all([this.#assets(ctx), this.#decisions(ctx), this.#cashier(ctx)]);
      const disabledReason = this.#disabled(ctx, balances);
      return { fundId: ctx.fund.id, name: ctx.fund.name, wallet: ctx.wallet, chainId: ctx.chainId, policyHash: ctx.policy.hash,
        blockNumber: ctx.block.number, balances, addresses: { token: ctx.r.token, asset: balances.asset.address, router: ctx.r.router,
          hook: ctx.r.hook, poolManager: ctx.r.poolManager, oracle: ctx.r.oracle, attestor: ctx.venue.record.attestor },
        policy: decisions, cashier, capabilities: { readOnly: Boolean(disabledReason), prepareApproval: !disabledReason, prepareSwap: !disabledReason,
          browserWalletRequired: true, identityAttestation: ctx.policy.factOrder.includes('identityVerified') && (!session.mock || ctx.chainId === 31337),
          serverTrading: false, funding: false, deployment: false }, ...(disabledReason ? { disabledReason } : {}) };
    });
  }

  async #quote(ctx, input) {
    const parsed = order(input);
    const [assets, decisions, cashier] = await Promise.all([this.#assets(ctx), this.#decisions(ctx), this.#cashier(ctx)]);
    const disabledReason = this.#disabled(ctx, assets); const blockers = [];
    const add = (code, message, scope = 'all', extra = {}) => blockers.push({ code, message, scope, ...extra });
    if (disabledReason) add('READ_ONLY_FUND', disabledReason);
    for (const action of ['transfer', parsed.buy ? 'mint' : 'burn']) {
      if (!decisions[action].allowed) add('POLICY_REFUSED', `Current ${action} policy refuses this wallet`, action === 'transfer' ? 'all' : 'cashier', { action, ...decisions[action] });
    }
    const inputToken = parsed.buy ? assets.asset : assets.token; const outputToken = parsed.buy ? assets.token : assets.asset;
    if (BigInt(inputToken.balanceRaw) < parsed.units) add('INSUFFICIENT_BALANCE', 'Input balance is below the exact input amount');
    if (BigInt(inputToken.allowanceRaw) < parsed.units) add('INSUFFICIENT_ALLOWANCE', 'Confirm an exact-amount router approval before preparing the swap');
    if (BigInt(assets.native.balanceRaw) === 0n) add('GAS_REQUIRED', 'The browser wallet needs its own ETH for gas');
    let out = null;
    if (cashier) {
      if (cashier.paused) add('TOKEN_PAUSED', 'Token issuance/redemption is paused', 'cashier');
      if (!(parsed.buy ? cashier.mintEnabled : cashier.burnEnabled)) add('ACTION_DISABLED', 'Cashier issuance/redemption is disabled', 'cashier');
      try { out = await ctx.c.hook.quote(parsed.buy, parsed.units); }
      catch (error) {
        const refusal = decodeCashierRefusal(error, ctx.clauseTable);
        if (!refusal) throw error;
        add('CASHIER_REFUSED', refusal.description, 'cashier', { clauseId: refusal.clauseId, clause: clause(ctx.clauseTable, refusal.clauseId) });
      }
      if (out !== null && parsed.buy && out > BigInt(cashier.maxSupplyRaw) - BigInt(cashier.totalSupplyRaw)) add('SUPPLY_CAP', 'Cashier issuance exceeds the outstanding supply cap', 'cashier');
      if (out !== null && !parsed.buy && out > BigInt(cashier.reserveRaw)) add('INSUFFICIENT_RESERVE', 'Cashier redemption exceeds the prefunded reserve', 'cashier');
    }
    return { kind: cashier ? 'nav-only' : 'unavailable', indicative: true, simulated: false, executable: null,
      fundId: ctx.fund.id, wallet: ctx.wallet, chainId: ctx.chainId, policyHash: ctx.policy.hash, blockNumber: ctx.block.number,
      buy: parsed.buy, route: parsed.route, amount: formatUnits(parsed.units, 6), amountRaw: String(parsed.units), amountOut: out === null ? null : formatUnits(out, 6),
      amountOutRaw: out === null ? null : String(out), inputToken, outputToken, policy: decisions, blockers,
      termsHash: cashier?.termsHash ?? null, notice: 'NAV arithmetic only; AMM price, fallback, gas, allowance and eligibility can change before mining. A quote is not executable authorization.' };
  }

  async quote(session, input) { return this.#run(session, (ctx) => this.#quote(ctx, input)); }

  async prepare(session, input) {
    return this.#run(session, async (ctx) => {
      ensure(input && ['approval', 'swap'].includes(input.kind), 400, 'INVALID_KIND', 'kind must be approval or swap');
      const parsed = order(input); const quoted = await this.#quote(ctx, input);
      const blocking = quoted.blockers.filter((item) => (item.scope === 'all' || parsed.route === 'cashier')
        && !(input.kind === 'approval' && item.code === 'INSUFFICIENT_ALLOWANCE'));
      ensure(!blocking.length, 409, blocking[0]?.code ?? 'PREFLIGHT_REFUSED', 'Current preflight refuses this order', { blockers: blocking });
      const expiresAt = Math.min(session.expiresAt, ctx.now + ORDER_SECONDS);
      let deadline = expiresAt; let minimum = null; let data;
      if (input.kind === 'swap') {
        minimum = amount(input.minOut);
        deadline = input.deadline ?? expiresAt;
        ensure(Number.isSafeInteger(deadline) && deadline > ctx.now && deadline <= expiresAt, 400, 'INVALID_DEADLINE', 'Deadline must be in the next three minutes and within the session lifetime');
        const key = ctx.r.poolKey; const zeroForOne = eq(key.currency0, quoted.inputToken.address);
        data = ROUTER.encodeFunctionData('swap', [key, { zeroForOne, amountSpecified: -parsed.units,
          sqrtPriceLimitX96: zeroForOne ? 4295128740n : 1461446703485210103287273052203988822378723970341n }, minimum, deadline, ROUTES.indexOf(parsed.route)]);
      } else data = ERC20.encodeFunctionData('approve', [ctx.r.router, parsed.units]);
      const transaction = { chainId: ctx.chainId, from: ctx.wallet, to: input.kind === 'approval' ? quoted.inputToken.address : ctx.r.router, data, value: '0x0' };
      let simulation;
      try { simulation = await ctx.venue.provider.call(transaction); }
      catch (error) {
        const refusal = decodeCashierRefusal(error, ctx.clauseTable) ?? decodeRefusal(error, ctx.clauseTable);
        throw new AppError(409, 'SIMULATION_REFUSED', 'On-chain preflight refused; refresh balances, allowance and policy before preparing again',
          refusal && refusal.name !== 'unknown' ? { refusal: { name: refusal.name, clauseId: refusal.clauseId, clause: clause(ctx.clauseTable, refusal.clauseId), reason: refusal.reason ?? null } } : undefined);
      }
      if (input.kind === 'approval') ensure(simulation === '0x' || ERC20.decodeFunctionResult('approve', simulation)[0] === true, 409, 'APPROVAL_REFUSED', 'Input token refused approval');
      const simulatedOut = input.kind === 'swap' ? ROUTER.decodeFunctionResult('swap', simulation)[0] : null;
      for (const [key, intent] of this.#intents) if (intent.expiresAt <= ctx.now) this.#intents.delete(key);
      ensure(this.#intents.size < MAX_INTENTS && [...this.#intents.values()].filter((intent) => eq(intent.wallet, ctx.wallet)).length < 32,
        429, 'INTENT_LIMIT', 'Too many outstanding intents; wait for them to expire');
      const result = { intentId: randomUUID(), expiresAt: Math.min(expiresAt, deadline), transaction, kind: input.kind,
        fundId: ctx.fund.id, wallet: ctx.wallet, policyHash: ctx.policy.hash, buy: parsed.buy, route: parsed.route,
        amount: formatUnits(parsed.units, 6), inputToken: quoted.inputToken.address, outputToken: quoted.outputToken.address,
        ...(minimum !== null ? { minOut: formatUnits(minimum, 6), deadline, simulatedAmountOut: formatUnits(simulatedOut, 6) } : { spender: ctx.r.router }),
        notice: 'Sign and send with the browser wallet. Simulation is not a mining guarantee; no automatic resends.' };
      this.#intents.set(result.intentId, { ...structuredClone(result), binding: binding(session), units: parsed.units, minimum, txHash: null });
      return result;
    });
  }

  async confirm(session, { intentId, txHash } = {}) {
    return this.#run(session, async (ctx) => {
      ensure(typeof intentId === 'string' && HASH.test(txHash), 400, 'INVALID_CONFIRMATION', 'intentId and a transaction hash are required');
      const intent = this.#intents.get(intentId);
      ensure(intent && intent.binding === binding(session), 404, 'INTENT_NOT_FOUND', 'Intent not found for this session');
      ensure(intent.expiresAt > ctx.now, 409, 'INTENT_EXPIRED', 'Intent expired; inspect the wallet receipt rather than resending');
      ensure(!intent.txHash || eq(intent.txHash, txHash), 409, 'INTENT_HASH_CHANGED', 'This intent is already bound to another transaction');
      const tx = await ctx.venue.provider.getTransaction(txHash);
      const base = { intentId, txHash, kind: intent.kind, source: 'rpc' };
      if (!tx) return { ...base, status: 'pending', reason: 'Transaction not yet visible to RPC' };
      const expected = intent.transaction;
      ensure(eq(tx.hash, txHash) && eq(tx.from, expected.from) && eq(tx.to, expected.to) && eq(tx.data, expected.data)
        && BigInt(tx.value) === 0n && Number(tx.chainId) === expected.chainId, 409, 'TRANSACTION_MISMATCH', 'RPC transaction does not match the prepared intent');
      intent.txHash = txHash;
      const receipt = await ctx.venue.provider.getTransactionReceipt(txHash);
      if (!receipt) return { ...base, status: 'pending', reason: 'No mined RPC receipt yet' };
      ensure(eq(receipt.hash, txHash) && eq(receipt.from, expected.from) && eq(receipt.to, expected.to)
        && Number.isSafeInteger(receipt.blockNumber) && HASH.test(receipt.blockHash), 409, 'RECEIPT_MISMATCH', 'RPC receipt does not match the prepared intent');
      const block = await ctx.venue.provider.getBlock(receipt.blockNumber);
      if (!block || !eq(block.hash, receipt.blockHash)) return { ...base, status: 'pending', reason: 'Receipt block is not currently canonical' };
      if (Number(receipt.status) === 0) return { ...base, status: 'reverted', receipt: receiptSummary(receipt) };
      ensure(Number(receipt.status) === 1, 503, 'INVALID_RECEIPT', 'RPC receipt has no recognized execution status');
      const iface = intent.kind === 'swap' ? ROUTER : ERC20;
      const events = receipt.logs.filter((log) => eq(log.address, expected.to) && !log.removed).flatMap((log) => {
        try { const event = iface.parseLog(log); return event ? [event] : []; } catch { return []; }
      });
      let execution;
      if (intent.kind === 'swap') {
        const matches = events.filter((event) => event.name === 'Executed' && eq(event.args.subject, ctx.wallet)
          && event.args.amountIn === intent.units && event.args.amountOut >= intent.minimum
          && [1, 2].includes(Number(event.args.route)) && (intent.route === 'auto' || ROUTES[Number(event.args.route)] === intent.route));
        ensure(matches.length === 1, 409, 'EXECUTION_NOT_PROVEN', 'Successful receipt lacks the expected known-router Executed event');
        execution = { actualRoute: ROUTES[Number(matches[0].args.route)], amountIn: formatUnits(matches[0].args.amountIn, 6), amountOut: formatUnits(matches[0].args.amountOut, 6) };
      } else ensure(events.some((event) => event.name === 'Approval' && eq(event.args.owner, ctx.wallet) && eq(event.args.spender, ctx.r.router)
        && event.args.value === intent.units), 409, 'APPROVAL_NOT_PROVEN', 'Successful receipt lacks the exact known-router approval');
      return { ...base, status: 'confirmed', receipt: receiptSummary(receipt), ...(execution ?? {}), finality: 'mined-not-finalized' };
    });
  }

  async attestIdentity(session) {
    return this.#run(session, async (ctx) => {
      ensure(!session.mock || ctx.chainId === 31337, 403, 'MOCK_IDENTITY_LOCAL_ONLY', 'Mock identity attestations are local-only');
      const index = ctx.policy.factOrder.indexOf('identityVerified');
      ensure(index >= 0 && index < 256, 409, 'IDENTITY_NOT_SUPPORTED', 'This policy has no identityVerified fact');
      const key = `${ctx.chainId}:${ctx.wallet.toLowerCase()}`;
      // Lock before any write awaits: concurrent logins cannot each spend issuer gas.
      if (this.#identityJobs.has(key)) return { status: 'pending', reason: 'Identity attestation already in progress' };
      this.#identityJobs.set(key, true);
      try { return await this.#attest(ctx, key, 1n << BigInt(index)); }
      finally { this.#identityJobs.delete(key); }
    });
  }

  async #attest(ctx, key, bit) {
    const { session, c, wallet, policy, now } = ctx;
    for (const [walletKey, budget] of this.#identityBudgets) if (budget.startedAt + DAY <= now) this.#identityBudgets.delete(walletKey);
    this.#globalAttempts = this.#globalAttempts.filter((time) => time + DAY > now);
    let budget = this.#identityBudgets.get(key);
    if (budget?.pending) {
      const pending = budget.pending;
      if (!eq(pending.policyHash, policy.hash)) return { status: 'pending', reason: 'A prior identity transaction requires reconciliation' };
      return this.#identityReceipt(ctx, budget);
    }
    const [[known, value, issuedAt], oldExpiry] = await Promise.all([c.attestor.factsOf(wallet, policy.hash), c.attestor.expiresAt(wallet, policy.hash)]);
    if ((known & value & bit) !== 0n) return { status: 'already-attested', identityVerified: true, submitted: false, expiresAt: Number(oldExpiry) };
    if ((budget && (budget.count >= 3 || budget.lastAt + 300 > now)) || this.#globalAttempts.length >= 64) {
      return { status: 'refused', code: 'IDENTITY_RATE_LIMIT', reason: 'Issuer identity budget exhausted or cooling down; no transaction submitted',
        retryAfter: budget ? Math.max(1, (budget.count >= 3 ? budget.startedAt + DAY : budget.lastAt + 300) - now) : DAY };
    }
    const expiresAt = Math.min(session.expiresAt, Number(oldExpiry) > now ? Number(oldExpiry) : session.expiresAt, 2 ** 32 - 1);
    ensure(expiresAt > now, 409, 'ATTESTATION_EXPIRED', 'Existing identity/compliance window has expired');
    budget ??= { count: 0, startedAt: now };
    budget.count++; budget.lastAt = now;
    this.#identityBudgets.set(key, budget); this.#globalAttempts.push(now);
    const expected = { policyHash: policy.hash, known: known | bit, value: (value | bit) & (known | bit), expiresAt };
    return this.writeQueue(async () => {
    try {
      ensure(expiresAt > Math.floor(this.clock() / 1000) && eq(ctx.venue.record.rwa.policyHash, policy.hash), 409, 'ATTESTATION_EXPIRED', 'Identity scope expired while waiting for the issuer signer');
      // Capture the authorized sender and destination before submission, not from RPC event data.
      const from = getAddress(await ctx.venue.signer.getAddress());
      const to = getAddress(ctx.venue.record.attestor);
      const writer = ctx.venue.c.attestor.connect(ctx.venue.signer);
      // Keep screenedAt as well as expiry: identity must not refresh existing compliance.
      const tx = await writer.attest(wallet, policy.hash, expected.known, expected.value, known !== 0n ? issuedAt : ctx.block.timestamp, expiresAt);
      budget.pending = { ...expected, from, to, txHash: HASH.test(tx?.hash) ? tx.hash : null };
      try { await tx.wait(1, 10_000); } catch { /* Always ask RPC, including a mined revert or timeout. Never resend. */ }
      return await this.#identityReceipt(ctx, budget);
    } catch {
      return budget.pending ? { status: 'pending', txHash: budget.pending.txHash, reason: 'Identity receipt unavailable; no automatic resend' }
        : { status: 'refused', code: 'ATTESTATION_FAILED', reason: 'Identity submission failed; no compliance granted and no automatic resend' };
    }
    });
  }

  async #identityReceipt(ctx, budget) {
    const expected = budget.pending;
    if (!HASH.test(expected.txHash) || !eq(expected.to, ctx.venue.record.attestor)) {
      return { status: 'pending', txHash: expected.txHash, reason: 'Prior identity submission requires operator reconciliation; no automatic resend' };
    }
    const receipt = await ctx.venue.provider.getTransactionReceipt(expected.txHash);
    if (!receipt) return { status: 'pending', txHash: expected.txHash, reason: 'Identity transaction has no mined RPC receipt yet' };
    if (!eq(receipt.hash, expected.txHash) || !eq(receipt.from, expected.from) || !eq(receipt.to, expected.to)
      || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || !HASH.test(receipt.blockHash)) {
      return { status: 'pending', txHash: expected.txHash, reason: 'RPC receipt does not match the identity submission' };
    }
    const block = await ctx.venue.provider.getBlock(receipt.blockNumber);
    if (!block || block.number !== receipt.blockNumber || !eq(block.hash, receipt.blockHash)) {
      return { status: 'pending', txHash: expected.txHash, reason: 'Identity receipt block is not currently canonical' };
    }
    if (receipt.status === 0) {
      delete budget.pending;
      return { status: 'refused', code: 'ATTESTATION_REVERTED', txHash: expected.txHash, receipt: receiptSummary(receipt) };
    }
    const matched = Array.isArray(receipt.logs) && receipt.logs.some((log) => {
      if (!eq(log?.address, expected.to) || log.removed) return false;
      try { const event = ATTESTOR.parseLog(log); return event?.name === 'Attested' && eq(event.args.subject, ctx.wallet)
        && eq(event.args.policyHash, expected.policyHash) && event.args.known === expected.known && event.args.value === expected.value
        && Number(event.args.expiresAt) === expected.expiresAt; } catch { return false; }
    });
    if (receipt.status !== 1 || !matched) return { status: 'pending', txHash: expected.txHash, reason: 'Expected identity attestation is not proven by RPC receipt' };
    delete budget.pending;
    return { status: 'confirmed', identityVerified: true, txHash: expected.txHash, expiresAt: expected.expiresAt, receipt: receiptSummary(receipt), finality: 'mined-not-finalized' };
  }

  async activity(session) {
    return this.#run(session, async (ctx) => {
      const assets = await this.#assets(ctx);
      const contracts = new Map([[ctx.r.token.toLowerCase(), { role: 'token', iface: ERC20 }],
        [assets.asset.address.toLowerCase(), { role: 'asset', iface: ERC20 }], [ctx.r.router.toLowerCase(), { role: 'router', iface: ROUTER }],
        [ctx.r.hook.toLowerCase(), { role: 'hook', iface: HOOK }], [ctx.venue.record.attestor.toLowerCase(), { role: 'attestor', iface: ATTESTOR }]]);
      const scope = { fundId: ctx.fund.id, wallet: ctx.wallet, chainId: ctx.chainId, policyHash: ctx.policy.hash };
      const normalize = (address, event, txHash, blockNumber, blockHash, logIndex) => {
        const contract = contracts.get(address?.toLowerCase());
        if (!contract || !event || !HASH.test(txHash) || !HASH.test(blockHash) || !Number.isSafeInteger(blockNumber)
          || !Number.isSafeInteger(logIndex) || blockNumber < 0 || logIndex < 0) return null;
        const a = event.args; const name = event.name; const data = {};
        if (name === 'Transfer') {
          if (!eq(a.from, ctx.wallet) && !eq(a.to, ctx.wallet)) return null;
          const other = eq(a.from, ctx.wallet) ? a.to : a.from;
          if (contract.role === 'asset' && ![ctx.r.router, ctx.r.hook, ctx.r.poolManager].some((known) => eq(known, other))) return null;
          Object.assign(data, { from: a.from, to: a.to, amountRaw: String(a.value), amount: formatUnits(a.value, assets[contract.role].decimals) });
        } else if (name === 'Approval') {
          if (!eq(a.owner, ctx.wallet) || !eq(a.spender, ctx.r.router)) return null;
          Object.assign(data, { owner: a.owner, spender: a.spender, amountRaw: String(a.value), amount: formatUnits(a.value, assets[contract.role].decimals) });
        } else {
          if (!eq(a.subject, ctx.wallet)) return null;
          if (contract.role === 'attestor') {
            if (!eq(a.policyHash, ctx.policy.hash)) return null;
            data.policyHash = ctx.policy.hash;
            if (name === 'Attested') Object.assign(data, { known: String(a.known), value: String(a.value), expiresAt: Number(a.expiresAt) });
            if (name === 'Revoked') data.clearedBits = String(a.clearedBits);
            if (name === 'Overridden') data.bits = String(a.bits);
          } else if (name === 'Executed' || name === 'CashierExecuted') {
            if (!ctx.r.cashier?.enabled) return null;
            if (name === 'CashierExecuted' && !eq(a.termsHash, ctx.policy.cashier?.termsHash)) return null;
            if (name === 'Executed' && ![1, 2].includes(Number(a.route))) return null;
            Object.assign(data, { amountIn: formatUnits(a.amountIn, 6), amountOut: formatUnits(a.amountOut, 6),
              ...(name === 'Executed' ? { route: ROUTES[Number(a.route)] } : { buy: a.buy, termsHash: a.termsHash }) });
          } else return null;
        }
        return { ...scope, contract: getAddress(address), event: name, txHash, blockNumber, blockHash, logIndex, ...data };
      };
      const finish = (events) => [...new Map(events.filter(Boolean).map((event) => [`${event.txHash}:${event.logIndex}:${event.contract}`, event])).values()]
        .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex).slice(0, 100);
      let indexer = { status: 'not-configured' };
      if (ctx.venue.multibaas) {
        try {
          const rows = await indexedAddressEvents(ctx.venue.multibaas, [...contracts.keys()]);
          const events = finish(rows.map((row) => {
            try {
              const e = row.event; const tx = row.transaction; const address = e?.contract?.address;
              const contract = contracts.get(address?.toLowerCase()); if (!contract) return null;
              const fragment = contract.iface.getEvent(e.name);
              if (!fragment || (e.signature !== fragment.format('sighash') && !eq(e.signature, fragment.topicHash))) return null;
              // ABI round-trip rejects malformed fields and strips every unrecognized provider property.
              const encoded = contract.iface.encodeEventLog(fragment, fragment.inputs.map((field) => e.inputs.find((input) => input.name === field.name && !input.hashed)?.value));
              return normalize(address, contract.iface.parseLog(encoded), tx.txHash, tx.blockNumber, tx.blockHash, e.indexInLog);
            } catch { return null; }
          }));
          return { ...scope, source: 'multibaas', status: events.length ? 'indexed-events' : 'no-indexed-events',
            indexer: { status: events.length ? 'responding' : 'empty-or-delayed' }, complete: false, events,
            notice: 'Bounded indexer history, not RPC execution confirmation or a claim that indexing has caught up.' };
        } catch { indexer = { status: 'unavailable' }; }
      }
      const fromBlock = Math.max(0, ctx.block.number - 2000);
      try {
        const logs = await ctx.venue.provider.getLogs({ address: [...contracts.keys()], fromBlock, toBlock: ctx.block.number });
        const events = finish(logs.slice(-1000).map((log) => {
          if (log.removed) return null;
          try { return normalize(log.address, contracts.get(log.address.toLowerCase())?.iface.parseLog(log), log.transactionHash, log.blockNumber, log.blockHash, log.index); }
          catch { return null; }
        }));
        return { ...scope, source: 'rpc', status: 'recent-rpc-logs', indexer, complete: false, fromBlock, toBlock: ctx.block.number, events };
      } catch { return { ...scope, source: 'unavailable', status: 'activity-unavailable', indexer, complete: false, events: [] }; }
    });
  }
}
