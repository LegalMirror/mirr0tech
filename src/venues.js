// Operator service over the deployed two-act stack. Every action here is what the golden demo does
// in a terminal, exposed for the dashboard: attest facts, mint and release shares, drive the pool,
// admit lenders, ship and fill the buyback. Demo wallets are the local chain's unlocked accounts;
// on a public chain they are derived from the operator key and topped up with gas when funded.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Contract, MaxUint256, Wallet, id, keccak256, formatUnits, parseEther, parseUnits, toUtf8Bytes } from 'ethers';
import { loadArtifacts } from './deploy.js';
import { decodeRefusal } from './refusal.js';
import { loadOpcodes, buildBuybackProgram, buildDutchBuybackProgram, buildAquaOrder, encodeOrder, buildTakerData, buybackTermsFrom, disassemble } from './policy/programs.js';
import { AppError } from './errors.js';
import { indexedEvents } from './multibaas.js';

const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const TICK_SPACING = 60;
const M = 1_000_000n;
export const DEMO_WALLETS = ['Investor', 'Stranger', 'Lender A', 'Lender B', 'Lender C'];

export class VenueService {
  /// `auditPath` keeps the audit across restarts; without it the audit lives in memory only.
  constructor({ provider, signer, record, multibaas = null, auditPath = null, log = () => {} }) {
    Object.assign(this, { provider, signer, record, multibaas, auditPath, log, audit: [], orders: [] });
  }

  /// Indexed events from MultiBaas when a deployment is registered there; the local audit otherwise.
  async events(contractLabel, eventSignature) {
    if (!this.multibaas) return { source: 'local', events: this.audit };
    return { source: 'multibaas', events: await indexedEvents(this.multibaas, { contractLabel, eventSignature }) };
  }

