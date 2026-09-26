// Operator service over the deployed two-act stack. Every action here is what the golden demo does
// in a terminal, exposed for the dashboard: attest facts, mint and release shares, drive the pool,
// admit lenders, ship and fill the buyback. Demo wallets are the local chain's unlocked accounts;
// on a public chain they are derived from the operator key and topped up with gas when funded.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Contract, MaxUint256, Wallet, ZeroHash, id, keccak256, formatUnits, parseEther, parseUnits, toUtf8Bytes } from 'ethers';
import { loadArtifacts } from './deploy.js';
import { decodeRefusal } from './refusal.js';
import { decodeCashierRefusal } from './policy/cashier-refusal.js';
import { loadOpcodes, buildBuybackProgram, buildDutchBuybackProgram, buildAquaOrder, encodeOrder, buildTakerData, buybackTermsFrom, disassemble } from './policy/programs.js';
import { AppError, ensure } from './errors.js';
import { indexedEvents } from './multibaas.js';
import { HumanRegistry, WorldIdError, WorldIdVerifier } from './worldid.js';

const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const TICK_SPACING = 60;
const M = 1_000_000n;
export const DEMO_WALLETS = ['Investor', 'Stranger', 'Lender A', 'Lender B', 'Lender C'];

export class VenueService {
  /// `auditPath` keeps the audit across restarts; without it the audit lives in memory only.
  /// `policies` ({ rwa: { policy, clauseTable }, credit }) may be given for a venue over another
  /// compiled agreement; otherwise the built artifacts' policies apply.
  constructor({ provider, signer, record, multibaas = null, auditPath = null, worldId = null, policies = null, log = () => {} }) {
    Object.assign(this, { provider, signer, record, multibaas, auditPath, log, policies, audit: [], orders: [] });
    this.worldId = worldId ?? { verifier: new WorldIdVerifier(), registry: new HumanRegistry(null) };
  }

  /// Indexed events from MultiBaas when a deployment is registered there; the local audit otherwise.
  async events(contractLabel, eventSignature) {
    if (!this.multibaas) return { source: 'local', events: this.audit };
    return { source: 'multibaas', events: await indexedEvents(this.multibaas, { contractLabel, eventSignature }) };
  }

