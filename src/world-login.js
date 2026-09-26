import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { signRequest } from '@worldcoin/idkit-core/signing';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { ensure } from './errors.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const hex = (value) => typeof value === 'string' && /^0x[\da-f]{1,64}$/i.test(value);
const sameHex = (a, b) => hex(a) && hex(b) && BigInt(a) === BigInt(b);
const sessionId = (value) => typeof value === 'string' && /^session_[\da-f]{128}$/i.test(value);
const LOGIN_TTL = 24 * 3600;
export const LOGIN_MODES = ['mock', 'sandbox', 'v3'];
const environmentOf = (mode) => (mode === 'v3' ? 'staging' : mode);

/** Application login is independent of wallet-bound document verification. */
export class WorldLogin {
  static async open(options = {}) {
    const { DatabaseSync } = await import('node:sqlite');
    return new WorldLogin({ ...options, DatabaseSync });
  }

  constructor({ DatabaseSync, path = process.env.WORLD_SESSION_DB || resolve(process.env.DATA_DIR || '.data', 'world-sessions.sqlite'),
    appId = process.env.WORLD_APP_ID, rpId = process.env.WORLD_RP_ID, signingKey = process.env.WORLD_RP_SIGNING_KEY,
    // v3 proofs are signed for an action registered in the Developer Portal (staging, repeat verifications allowed).
    action = process.env.WORLD_LOGIN_ACTION || 'login',
    fetchImpl = fetch, clock = Date.now, mode = null } = {}) {
    // The login screen chooses the mode; `mode` pins one (tests, or a deployment that wants a single mode).
    ensure(mode === null || LOGIN_MODES.includes(mode), 500, 'WORLD_LOGIN_CONFIG', 'Login mode must be mock, sandbox or v3.');
    const modes = mode ? [mode] : LOGIN_MODES;
    Object.assign(this, { appId, rpId, signingKey, action, fetchImpl, clock, modes });
    this.mode = mode ?? (this.configured('sandbox') ? 'sandbox' : 'mock');
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS login_challenges (hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, signal TEXT NOT NULL, expires INTEGER NOT NULL, expected_session TEXT, used INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'sandbox');
      CREATE TABLE IF NOT EXISTS world_accounts (id TEXT PRIMARY KEY, subject TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS world_login_proofs (hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS world_sessions (hash TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES world_accounts(id), expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS world_sessions_expiry ON world_sessions(expires);`);
    // Existing accounts were created by the sandbox verifier.
    if (!this.db.prepare('PRAGMA table_info(world_accounts)').all().some((column) => column.name === 'mode'))
      this.db.exec("ALTER TABLE world_accounts ADD COLUMN mode TEXT NOT NULL DEFAULT 'sandbox'");
    if (!this.db.prepare('PRAGMA table_info(login_challenges)').all().some((column) => column.name === 'mode'))
      this.db.exec("ALTER TABLE login_challenges ADD COLUMN mode TEXT NOT NULL DEFAULT 'sandbox'");
  }
  now() { return Math.floor(this.clock() / 1000); }
  close() { this.db.close(); }
  environment(mode = this.mode) { return environmentOf(mode); }
  configured(mode = this.mode) { return mode === 'mock' || ((mode !== 'v3' || (typeof this.action === 'string' && this.action.trim().length > 0)) && /^app_[a-z0-9]+$/i.test(this.appId || '') && /^rp_[a-z0-9]+$/i.test(this.rpId || '') && /^(0x)?[\da-f]{64}$/i.test(this.signingKey || '')); }
  /// `mode` is the screen's default; `modes` lists every choice with whether the backend can serve it.
  config() {
    return { configured: this.configured(), environment: environmentOf(this.mode), mode: this.mode,
      modes: this.modes.map((mode) => ({ mode, environment: environmentOf(mode), configured: this.configured(mode) })) };
  }
  enabled(mode) { return this.modes.includes(mode); }

  mockLogin() {
    ensure(this.enabled('mock'), 403, 'MOCK_LOGIN_DISABLED', 'Placeholder login is disabled.');
    const id = `mock_${secret().slice(0, 24)}`;
    const accessToken = `world_${secret()}`;
    const expiresAt = this.now() + LOGIN_TTL;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM world_sessions WHERE expires <= ?').run(this.now());
      this.db.prepare('INSERT INTO world_accounts (id, subject, created, mode) VALUES (?, ?, ?, ?)').run(id, hash(id), this.now(), 'mock');
      this.db.prepare('INSERT INTO world_sessions VALUES (?, ?, ?)').run(hash(accessToken), id, expiresAt);
      this.db.exec('COMMIT');
      return { accessToken, ...this.context(id, expiresAt, 'mock') };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  challenge({ existingSessionId, mode = this.mode } = {}) {
    ensure(LOGIN_MODES.includes(mode) && mode !== 'mock' && this.enabled(mode), 403, 'SANDBOX_LOGIN_DISABLED', 'Verified login is disabled.');
    ensure(this.configured(mode), 503, 'WORLD_LOGIN_CONFIG', 'Set WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY on the backend; v3 also requires WORLD_LOGIN_ACTION.');
    ensure(existingSessionId === undefined || (mode === 'sandbox' && sessionId(existingSessionId)), 400, 'LOGIN_SESSION', 'Invalid returning session.');
    if (existingSessionId) ensure(this.db.prepare('SELECT id FROM world_accounts WHERE subject = ?').get(hash(`sandbox:${this.rpId}:${existingSessionId}`)), 400, 'LOGIN_SESSION', 'This saved World ID session is unknown. Choose Use a different World ID to start again.');
    this.db.prepare('DELETE FROM login_challenges WHERE expires <= ?').run(this.now());
    this.db.prepare('DELETE FROM world_sessions WHERE expires <= ?').run(this.now());
    ensure(this.db.prepare('SELECT count(*) AS n FROM login_challenges').get().n < 100, 429, 'LOGIN_LIMIT', 'Too many login attempts. Try again in five minutes.');
    // Only v3 uniqueness requests have an action; v4 session requests must omit it.
    const signed = signRequest({ signingKeyHex: this.signingKey, ttl: 300, ...(mode === 'v3' ? { action: this.action } : {}) });
    const challengeToken = secret();
    // No 0x prefix: IDKit's hashSignal reads `0x`+hex as bytes and anything else as UTF-8 text; this signal is text on both sides.
    const signal = secret();
    this.db.prepare('INSERT INTO login_challenges (hash, nonce, signal, expires, expected_session, mode) VALUES (?, ?, ?, ?, ?, ?)').run(hash(challengeToken), signed.nonce, signal, signed.expiresAt, existingSessionId || null, mode);
    return { challengeToken, signal, app_id: this.appId, environment: environmentOf(mode),
      ...(mode === 'v3' ? { action: this.action } : {}),
      rp_context: { rp_id: this.rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig } };
  }

  async login({ challengeToken, proof } = {}, { requestId } = {}) {
    ensure(typeof challengeToken === 'string' && /^[\da-f]{64}$/.test(challengeToken), 400, 'LOGIN_CHALLENGE', 'Start a new login attempt.');
    // Consume atomically before awaiting World. Failed attempts require a fresh challenge too.
    const challenge = this.db.prepare('UPDATE login_challenges SET used = 1 WHERE hash = ? AND expires > ? AND used = 0 RETURNING *').get(hash(challengeToken), this.now());
    ensure(challenge, 400, 'LOGIN_CHALLENGE', 'Login expired or was already used. Start again.');
    // The challenge fixed the mode; the proof is judged by it, not by the screen's current choice.
    const mode = challenge.mode;
    ensure(mode !== 'mock' && this.enabled(mode), 403, 'SANDBOX_LOGIN_DISABLED', 'Verified login is disabled.');
    const item = proof?.responses?.[0];
    const legacy = mode === 'v3';
    // Each check is named, so a rejection says which part of the proof did not fit this login attempt.
    const checks = legacy ? {
      protocol_version: proof?.protocol_version === '3.0', environment: proof?.environment === 'staging',
      nonce: proof?.nonce === challenge.nonce, action: proof?.action === this.action, no_session_id: !('session_id' in (proof ?? {})),
      one_response: Array.isArray(proof?.responses) && proof.responses.length === 1,
      identifier: ['orb', 'proof_of_human'].includes(item?.identifier), nullifier: hex(item?.nullifier), merkle_root: hex(item?.merkle_root),
      proof: typeof item?.proof === 'string' && /^0x[\da-f]{512}$/i.test(item.proof),
      signal_hash: sameHex(item?.signal_hash, hashSignal(challenge.signal)),
    } : {
      protocol_version: proof?.protocol_version === '4.0', environment: proof?.environment === 'sandbox', nonce: proof?.nonce === challenge.nonce,
      no_action: !('action' in (proof ?? {})), session_id: sessionId(proof?.session_id) && (!challenge.expected_session || proof.session_id === challenge.expected_session),
      one_response: Array.isArray(proof?.responses) && proof.responses.length === 1,
      // Sandbox documents Selfie Check; proof of human is accepted where the app can issue it.
      credential: (item?.identifier === 'selfie' && item.issuer_schema_id === 11) || (item?.identifier === 'proof_of_human' && item?.issuer_schema_id === 1),
      proof: Array.isArray(item?.proof) && item.proof.length === 5 && item.proof.every(hex),
      session_nullifier: Array.isArray(item?.session_nullifier) && item.session_nullifier.length === 2 && item.session_nullifier.every(hex),
      expires_at_min: Number.isSafeInteger(item?.expires_at_min) && item.expires_at_min >= 0,
      signal_hash: sameHex(item?.signal_hash, hashSignal(challenge.signal)),
    };
    const failed = Object.keys(checks).filter((name) => !checks[name]);
    if (failed.length) console.warn('[World ID] login proof rejected locally', { requestId, mode, failed, identifier: typeof item?.identifier === 'string' ? item.identifier.slice(0, 32) : typeof item?.identifier, protocol: proof?.protocol_version, environment: proof?.environment });
    ensure(!failed.length, 400, 'INVALID_LOGIN_PROOF', `The ${legacy ? 'staging v3' : 'sandbox v4'} proof did not match this login attempt: ${failed.join(', ')}.`);
    let response, result;
    const started = Date.now();
    const diagnosticCode = (value) => typeof value === 'string' && /^[a-zA-Z_]{1,64}$/.test(value) ? value : undefined;
    console.info('[World ID] verification started', { requestId, environment: environmentOf(mode), provider: 'developer.world.org' });
    try {
      response = await this.fetchImpl(`https://developer.world.org/api/v4/verify/${this.rpId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proof),
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      result = await response.json();
    } catch (error) {
      console.error('[World ID] verification transport failed', {
        requestId, durationMs: Date.now() - started, status: response?.status,
        errorName: diagnosticCode(error?.name), causeCode: diagnosticCode(error?.cause?.code),
      });
      ensure(false, 503, 'WORLD_UNAVAILABLE', 'World ID verification is unavailable. Start a new login attempt.');
    }
    console.info('[World ID] verification response', {
      requestId, durationMs: Date.now() - started, status: response.status, success: result?.success === true,
      providerCode: diagnosticCode(result?.code), credentialCode: diagnosticCode(result?.results?.[0]?.code),
      credentialAccepted: result?.results?.[0]?.success === true,
      sessionMatches: result?.session_id === proof.session_id,
      environmentMatches: !result?.environment || result.environment === environmentOf(mode),
      resultCount: Array.isArray(result?.results) ? result.results.length : null,
    });
    // World's own reason, when it gives one, is what the operator needs to fix the Portal setup.
    const reason = [result?.code, result?.detail, result?.results?.[0]?.code, result?.results?.[0]?.detail].filter((value) => typeof value === 'string' && value.length).map((value) => value.slice(0, 160)).join(' · ');
    ensure(response.ok && result?.success === true && (legacy || result.session_id === proof.session_id)
      && (!result.environment || result.environment === environmentOf(mode)) && !result.code
      && Array.isArray(result.results) && result.results.length === 1
      && result.results[0]?.identifier === item.identifier && result.results[0].success === true && !result.results[0].code,
    400, 'WORLD_LOGIN_REJECTED', `World ID did not verify this login proof${reason ? ` (${reason})` : ''}. Start again.`);
    ensure(challenge.expires > this.now(), 400, 'LOGIN_CHALLENGE', 'Login expired. Start again.');
    const proofHash = legacy ? hash(`v3:${this.rpId}:${this.action}:${item.proof.toLowerCase()}`) : hash(`${this.rpId}:${item.session_nullifier.map((value) => BigInt(value).toString(16)).join(':')}`);
    // A v3 nullifier identifies the account and legitimately repeats on each fresh login.
    const subject = legacy
      ? hash(JSON.stringify(['staging', 'v3', this.appId, this.rpId, this.action, BigInt(item.nullifier).toString(16)]))
      : hash(`sandbox:${this.rpId}:${proof.session_id}`);
    const accessToken = `world_${secret()}`;
    const expiresAt = this.now() + LOGIN_TTL;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      ensure(!this.db.prepare('SELECT hash FROM world_login_proofs WHERE hash = ?').get(proofHash), 400, 'LOGIN_REPLAY', 'This World ID proof was already used.');
      this.db.prepare('INSERT INTO world_login_proofs VALUES (?)').run(proofHash);
      this.db.prepare('INSERT OR IGNORE INTO world_accounts (id, subject, created, mode) VALUES (?, ?, ?, ?)').run(`world_${secret().slice(0, 24)}`, subject, this.now(), mode);
      const account = this.db.prepare('SELECT id FROM world_accounts WHERE subject = ?').get(subject);
      this.db.prepare('INSERT INTO world_sessions VALUES (?, ?, ?)').run(hash(accessToken), account.id, expiresAt);
      this.db.exec('COMMIT');
      return { accessToken, ...this.context(account.id, expiresAt, mode), ...(legacy ? {} : { worldSessionId: proof.session_id }) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  context(id, expiresAt, mode = 'sandbox') {
    const mock = mode === 'mock';
    return { account: { id, provider: mock ? 'world-id-mock' : 'world-id', environment: mode === 'v3' ? 'staging' : mode, mock, credential: mock ? null : mode === 'v3' ? 'orb' : 'selfie', passportVerified: false }, expiresAt };
  }
  authenticate(token) {
    const row = typeof token === 'string' && /^world_[\da-f]{64}$/.test(token)
      ? this.db.prepare(`SELECT s.account, s.expires, a.mode FROM world_sessions s JOIN world_accounts a ON a.id = s.account WHERE s.hash = ? AND s.expires > ? AND a.mode IN (${this.modes.map(() => '?').join(', ')})`).get(hash(token), this.now(), ...this.modes) : null;
    ensure(row, 401, 'WORLD_SESSION_REQUIRED', 'Sign in with World ID to continue.');
    return this.context(row.account, row.expires, row.mode);
  }
  logout(token) { this.authenticate(token); this.db.prepare('DELETE FROM world_sessions WHERE hash = ?').run(hash(token)); }
  requireSession = (req, _res, next) => {
    try { req.worldAccount = this.authenticate(req.get('X-World-Session')).account; next(); } catch (error) { next(error); }
  };
}