  async init() {
    const rwa = await loadArtifacts('rwa-secondary', ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockERC20', 'CompiledMirrorToken', 'MirrorPolicyHook', 'MirrorLiquidityRouter', 'PoolManager']);
    const credit = await loadArtifacts('wildcat-credit', ['PolicyOracle', 'MirrortechRoleProvider', 'MockWildcatMarket', 'MirrortechRouter', 'Aqua']);
    this.policies = { rwa: { policy: rwa.policy, clauseTable: rwa.clauseTable }, credit: { policy: credit.policy, clauseTable: credit.clauseTable } };
    const at = (address, artifact, signer = this.signer) => new Contract(address, artifact.abi, signer);
    const r = this.record;
    this.c = {
      attestor: at(r.attestor, rwa.artifacts.PolicyAttestor), sanctions: at(r.sanctions, rwa.artifacts.MockSanctionsOracle), usdc: at(r.usdc, rwa.artifacts.MockERC20),
      token: at(r.rwa.token, rwa.artifacts.CompiledMirrorToken), hook: at(r.rwa.hook, rwa.artifacts.MirrorPolicyHook), rwaOracle: at(r.rwa.oracle, rwa.artifacts.PolicyOracle),
      poolManager: at(r.rwa.poolManager, rwa.artifacts.PoolManager), v4Router: at(r.rwa.router, rwa.artifacts.MirrorLiquidityRouter),
      roleProvider: at(r.credit.roleProvider, credit.artifacts.MirrortechRoleProvider), market: at(r.credit.market, credit.artifacts.MockWildcatMarket),
      aqua: at(r.credit.aqua, credit.artifacts.Aqua), swapRouter: at(r.credit.router, credit.artifacts.MirrortechRouter),
    };
    this.wallets = { Operator: await this.signer.getAddress() };
    if (this.record.chainId === 31337) {
      for (const [index, name] of DEMO_WALLETS.entries()) this.wallets[name] = await (await this.provider.getSigner(index + 1)).getAddress();
    } else if (this.signer.privateKey) {
      this.demo = DEMO_WALLETS.map((name) => new Wallet(keccak256(toUtf8Bytes(`mirr0tech-demo:${this.signer.privateKey}:${name}`)), this.provider));
      for (const [index, name] of DEMO_WALLETS.entries()) this.wallets[name] = this.demo[index].address;
    }
    this.opcodes = loadOpcodes();
    if (this.auditPath) this.audit = await readFile(this.auditPath, 'utf8').then(JSON.parse, () => []);
    return this;
  }
  async persist() {
    if (!this.auditPath) return;
    await mkdir(dirname(this.auditPath), { recursive: true });
    await writeFile(this.auditPath, `${JSON.stringify(this.audit, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`);
  }

  // ---- helpers -------------------------------------------------------------------------------
  policy(kind) {
    if (!this.policies[kind]) throw new AppError(400, 'UNKNOWN_POLICY', 'policy must be rwa or credit');
    return this.policies[kind];
  }
  address(wallet) {
    if (typeof wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(wallet)) return wallet;
    const address = this.wallets[wallet];
    if (!address) throw new AppError(404, 'WALLET_NOT_FOUND', `Unknown wallet ${wallet}; use one of ${Object.keys(this.wallets).join(', ')} or an address`);
    return address;
  }
  async signerFor(wallet) {
    const address = this.address(wallet);
    if (address === this.wallets.Operator) return this.signer;
    if (this.record.chainId === 31337) return this.provider.getSigner(address);
    const demo = this.demo?.find((wallet) => wallet.address.toLowerCase() === address.toLowerCase());
    if (!demo) throw new AppError(400, 'NOT_LOCAL', 'Acting as this wallet needs the local chain or a derived demo wallet');
    return demo;
  }
  name(address) { return Object.entries(this.wallets).find(([, value]) => value.toLowerCase() === address.toLowerCase())?.[0] ?? address; }
  pack(kind, facts) {
    const order = this.policy(kind).policy.factOrder;
    let known = 0n; let value = 0n;
    for (const [name, boolean] of Object.entries(facts)) {
      const index = order.indexOf(name);
      if (index < 0) throw new AppError(400, 'UNKNOWN_FACT', `Unknown fact ${name}`);
      known |= 1n << BigInt(index);
      if (boolean === true) value |= 1n << BigInt(index);
    }
    return { known, value };
  }
  clause(kind, clauseId) { return clauseId ? this.policy(kind).clauseTable.clauses[Number(clauseId) - 1] ?? null : null; }
  async run(type, details, action) {
    const entry = { id: id(`${type}:${Date.now()}:${Math.random()}`).slice(0, 18), at: new Date().toISOString(), type, ...details };
    try {
      const result = await action();
      const receipt = result?.wait ? await result.wait() : null;
      Object.assign(entry, { status: 'ok', txHash: receipt?.hash ?? null, ...(receipt ? {} : { result }) });
      this.audit.push(entry);
      await this.persist();
      return entry;
    } catch (error) {
      const refusal = decodeRefusal(error, this.policy(details.policy ?? 'credit').clauseTable);
      Object.assign(entry, { status: 'refused', refusal: refusal ? { ...refusal, subject: refusal.subject ? this.name(refusal.subject) : null } : null, message: error.shortMessage ?? error.message });
      this.audit.push(entry);
      await this.persist();
      throw new AppError(refusal ? 403 : 500, refusal ? 'POLICY_REFUSED' : 'CHAIN_ERROR', refusal?.clause ? `${refusal.name}: ${refusal.clause.clause} — ${refusal.clause.quote}` : (refusal?.name ?? error.shortMessage ?? error.message), entry);
    }
  }

  // ---- read side ------------------------------------------------------------------------------
  overview() { return { deployment: this.record, wallets: this.wallets, policies: Object.fromEntries(Object.entries(this.policies).map(([kind, value]) => [kind, { policyHash: value.policy.hash, clauseTableHash: value.clauseTable.clauseTableHash, profile: value.policy.profile, components: value.policy.components }])) }; }
  async explain(kind, wallet, action) {
    const address = this.address(wallet);
    const { policy, clauseTable } = this.policy(kind);
    const index = policy.actionOrder.indexOf(action);
    if (index < 0) throw new AppError(400, 'UNKNOWN_ACTION', `Unknown action ${action}`);
    let allowed; let clauseId; let known = 0n; let value = 0n;
    if (kind === 'rwa') { [allowed, clauseId] = await this.c.rwaOracle.decide(address, index); [known, value] = await this.c.rwaOracle.facts(address); }
    else [allowed, clauseId, , known, value] = await this.c.roleProvider.explain(address, index);
    const facts = Object.fromEntries(policy.factOrder.map((name, i) => [name, (known >> BigInt(i)) & 1n ? ((value >> BigInt(i)) & 1n ? true : false) : null]));
    const clause = this.clause(kind, clauseId);
    return { wallet: this.name(address), address, action, allowed, clauseId: Number(clauseId), clause, facts,
      sanctioned: await this.c.sanctions.isSanctioned(address), screeningCurrent: await this.c.attestor.isCurrent(address, policy.hash) };
  }
  async wallet(wallet) {
    const address = this.address(wallet);
    return {
      name: this.name(address), address,
      balances: { mUSDC: formatUnits(await this.c.usdc.balanceOf(address), 6), MIRROR: formatUnits(await this.c.token.balanceOf(address), 6), mDEMO: formatUnits(await this.c.market.balanceOf(address), 6) },
      credential: (await this.c.roleProvider.getCredential(address)) !== 0n,
      sanctioned: await this.c.sanctions.isSanctioned(address),
      rwa: await this.explain('rwa', address, 'transfer'), credit: await this.explain('credit', address, 'deposit'),
    };
  }

  // ---- facts -----------------------------------------------------------------------------------
  async attest(kind, wallet, facts, days = 30) {
    const address = this.address(wallet);
    const { known, value } = this.pack(kind, facts);
    const { policy } = this.policy(kind);
    const now = (await this.provider.getBlock('latest')).timestamp;
    return this.run('attest', { policy: kind, wallet: this.name(address), facts }, () => this.c.attestor.attest(address, policy.hash, known, value, now, now + days * 86400));
  }
  async revoke(kind, wallet, facts) {
    const address = this.address(wallet);
    const { known } = this.pack(kind, Object.fromEntries(facts.map((name) => [name, true])));
    return this.run('revoke', { policy: kind, wallet: this.name(address), facts }, () => this.c.attestor.revokeFacts(address, this.policy(kind).policy.hash, known));
  }
  async override(wallet) {
    const address = this.address(wallet);
    const { known } = this.pack('credit', { borrowerOverride: true });
    return this.run('override', { policy: 'credit', wallet: this.name(address) }, () => this.c.attestor.overrideFacts(address, this.policies.credit.policy.hash, known));
  }
  async sanction(wallet, sanctioned) {
    const address = this.address(wallet);
    return this.run('sanction', { wallet: this.name(address), sanctioned }, () => this.c.sanctions.setSanctioned(address, sanctioned));
  }

  // ---- Act 1 -------------------------------------------------------------------------------------
  async fund(wallet, amount) {
    const address = this.address(wallet);
    if (this.record.chainId !== 31337 && address !== this.wallets.Operator && await this.provider.getBalance(address) < parseEther('0.01')) {
      await (await this.signer.sendTransaction({ to: address, value: parseEther('0.02') })).wait();
    }
    await (await this.c.usdc.mint(address, parseUnits(amount, 6))).wait();
    const signer = await this.signerFor(wallet);
    for (const spender of [this.record.rwa.router, this.record.credit.market, this.record.credit.router, this.record.credit.aqua]) {
      await (await this.c.usdc.connect(signer).approve(spender, MaxUint256)).wait();
    }
    await (await this.c.token.connect(signer).approve(this.record.rwa.router, MaxUint256)).wait();
    await (await this.c.market.connect(signer).approve(this.record.credit.router, MaxUint256)).wait();
    return { wallet: this.name(address), funded: amount };
  }
  mint(amount) { return this.run('rwa.mint', { policy: 'rwa', amount }, () => this.c.token.mint(id(`mint:${Date.now()}`), parseUnits(amount, 6))); }
  release(wallet, amount) {
    const address = this.address(wallet);
    return this.run('rwa.release', { policy: 'rwa', wallet: this.name(address), amount }, () => this.c.token.release(id(`release:${Date.now()}`), address, parseUnits(amount, 6)));
  }
  poolKey(hooked) {
    const [currency0, currency1] = BigInt(this.record.rwa.token) < BigInt(this.record.usdc) ? [this.record.rwa.token, this.record.usdc] : [this.record.usdc, this.record.rwa.token];
    return { currency0, currency1, fee: 3000, tickSpacing: TICK_SPACING, hooks: hooked ? this.record.rwa.hook : '0x0000000000000000000000000000000000000000' };
  }
  async createPool(wallet, hooked) {
    const signer = await this.signerFor(wallet);
    return this.run('rwa.pool.create', { policy: 'rwa', wallet: this.name(this.address(wallet)), hooked }, () => this.c.poolManager.connect(signer).initialize(this.poolKey(hooked), SQRT_PRICE_1_1));
  }
  async addLiquidity(wallet, hooked) {
    const signer = await this.signerFor(wallet);
    return this.run('rwa.pool.addLiquidity', { policy: 'rwa', wallet: this.name(this.address(wallet)), hooked }, () =>
      this.c.v4Router.connect(signer).modifyLiquidity(this.poolKey(hooked), { tickLower: -TICK_SPACING, tickUpper: TICK_SPACING, liquidityDelta: 10n ** 12n, salt: id('position') }));
  }
  async swap(wallet, hooked) {
    const signer = await this.signerFor(wallet);
    return this.run('rwa.pool.swap', { policy: 'rwa', wallet: this.name(this.address(wallet)), hooked }, () =>
      this.c.v4Router.connect(signer).swap(this.poolKey(hooked), { zeroForOne: true, amountSpecified: -1000n, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1000n }));
  }

  // ---- Act 2 -------------------------------------------------------------------------------------
  async deposit(wallet, amount) {
    const signer = await this.signerFor(wallet);
    return this.run('credit.deposit', { policy: 'credit', wallet: this.name(this.address(wallet)), amount }, () => this.c.market.connect(signer).deposit(parseUnits(amount, 6)));
  }
  async withdraw(wallet, amount) {
    const signer = await this.signerFor(wallet);
    return this.run('credit.withdraw', { policy: 'credit', wallet: this.name(this.address(wallet)), amount }, () => this.c.market.connect(signer).withdraw(parseUnits(amount, 6)));
  }
  async shipBuyback({ auction = false } = {}) {
    const { policy } = this.policies.credit;
    const terms = buybackTermsFrom(policy);
    const now = (await this.provider.getBlock('latest')).timestamp;
    const deadline = Math.min(terms.deadlineTimestamp, now + 30 * 86400);
    if (auction && !terms.ceiling) throw new AppError(400, 'NO_AUCTION_TERMS', 'The addendum carries no ceiling or window for an auction');
    const common = {
      opcodes: this.opcodes, policyGuardOpcode: this.record.credit.policyGuardOpcode, fixedRateBalancesOpcode: this.record.credit.fixedRateBalancesOpcode,
      policyHash: policy.hash, action: policy.actionOrder.indexOf('transfer'), deadline,
      positionToken: this.record.credit.market, asset: this.record.usdc, capPosition: terms.capPosition,
    };
    const program = auction
      ? buildDutchBuybackProgram({ ...common, capAssetFloor: terms.capAsset, floor: terms.price, ceiling: terms.ceiling, startTime: now, windowSeconds: terms.windowSeconds })
      : buildBuybackProgram({ ...common, capAsset: terms.capAsset });
    const shippedAsset = auction ? terms.capAssetCeiling : terms.capAsset;
    const order = buildAquaOrder(await this.signer.getAddress(), program);
    const strategy = encodeOrder(order);
    const strategyHash = keccak256(strategy);
    const summary = { strategyHash, maker: order.maker, program, deadline, kind: auction ? 'dutch-auction' : 'fixed-price',
      terms: { ...terms, capPosition: terms.capPosition.toString(), capAsset: terms.capAsset.toString(), capAssetCeiling: terms.capAssetCeiling?.toString() ?? null },
      instructions: disassemble(program, { ...this.opcodes, 'Mirrortech._policyGuard': this.record.credit.policyGuardOpcode, 'Mirrortech._fixedRateBalances': this.record.credit.fixedRateBalancesOpcode }),
      hashChain: { document: policy.source.textSha256, policyHash: policy.hash, programKeccak: keccak256(program), strategyHash }, status: 'shipped', fills: [] };
    await this.run('credit.buyback.ship', { policy: 'credit', strategyHash, kind: summary.kind }, () => this.c.aqua.ship(this.record.credit.router, strategy, [this.record.credit.market, this.record.usdc], [terms.capPosition, shippedAsset]));
    this.orders.push({ ...summary, order: { maker: order.maker, traits: order.traits.toString(), data: order.data }, strategy });
    return this.buyback();
  }
  async buyback() {
    const current = this.orders.at(-1);
    if (!current) return null;
    let balances = null;
    try {
      const [position, asset] = await this.c.aqua.safeBalances(current.maker, this.record.credit.router, current.strategyHash, this.record.credit.market, this.record.usdc);
      balances = { position: formatUnits(position, 6), asset: formatUnits(asset, 6) };
    } catch { balances = null; }
    const { strategy, order, ...rest } = current;
    return { ...rest, balances, order };
  }
  currentOrder() {
    const current = this.orders.at(-1);
    if (!current) throw new AppError(404, 'NO_BUYBACK', 'Ship the buyback first');
    return current;
  }
  async quote(wallet, amount) {
    const current = this.currentOrder();
    const signer = await this.signerFor(wallet);
    const units = parseUnits(amount, 6);
    const now = (await this.provider.getBlock('latest')).timestamp;
    const order = { maker: current.order.maker, traits: BigInt(current.order.traits), data: current.order.data };
    const entry = await this.run('credit.buyback.quote', { policy: 'credit', wallet: this.name(this.address(wallet)), amount }, async () => {
      const [amountIn, amountOut] = await this.c.swapRouter.connect(signer).quote.staticCall(order, this.record.credit.market, this.record.usdc, units, buildTakerData({ threshold: 0n, deadline: now + 3600 }));
      return { amountIn: formatUnits(amountIn, 6), amountOut: formatUnits(amountOut, 6), price: Number(amountOut) / Number(amountIn) };
    });
    return entry.result;
  }
  async fill(wallet, amount) {
    const current = this.currentOrder();
    const signer = await this.signerFor(wallet);
    const units = parseUnits(amount, 6);
    const now = (await this.provider.getBlock('latest')).timestamp;
    const order = { maker: current.order.maker, traits: BigInt(current.order.traits), data: current.order.data };
    const entry = await this.run('credit.buyback.fill', { policy: 'credit', wallet: this.name(this.address(wallet)), amount }, () =>
      this.c.swapRouter.connect(signer).swap(order, this.record.credit.market, this.record.usdc, units, buildTakerData({ threshold: 0n, deadline: now + 3600 })));
    current.fills.push({ wallet: this.name(this.address(wallet)), amount, txHash: entry.txHash });
    return entry;
  }
  async dock() {
    const current = this.currentOrder();
    const entry = await this.run('credit.buyback.dock', { policy: 'credit', strategyHash: current.strategyHash }, () => this.c.aqua.dock(this.record.credit.router, current.strategyHash, [this.record.credit.market, this.record.usdc]));
    current.status = 'docked';
    return entry;
  }
}
