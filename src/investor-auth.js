import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { getAddress, verifyMessage } from 'ethers';
import { AppError, ensure } from './errors.js';
import { WorldIdError } from './worldid.js';

export const INVESTOR_AUTH_LIMITS = Object.freeze({
  challengeSeconds: 300, maxChallenges: 256, maxSessions: 256, maxInFlight: 32,
  rateWindowSeconds: 60, maxRateKeys: 1024,
  challengePerIp: 10, verifyPerIp: 20, challengeGlobal: 600, verifyGlobal: 1200,
  maxProofBytes: 16384,
});
const L = INVESTOR_AUTH_LIMITS;
const hash = (value) => createHash('sha256').update(value).digest();
const absentDigest = hash('mirr0tech:absent-investor-session');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const hex32 = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const uint256 = (value) => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value);
const canonical = (value) => `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
const challengeIdValid = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const unauthorized = () => new AppError(401, 'INVESTOR_UNAUTHORIZED', 'A valid investor access token is required');
const unavailable = () => new AppError(503, 'INVESTOR_AUTH_UNAVAILABLE', 'Investor authentication is unavailable');
const stale = () => new AppError(401, 'CHALLENGE_INVALID', 'Challenge expired, cancelled or already used; request a fresh challenge');
const sameScope = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);

function fields(value, names) {
  ensure(object(value) && Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key)),
    400, 'INVALID_BODY', 'Invalid investor authentication request fields');
}
function validOrigin(value) {
  if (!text(value, 256)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}

// World can include arbitrary provider detail in errors. Only fixed, local messages cross this boundary.
const worldErrors = Object.freeze({
  INVALID_PROOF: [400, 'World ID proof verification failed'],
  WRONG_CREDENTIAL: [400, 'Investor login requires a Passport credential (schema 9303)'],
  APP_NOT_MIGRATED: [400, 'The World ID application must be migrated before login'],
  WORLD_INVALID_RESPONSE: [502, 'World ID returned an inconsistent verification result'],
  WORLD_TIMEOUT: [503, 'World ID verification timed out; request a fresh challenge'],
  WORLD_UNAVAILABLE: [503, 'World ID verification is unavailable; request a fresh challenge'],
  HUMAN_ALREADY_BOUND: [409, 'This World ID nullifier is already bound to another wallet'],
  REGISTRY_BUSY: [503, 'World ID binding storage is busy; request a fresh challenge'],
  REGISTRY_UNAVAILABLE: [503, 'World ID binding storage is unavailable'],
});
async function worldCall(operation, fallback = 'WORLD_UNAVAILABLE') {
  try { return await operation(); }
  catch (error) {
    const code = error instanceof WorldIdError && Object.hasOwn(worldErrors, error.code) ? error.code : fallback;
    throw new WorldIdError(worldErrors[code][0], code, worldErrors[code][1]);
  }
}

// Snapshot bounded JSON before the first await: callers cannot change the nonce or proof in flight.
function proofSnapshot(input) {
  let nodes = 0;
  function copy(value, depth = 0) {
    ensure(++nodes <= 256 && depth <= 8, 400, 'INVALID_PROOF', 'World ID proof exceeds structural limits');
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string') {
      ensure(value.length <= 2048, 400, 'INVALID_PROOF', 'World ID proof field is too long');
      return value;
    }
    if (Array.isArray(value)) {
      ensure(value.length <= 32, 400, 'INVALID_PROOF', 'World ID proof array is too long');
      return Object.freeze(Array.from(value, (item) => copy(item, depth + 1)));
    }
    ensure(object(value), 400, 'INVALID_PROOF', 'World ID proof must contain JSON data');
    const keys = Object.keys(value);
    ensure(keys.length <= 32 && keys.every((key) => key.length <= 64), 400, 'INVALID_PROOF', 'World ID proof has too many fields');
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, copy(value[key], depth + 1)])));
  }
  ensure(object(input), 400, 'INVALID_PROOF', 'Expected a World ID proof object');
  const result = copy(input);
  ensure(Buffer.byteLength(JSON.stringify(result)) <= L.maxProofBytes, 400, 'INVALID_PROOF', 'World ID proof is too large');
  return result;
}

export function publicSession(session) {
  const { wallet, fundId, policyHash, chainId, credential, environment, mock } = session;
  return { wallet, fundId, policyHash, chainId, credential, environment, mock };
}

export class InvestorAuth {
  #resolveFund;
  #allowedOrigins;
  #ttlSeconds;
  #allowLocalMock;
  #clock;
  #challenges = new Map();
  #sessions = new Map();
  #rates = new Map();
  #globalRates = new Map();
  #inFlight = 0;
  #sessionReservations = 0;

  constructor({ resolveFund, allowedOrigins, ttlSeconds = 900, allowLocalMock = false, clock = () => Date.now() } = {}) {
    ensure(typeof resolveFund === 'function' && typeof clock === 'function', 500, 'CONFIG', 'InvestorAuth requires a fund resolver and clock');
    ensure(Number.isSafeInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= 900, 500, 'CONFIG', 'Investor sessions must last between 1 and 900 seconds');
    ensure(typeof allowLocalMock === 'boolean', 500, 'CONFIG', 'Investor local mock opt-in must be a boolean');
    allowedOrigins ??= ['https://legalmirror.github.io', ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3100', 'http://127.0.0.1:3100'])];
    ensure(Array.isArray(allowedOrigins) && allowedOrigins.length <= 32 && allowedOrigins.every(validOrigin), 500, 'CONFIG', 'Configure explicit HTTP(S) origins without paths or wildcards');
    this.#resolveFund = resolveFund;
    this.#allowedOrigins = new Set(allowedOrigins);
    this.#ttlSeconds = ttlSeconds;
    this.#allowLocalMock = allowLocalMock;
    this.#clock = clock;
  }

  #now() {
    const value = this.#clock();
    ensure(Number.isSafeInteger(value) && value >= 0, 500, 'CONFIG', 'Invalid investor authentication clock');
    return Math.floor(value / 1000);
  }
  #prune(now) {
    for (const map of [this.#challenges, this.#sessions, this.#rates, this.#globalRates]) {
      for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
    }
  }
  #request(route, metadata) {
    fields(metadata, ['origin', 'clientIp']);
    const { origin, clientIp } = metadata;
    ensure(validOrigin(origin) && this.#allowedOrigins.has(origin), 403, 'ORIGIN_NOT_ALLOWED', 'Investor login is not allowed from this origin');
    ensure(typeof clientIp === 'string' && clientIp.length <= 45 && isIP(clientIp), 400, 'INVALID_CLIENT_IP', 'A server-resolved client IP is required');
    const now = this.#now();
    this.#prune(now);
    const ip = isIP(clientIp) === 6 ? new URL(`http://[${clientIp}]`).hostname : clientIp;
    const key = hash(`${route}:${ip}`).toString('hex');
    const global = this.#globalRates.get(route) ?? { count: 0, expiresAt: now + L.rateWindowSeconds };
    this.#globalRates.set(route, global);
    ensure(++global.count <= L[`${route}Global`], 429, 'AUTH_RATE_LIMITED', 'Too many investor authentication requests; retry later');
    ensure(this.#rates.has(key) || this.#rates.size < L.maxRateKeys, 429, 'AUTH_RATE_LIMITED', 'Too many investor authentication clients; retry later');
    const local = this.#rates.get(key) ?? { count: 0, expiresAt: now + L.rateWindowSeconds };
    this.#rates.set(key, local);
    ensure(++local.count <= L[`${route}PerIp`], 429, 'AUTH_RATE_LIMITED', 'Too many investor authentication requests; retry later');
    return { now, origin };
  }
  #enter() {
    ensure(this.#inFlight < L.maxInFlight, 503, 'AUTH_BUSY', 'Investor authentication is busy; retry later');
    this.#inFlight++;
  }

  async #fund(fundId) {
    let fund;
    try { fund = await this.#resolveFund(fundId); }
    catch (error) {
      if (error instanceof AppError && error.status === 404) throw new AppError(404, 'FUND_NOT_FOUND', 'Investor fund not found');
      throw unavailable();
    }
    ensure(fund && fund.id === fundId && fund.venue, 404, 'FUND_NOT_FOUND', 'Investor fund not found');
    const { venue } = fund;
    const verifier = venue.worldId?.verifier;
    const registry = venue.worldId?.registry;
    const policyHash = venue.record?.rwa?.policyHash;
    const chainId = venue.record?.chainId;
    ensure(hex32(policyHash) && Number.isSafeInteger(chainId) && chainId > 0
      && verifier && typeof verifier.context === 'function' && typeof verifier.verify === 'function'
      && typeof verifier.mock === 'boolean' && registry && typeof registry.bind === 'function',
    503, 'INVESTOR_AUTH_UNAVAILABLE', 'Fund authentication configuration is incomplete');
    const compiledHash = venue.policies?.rwa?.policy?.hash;
    ensure(compiledHash === undefined || (hex32(compiledHash) && compiledHash.toLowerCase() === policyHash.toLowerCase()),
      503, 'POLICY_MISMATCH', 'Fund policy does not match its deployment');
    ensure(verifier.credential === 'document', 403, 'WRONG_CREDENTIAL', 'Investor login requires a Passport credential (schema 9303)');
    ensure(!verifier.mock || (this.#allowLocalMock && chainId === 31337 && process.env.NODE_ENV !== 'production'),
      403, 'MOCK_LOGIN_FORBIDDEN', 'Simulated investor login requires explicit opt-in on chain 31337 outside production');
    ensure(verifier.mock || text(registry.path, 4096), 503, 'WORLD_REGISTRY_REQUIRED', 'Live investor login requires durable World ID binding storage');
    ensure(text(verifier.action, 128) && (verifier.mock || (['production', 'staging', 'sandbox'].includes(verifier.environment)
      && typeof verifier.rpId === 'string' && /^rp_[a-z0-9]{1,128}$/i.test(verifier.rpId)
      && typeof verifier.appId === 'string' && /^app_[a-z0-9]{1,128}$/i.test(verifier.appId))),
    503, 'INVESTOR_AUTH_UNAVAILABLE', 'Fund World ID configuration is incomplete');
    return { verifier, registry, scope: Object.freeze({ fundId, policyHash: policyHash.toLowerCase(), chainId,
      credential: 'document', environment: verifier.mock ? 'mock' : verifier.environment, mock: verifier.mock,
      action: verifier.action, rpId: verifier.mock ? 'rp_mock' : verifier.rpId, appId: verifier.mock ? 'app_mock' : verifier.appId }) };
  }
  #active(entry) {
    if (this.#challenges.get(entry.id) !== entry || entry.expiresAt <= this.#now()) throw stale();
  }
  async #current(entry) {
    this.#active(entry);
    const current = await this.#fund(entry.fundId);
    this.#active(entry);
    ensure(sameScope(entry.scope, current.scope), 409, 'AUTH_SCOPE_CHANGED', 'Fund authentication policy changed; request a fresh challenge');
    return current;
  }
  #context(value, scope, now) {
    const rp = value?.rp_context;
    ensure(object(value) && object(rp) && value.app_id === scope.appId && value.rp_id === scope.rpId
      && value.action === scope.action && value.credential === scope.credential && value.environment === scope.environment
      && value.mock === scope.mock && value.allow_legacy_proofs === false && rp.rp_id === scope.rpId && hex32(rp.nonce)
      && Number.isSafeInteger(rp.created_at) && rp.created_at >= 0 && rp.created_at <= now + 30
      && Number.isSafeInteger(rp.expires_at) && rp.expires_at > now && rp.expires_at > rp.created_at
      && (scope.mock ? rp.signature === '0xmock' : typeof rp.signature === 'string' && /^0x[0-9a-f]{130}$/i.test(rp.signature)),
    503, 'WORLD_CONTEXT_INVALID', 'World ID request context is unavailable or expired');
    // Never spread a verifier instance or unrecognized context fields into an HTTP response.
    return Object.freeze({ app_id: value.app_id, rp_id: value.rp_id, action: value.action, credential: value.credential,
      environment: value.environment, mock: value.mock, allow_legacy_proofs: false,
      rp_context: Object.freeze({ rp_id: rp.rp_id, nonce: rp.nonce, created_at: rp.created_at, expires_at: rp.expires_at, signature: rp.signature }) });
  }

  async challenge(body, metadata) {
    const { now, origin } = this.#request('challenge', metadata);
    fields(body, ['wallet', 'fundId']);
    ensure(typeof body.wallet === 'string' && /^0x[0-9a-f]{40}$/i.test(body.wallet) && !/^0x0{40}$/i.test(body.wallet),
      400, 'INVALID_WALLET', 'A nonzero EOA wallet address is required');
    let wallet;
    try { wallet = getAddress(body.wallet).toLowerCase(); }
    catch { throw new AppError(400, 'INVALID_WALLET', 'Invalid wallet address checksum'); }
    const { fundId } = body;
    ensure(typeof fundId === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(fundId), 400, 'INVALID_FUND', 'Invalid investor fund identifier');
    this.#enter();
    let entry;
    try {
      // Unsigned requests must not invalidate another client's challenge.
      ensure(this.#challenges.size < L.maxChallenges, 503, 'AUTH_CAPACITY', 'Investor challenge capacity reached; retry later');
      entry = { id: randomBytes(32).toString('hex'), wallet, fundId, origin, expiresAt: now + L.challengeSeconds, state: 'creating' };
      this.#challenges.set(entry.id, entry);
      const fund = await this.#fund(fundId);
      this.#active(entry);
      entry.scope = fund.scope;
      const world = this.#context(await worldCall(() => fund.verifier.context()), fund.scope, this.#now());
      await this.#current(entry);
      entry.expiresAt = Math.min(entry.expiresAt, world.rp_context.expires_at);
      entry.worldNonce = world.rp_context.nonce;
      entry.message = `mirr0tech investor login (EIP-191)\n\nSign only to log in as an investor. This does not authorize a transaction or establish KYC/AML approval.\n\n${JSON.stringify({
        version: 1, wallet, ...fund.scope, origin, nonce: entry.id, worldNonce: entry.worldNonce, issuedAt: now, expiresAt: entry.expiresAt,
      }, null, 2)}`;
      entry.state = 'ready';
      return { challengeId: entry.id, message: entry.message, expiresAt: entry.expiresAt, wallet, chainId: fund.scope.chainId, fundId, world };
    } catch (error) {
      if (entry) this.#challenges.delete(entry.id);
      throw error;
    } finally { this.#inFlight--; }
  }

  async verify(body, metadata) {
    const { origin } = this.#request('verify', metadata);
    ensure(object(body) && challengeIdValid(body.challengeId), 400, 'INVALID_BODY', 'A valid challenge identifier is required');
    const entry = this.#challenges.get(body.challengeId);
    if (!entry || entry.state !== 'ready') throw stale();
    entry.state = 'verifying'; // Consumed synchronously, before validation and before any await.
    let entered = false;
    let reserved = false;
    try {
      fields(body, ['challengeId', 'signature', 'proof']);
      this.#active(entry);
      ensure(entry.origin === origin, 403, 'ORIGIN_NOT_ALLOWED', 'Challenge belongs to a different origin');
      ensure(typeof body.signature === 'string' && /^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(body.signature),
        400, 'INVALID_SIGNATURE', 'Expected an EIP-191 wallet signature');
      let signer;
      try { signer = verifyMessage(entry.message, body.signature).toLowerCase(); } catch { /* Safe error below. */ }
      ensure(signer === entry.wallet, 401, 'INVALID_SIGNATURE', 'Wallet signature does not match this challenge');
      const proof = proofSnapshot(body.proof);
      ensure(entry.scope.mock || (hex32(proof.nonce) && proof.nonce.toLowerCase() === entry.worldNonce.toLowerCase()),
        400, 'INVALID_PROOF', 'World ID proof nonce does not match this challenge');
      this.#enter(); entered = true;
      ensure(this.#sessions.size + this.#sessionReservations < L.maxSessions, 503, 'AUTH_CAPACITY', 'Investor session capacity reached; retry later');
      this.#sessionReservations++; reserved = true;
      const fund = await this.#current(entry);
      const result = await worldCall(() => fund.verifier.verify(proof, entry.wallet));
      ensure(object(result) && result.success === true && uint256(result.nullifier)
        && ['credential', 'environment', 'mock', 'action'].every((key) => result[key] === entry.scope[key]),
      502, 'WORLD_INVALID_RESPONSE', 'World ID returned an inconsistent verification result');
      const verification = Object.freeze({ success: true, nullifier: canonical(result.nullifier), action: result.action,
        credential: result.credential, environment: result.environment, mock: result.mock });
      const current = await this.#current(entry);
      await worldCall(() => current.registry.bind(verification.nullifier, entry.wallet), 'REGISTRY_UNAVAILABLE');
      await this.#current(entry);
      const expiresAt = this.#now() + this.#ttlSeconds;
      const session = Object.freeze({ ...publicSession({ wallet: entry.wallet, ...entry.scope }), id: randomBytes(32).toString('hex'), expiresAt, role: 'investor',
        action: entry.scope.action, rpId: entry.scope.rpId, appId: entry.scope.appId, verification });
      const accessToken = `ia_${randomBytes(32).toString('base64url')}`;
      const digest = hash(accessToken);
      this.#sessions.set(digest.toString('hex'), { digest, session, scope: entry.scope, expiresAt });
      return { accessToken, expiresAt, session: publicSession(session) };
    } finally {
      this.#challenges.delete(entry.id);
      if (reserved) this.#sessionReservations--;
      if (entered) this.#inFlight--;
    }
  }

  #token(token) {
    if (typeof token !== 'string' || !/^ia_[a-zA-Z0-9_-]{43}$/.test(token)) return null;
    const digest = hash(token);
    const key = digest.toString('hex');
    const stored = this.#sessions.get(key);
    const matches = timingSafeEqual(digest, stored?.digest ?? absentDigest);
    return stored && matches ? { key, stored } : null;
  }
  async authenticate(token) {
    this.#prune(this.#now());
    const match = this.#token(token);
    if (!match) throw unauthorized();
    const { key, stored } = match;
    try {
      const current = await this.#fund(stored.session.fundId);
      if (!sameScope(stored.scope, current.scope) || stored.expiresAt <= this.#now() || this.#sessions.get(key) !== stored) throw unauthorized();
      return stored.session;
    } catch {
      this.#sessions.delete(key);
      throw unauthorized();
    }
  }
  revoke(token) {
    const match = this.#token(token);
    return match ? this.#sessions.delete(match.key) : false;
  }
}