  async init() {
    const rwa = await loadArtifacts('rwa-secondary', ['PolicyAttestor', 'PolicyOracle', 'MockSanctionsOracle', 'MockERC20', 'CompiledMirrorToken', 'MirrorPolicyHook', 'MirrorLiquidityRouter', 'PoolManager']);
    const credit = await loadArtifacts('wildcat-credit', ['PolicyOracle', 'MirrortechRoleProvider', 'MockWildcatMarket', 'MirrortechRouter', 'Aqua']);
    this.policies ??= { rwa: { policy: rwa.policy, clauseTable: rwa.clauseTable }, credit: { policy: credit.policy, clauseTable: credit.clauseTable } };
    ensure(Boolean(this.policies.rwa.policy.cashier) === Boolean(this.record.rwa.cashier?.enabled), 503, 'CASHIER_BINDING_MISMATCH', 'Preserve deployment.router and deployment.cashier in the per-agreement venue record');
    this.artifacts = { rwa: rwa.artifacts, credit: credit.artifacts };
    this.bind(this.signer);
    this.wallets = { Operator: await this.signer.getAddress() };
    if (this.record.chainId === 31337) {
      for (const [index, name] of DEMO_WALLETS.entries()) this.wallets[name] = await (await this.provider.getSigner(index + 1)).getAddress();
    } else if (this.signer.privateKey) {
      this.demo = DEMO_WALLETS.map((name) => new Wallet(keccak256(toUtf8Bytes(`mirr0tech-demo:${this.signer.privateKey}:${name}`)), this.provider));
      for (const [index, name] of DEMO_WALLETS.entries()) this.wallets[name] = this.demo[index].address;
    }
    this.opcodes = loadOpcodes();
    if (this.auditPath) this.audit = await readFile(this.auditPath, 'utf8').then(JSON.parse, () => []);
    ensure(this.worldId.verifier.mock || this.worldId.registry.path, 503, 'WORLD_REGISTRY_REQUIRED', 'Live World ID requires durable credential-scoped binding storage');
    await this.worldId.registry.load();
    return this;
  }
  bind(signer) {
    const at = (address, artifact) => new Contract(address, artifact.abi, signer);
    const r = this.record;
    const { rwa, credit } = this.artifacts;
    this.c = {
      attestor: at(r.attestor, rwa.PolicyAttestor), sanctions: at(r.sanctions, rwa.MockSanctionsOracle), usdc: at(r.usdc, rwa.MockERC20),
      token: at(r.rwa.token, rwa.CompiledMirrorToken), hook: at(r.rwa.hook, r.rwa.cashier ? { abi: r.rwa.cashier.hookAbi } : rwa.MirrorPolicyHook), rwaOracle: at(r.rwa.oracle, rwa.PolicyOracle),
      poolManager: at(r.rwa.poolManager, rwa.PoolManager), v4Router: at(r.rwa.router, r.rwa.cashier ? { abi: r.rwa.cashier.routerAbi } : rwa.MirrorLiquidityRouter),
      ...(r.rwa.cashier ? { cashierAsset: at(r.rwa.cashier.asset, rwa.MockERC20) } : {}),
      roleProvider: at(r.credit.roleProvider, credit.MirrortechRoleProvider), market: at(r.credit.market, credit.MockWildcatMarket),
      aqua: at(r.credit.aqua, credit.Aqua), swapRouter: at(r.credit.router, credit.MirrortechRouter),
    };
  }
  /// Signs from `signer` from now on: every handle rebinds and the operator wallet is its address.
  async useSigner(signer) {
    this.signer = signer;
    this.bind(signer);
    this.wallets.Operator = await signer.getAddress();
  }
  /// Hands the operator's roles to `address` (attest, watch, override; mint and admin on the fund
  /// token and on `tokens`), plus `gas` in ETH, so a vault key can take over. The current signer must
  /// hold the admin roles; grants already in place are skipped.
  async handover(address, { gas = null, tokens = [] } = {}) {
    const txs = {};
    const grant = async (contract, label, role) => {
      const hash = role === 'DEFAULT_ADMIN_ROLE' ? ZeroHash : id(role);
      if (await contract.hasRole(hash, address)) return;
      txs[`${label}.${role}`] = (await (await contract.grantRole(hash, address)).wait()).hash;
    };
    for (const role of ['ATTESTOR_ROLE', 'WATCHER_ROLE', 'BORROWER_ROLE']) await grant(this.c.attestor, 'attestor', role);
    for (const [index, token] of [this.c.token, ...tokens.map((at) => new Contract(at, this.artifacts.rwa.CompiledMirrorToken.abi, this.signer))].entries()) {
      for (const role of ['MINTER_ROLE', 'DEFAULT_ADMIN_ROLE']) await grant(token, index ? `token:${await token.getAddress()}` : 'token', role);
    }
    if (gas) txs.gas = (await (await this.signer.sendTransaction({ to: address, value: parseEther(gas) })).wait()).hash;
    const entry = { id: id(`handover:${address}:${Date.now()}`).slice(0, 18), at: new Date().toISOString(), type: 'signing.handover', from: this.wallets.Operator, to: address, status: 'ok', txs };
    this.audit.push(entry);
    await this.persist();
    return txs;
  }
  /// A load-balanced RPC can serve a receipt from one node and the next call from a node still a
  /// block behind; a quote right after a ship would then see no strategy. Wait until the RPC reads
  /// the receipt's block before returning to the caller.
  async settled(blockNumber, { attempts = 40, delayMs = 250 } = {}) {
    for (let i = 0; i < attempts; i++) {
      if ((await this.provider.getBlockNumber()) >= blockNumber) return true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
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
      if (receipt) await this.settled(receipt.blockNumber);
      if (receipt && type === 'rwa.cashier.swap') {
        const executed = receipt.logs.filter((log) => log.address.toLowerCase() === this.record.rwa.router.toLowerCase())
                  .map((log) => { try { return this.c.v4Router.interface.parseLog(log); } catch { return null; } }).find((event) => event?.name === 'Executed');
        if (executed) Object.assign(entry, { actualRoute: ['auto', 'amm', 'cashier'][Number(executed.args.route)], amountOut: formatUnits(executed.args.amountOut, 6) });
      }
      Object.assign(entry, { status: 'ok', txHash: receipt?.hash ?? null, ...(receipt ? {} : { result }) });
      this.audit.push(entry);
      await this.persist();
      return entry;
    } catch (error) {
      const table = this.policy(details.policy ?? 'credit').clauseTable;
      const refusal = decodeCashierRefusal(error, table) ?? decodeRefusal(error, table);
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
  /// Replaces the wallet's facts, except `identityVerified`: only a World ID proof sets it, so a
  /// plain attestation that does not mention it keeps it.
  async attestationWindow(kind, address, days, preserve = false) {
    ensure(Number.isInteger(days) && days > 0 && days <= 90, 400, 'INVALID_VALIDITY', 'Attestation validity must be 1 to 90 whole days');
    const now = (await this.provider.getBlock('latest')).timestamp;
    let expiresAt = now + days * 86400;
    if (preserve) {
      const previous = Number(await this.c.attestor.expiresAt(address, this.policy(kind).policy.hash));
      if (previous > now) expiresAt = Math.min(expiresAt, previous);
    }
    return { now, expiresAt };
  }
  checkAttestedFacts(facts) {
    ensure(facts && typeof facts === 'object' && !Array.isArray(facts), 400, 'INVALID_FACTS', 'facts must be an object');
    ensure(facts.identityVerified !== true, 403, 'WORLD_PROOF_REQUIRED', 'Only a server-verified World ID proof may grant identityVerified');
  }
  async attest(kind, wallet, facts, days = 30) {
    this.checkAttestedFacts(facts);
    const address = this.address(wallet);
    const { policy } = this.policy(kind);
    if (!('identityVerified' in facts) && policy.factOrder.includes('identityVerified')) {
      const [wasKnown, wasValue] = await this.c.attestor.factsOf(address, policy.hash);
      const bit = 1n << BigInt(policy.factOrder.indexOf('identityVerified'));
      if (wasKnown & bit & wasValue) facts = { ...facts, identityVerified: true };
    }
    const { known, value } = this.pack(kind, facts);
    const { now, expiresAt } = await this.attestationWindow(kind, address, days, facts.identityVerified === true);
    return this.run('attest', { policy: kind, wallet: this.name(address), facts }, () => this.c.attestor.attest(address, policy.hash, known, value, now, expiresAt));
  }
  /// Adds facts to what is already attested instead of replacing the set.
  async attestMerged(kind, wallet, facts, days = 30) {
    this.checkAttestedFacts(facts);
    const address = this.address(wallet);
    const { known, value } = this.pack(kind, facts);
    const { policy } = this.policy(kind);
    const { now, expiresAt } = await this.attestationWindow(kind, address, days, true);
    return this.run('attest', { policy: kind, wallet: this.name(address), facts }, async () => {
      const [wasKnown, wasValue] = await this.c.attestor.factsOf(address, policy.hash);
      return this.c.attestor.attest(address, policy.hash, wasKnown | known, (wasValue & ~known) | value, now, expiresAt);
    });
  }
  /// A World ID credential proof for `wallet`: verified, its nullifier bound to this wallet, then
  /// attested as `identityVerified` under the fund policy so every venue reads it.
  async verifyHuman(wallet, proof, days = 30) {
    const address = this.address(wallet);
    const { now, expiresAt } = await this.attestationWindow('rwa', address, days, true);
    let verification;
    let nullifier;
    try {
      verification = await this.worldId.verifier.verify(proof, address);
      ({ nullifier } = verification);
      await this.worldId.registry.bind(nullifier, address);
    } catch (error) {
      if (!(error instanceof WorldIdError)) throw error;
      this.audit.push({ id: id(`worldid:${Date.now()}:${Math.random()}`).slice(0, 18), at: new Date().toISOString(), type: 'worldid.verify', policy: 'rwa', wallet: this.name(address), status: 'refused', refusal: { name: error.code, clauseId: null, clause: null }, message: error.message });
      await this.persist();
      throw new AppError(error.status, error.code, error.message);
    }
    const { policy } = this.policy('rwa');
    const { known, value } = this.pack('rwa', { identityVerified: true });
    const { credential, action, environment, mock } = verification;
    return this.run('worldid.verify', { policy: 'rwa', wallet: this.name(address), credential, action, environment, mock, expiresAt, nullifier: `${nullifier.slice(0, 10)}…`, facts: { identityVerified: true } }, async () => {
      const [wasKnown, wasValue] = await this.c.attestor.factsOf(address, policy.hash);
      return this.c.attestor.attest(address, policy.hash, wasKnown | known, (wasValue & ~known) | value, now, expiresAt);
    });
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
    if (this.c.cashierAsset) {
      await (await this.c.cashierAsset.mint(address, parseUnits(amount, 6))).wait();
      await (await this.c.cashierAsset.connect(signer).approve(this.record.rwa.router, MaxUint256)).wait();
    }
    await (await this.c.token.connect(signer).approve(this.record.rwa.router, MaxUint256)).wait();
    await (await this.c.market.connect(signer).approve(this.record.credit.router, MaxUint256)).wait();
    return { wallet: this.name(address), funded: amount };
  }
  /// A settled payment from the rail: the funds fact is attested, then the policy decides the mint.
  /// The same payment id settles once (`ok` or `held`); a refusal holds the money and records the
  /// sentence; a chain error is `failed` and the rail's retry tries again.
  async settlePayment({ id: paymentId, wallet, amount, reference = null }) {
    ensure(!this.record.rwa.cashier, 409, 'CASHIER_PAYMENT_UNSUPPORTED', 'Cashier subscriptions require bounded mockUSD settlement; the legacy one-USD-per-share webhook cannot issue this token');
    const seen = this.audit.find((entry) => entry.type === 'payment.settle' && entry.paymentId === paymentId && entry.status !== 'failed');
    if (seen) return { ...seen, replay: true };
    const address = this.address(wallet);
    await this.attestMerged('rwa', address, { depositConfirmed: true });
    const decision = await this.explain('rwa', address, 'mint');
    const entry = { id: id(`payment:${paymentId}:${Date.now()}`).slice(0, 18), at: new Date().toISOString(), type: 'payment.settle', policy: 'rwa', paymentId, reference, wallet: this.name(address), amount };
    if (!decision.allowed) {
      Object.assign(entry, { status: 'held', refusal: { name: 'PolicyRefused', clause: decision.clause, subject: this.name(address) } });
    } else {
      try {
        const minted = await this.mint(amount);
        const released = await this.release(address, amount);
        Object.assign(entry, { status: 'ok', txHash: released.txHash, mintTxHash: minted.txHash });
      } catch (error) {
        const refusal = error.details?.refusal;
        if (refusal?.clause) Object.assign(entry, { status: 'held', refusal });
        else Object.assign(entry, { status: 'failed', message: error.message });
      }
    }
    this.audit.push(entry);
    await this.persist();
    return entry;
  }
  mint(amount) { return this.run('rwa.mint', { policy: 'rwa', amount }, () => this.c.token.mint(id(`mint:${Date.now()}`), parseUnits(amount, 6))); }
  release(wallet, amount) {
    const address = this.address(wallet);
    return this.run('rwa.release', { policy: 'rwa', wallet: this.name(address), amount }, () => this.c.token.release(id(`release:${Date.now()}`), address, parseUnits(amount, 6)));
  }
  poolKey(hooked) {
    if (this.record.rwa.cashier) {
      ensure(this.record.rwa.poolKey, 503, 'CASHIER_BINDING_MISMATCH', 'Cashier venue requires the deployed pool key');
      return { ...this.record.rwa.poolKey, hooks: hooked ? this.record.rwa.hook : '0x0000000000000000000000000000000000000000' };
    }
    const asset = this.record.rwa.cashier?.asset ?? this.record.usdc;
    const [currency0, currency1] = BigInt(this.record.rwa.token) < BigInt(asset) ? [this.record.rwa.token, asset] : [asset, this.record.rwa.token];
    return { currency0, currency1, fee: 3000, tickSpacing: TICK_SPACING, hooks: hooked ? this.record.rwa.hook : '0x0000000000000000000000000000000000000000' };
  }
  async createPool(wallet, hooked) {
    const signer = await this.signerFor(wallet);
    return this.run('rwa.pool.create', { policy: 'rwa', wallet: this.name(this.address(wallet)), hooked }, () => this.c.poolManager.connect(signer).initialize(this.poolKey(hooked), this.record.rwa.cashier?.initialSqrtPriceX96 ?? SQRT_PRICE_1_1));
  }
  async addLiquidity(wallet, hooked) {
    const signer = await this.signerFor(wallet);
    const key = this.poolKey(hooked);
    // A full-range demo position covers arbitrary deployed NAVs without assuming tick zero.
    const position = this.record.rwa.cashier
      ? { tickLower: Math.ceil(-887272 / key.tickSpacing) * key.tickSpacing, tickUpper: Math.floor(887272 / key.tickSpacing) * key.tickSpacing, liquidityDelta: 10n ** 9n, salt: id('position') }
      : { tickLower: -TICK_SPACING, tickUpper: TICK_SPACING, liquidityDelta: 10n ** 12n, salt: id('position') };
    return this.run('rwa.pool.addLiquidity', { policy: 'rwa', wallet: this.name(this.address(wallet)), hooked }, () =>
      this.c.v4Router.connect(signer).modifyLiquidity(key, position));
  }
  async swap(wallet, hooked) {
    ensure(!this.record.rwa.cashier, 400, 'BOUNDED_ORDER_REQUIRED', 'Use /rwa/cashier/swap with amount, minOut and deadline for this agreement');
    const signer = await this.signerFor(wallet);
    return this.run('rwa.pool.swap', { policy: 'rwa', wallet: this.name(this.address(wallet)), hooked }, () =>
      this.c.v4Router.connect(signer).swap(this.poolKey(hooked), { zeroForOne: true, amountSpecified: -1000n, sqrtPriceLimitX96: SQRT_PRICE_1_1 - 1000n }));
  }

  requireCashier() {
    ensure(this.record.rwa.cashier?.enabled, 409, 'NO_CASHIER', 'This agreement did not opt in to the DEMO NAV cashier');
    return this.record.rwa.cashier;
  }
  cashierAmount(amount) {
    ensure(typeof amount === 'string' && amount.length <= 40 && /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(amount), 400, 'INVALID_AMOUNT', 'Use a positive decimal string with at most six decimals');
    const units = parseUnits(amount, 6);
    ensure(units > 0n && units < 2n ** 127n, 400, 'INVALID_AMOUNT', 'Amount must fit a positive int128');
    return units;
  }
  async cashierState() {
    const cashier = this.requireCashier();
    return { demo: true, policyHash: this.policy('rwa').policy.hash, ...this.policy('rwa').policy.cashier,
      hook: this.record.rwa.hook, router: this.record.rwa.router, asset: cashier.asset, poolKey: this.poolKey(true),
      reserve: formatUnits(await this.c.cashierAsset.balanceOf(this.record.rwa.hook), 6),
      totalSupply: formatUnits(await this.c.token.totalSupply(), 6), maxSupply: formatUnits(await this.c.token.maxSupply(), 6),
      routes: ['auto', 'amm', 'cashier'], limitations: 'Fixed DEMO NAV; prefunded reserve only; no universal arbitrage or LP-loss guarantee. Quote is not an execution guarantee.' };
  }
  async cashierQuote({ buy, amount }) {
    this.requireCashier();
    ensure(typeof buy === 'boolean', 400, 'INVALID_BODY', 'buy must be boolean');
    const units = this.cashierAmount(amount);
    let out;
    try { out = await this.c.hook.quote(buy, units); } catch (error) {
      const refusal = decodeCashierRefusal(error, this.policy('rwa').clauseTable);
      if (!refusal) throw error;
      throw new AppError(403, 'POLICY_REFUSED', refusal.description, { refusal });
    }
    return { kind: 'nav-only', executable: null, buy, amount, amountOut: formatUnits(out, 6),
      policyHash: this.policy('rwa').policy.hash, termsHash: this.policy('rwa').policy.cashier.termsHash };
  }
  async cashierSwap(wallet, { buy, amount, minOut, deadline, route = 'auto' }) {
    this.requireCashier();
    ensure(typeof buy === 'boolean' && ['auto', 'amm', 'cashier'].includes(route), 400, 'INVALID_BODY', 'buy must be boolean; route is auto, amm or cashier');
    ensure(Number.isSafeInteger(deadline) && deadline > 0, 400, 'INVALID_BODY', 'deadline must be a positive Unix timestamp in seconds');
    const units = this.cashierAmount(amount);
    const minimum = this.cashierAmount(minOut);
    const signer = await this.signerFor(wallet);
    const key = this.poolKey(true);
    const zeroForOne = (key.currency0.toLowerCase() === this.record.rwa.cashier.asset.toLowerCase()) === buy;
    return this.run('rwa.cashier.swap', { policy: 'rwa', wallet: this.name(this.address(wallet)), buy, amount, minOut, deadline, route }, () =>
      this.c.v4Router.connect(signer).swap(key, { zeroForOne, amountSpecified: -units,
        sqrtPriceLimitX96: zeroForOne ? 4295128740n : 1461446703485210103287273052203988822378723970341n }, minimum, deadline, ['auto', 'amm', 'cashier'].indexOf(route)));
  }
  async cashierPrefund(wallet, amount) {
    this.requireCashier();
    const units = this.cashierAmount(amount);
    const signer = await this.signerFor(wallet);
    return this.run('rwa.cashier.prefund', { policy: 'rwa', wallet: this.name(this.address(wallet)), amount }, () =>
      this.c.cashierAsset.connect(signer).transfer(this.record.rwa.hook, units));
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
