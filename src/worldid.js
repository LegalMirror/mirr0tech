// A verified credential becomes the policy's `identityVerified` fact, not a KYC decision.
// Live proofs are verified by World; explicit mock contexts are local simulations only.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hashSignal } from '@worldcoin/idkit-core/hashing';

export const WORLD_VERIFY_URL = 'https://developer.world.org/api/v4/verify';
export const DEFAULT_ACTION = 'onboard-investor';
export const CREDENTIALS = Object.freeze({ document: 9303, proof_of_human: 1, selfie: 11 });
const IDENTIFIERS = { document: 'passport', proof_of_human: 'proof_of_human', selfie: 'selfie' };

export class WorldIdError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const sha = (text) => `0x${createHash('sha256').update(text).digest('hex')}`;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const uint256 = (value) => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value);
const address = (value) => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
// Numeric equivalence matters: casing and leading zeroes must not reopen a binding.
const canonical = (value) => `0x${value.slice(2).toLowerCase().padStart(64, '0')}`;
const invalid = (message) => new WorldIdError(400, 'INVALID_PROOF', message);
const badUpstream = () => new WorldIdError(502, 'WORLD_INVALID_RESPONSE', 'World ID returned an incomplete or inconsistent verification result');

/// Deliberately forgeable fixture, never a live proof. Named-wallet fixtures and reuse on another
/// wallet remain supported in mock mode to exercise the registry's denied path without World App.
export function mockProof(wallet, { action = DEFAULT_ACTION, nullifier = null, credential = 'document' } = {}) {
  return {
    protocol_version: '4.0', nonce: sha(`nonce:${wallet}`), action,
    responses: [{ identifier: 'mock', issuer_schema_id: CREDENTIALS[credential], nullifier: nullifier ?? sha(`human:${wallet.toLowerCase()}`), expires_at_min: 0,
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'], signal_hash: sha(`signal:${wallet.toLowerCase()}`) }],
  };
}

export class WorldIdVerifier {
  constructor({ rpId = process.env.WORLD_RP_ID ?? null, appId = process.env.WORLD_APP_ID ?? null, action = process.env.WORLD_ACTION ?? DEFAULT_ACTION,
    environment = process.env.WORLD_ENVIRONMENT ?? process.env.WORLD_ENV ?? 'staging', credential = process.env.WORLD_CREDENTIAL ?? 'document',
    signingKeyHex = process.env.WORLD_RP_SIGNING_KEY ?? null, url = process.env.WORLD_VERIFY_URL ?? WORLD_VERIFY_URL, fetchImpl = fetch,
    mock = null, timeoutMs = Number(process.env.WORLD_VERIFY_TIMEOUT_MS ?? 10000) } = {}) {
    if (!Object.hasOwn(CREDENTIALS, credential)) throw new WorldIdError(500, 'CONFIG', `WORLD_CREDENTIAL must be one of ${Object.keys(CREDENTIALS).join(', ')}`);
    if (!nonempty(action) || !['production', 'staging', 'sandbox'].includes(environment)) throw new WorldIdError(500, 'CONFIG', 'World ID requires an action and a supported environment');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new WorldIdError(500, 'CONFIG', 'WORLD_VERIFY_TIMEOUT_MS must be between 1 and 120000 milliseconds');
    if (mock !== null && typeof mock !== 'boolean') throw new WorldIdError(500, 'CONFIG', 'World ID mock mode must be a boolean');
    // Preserve the no-configuration local stack, but never fall back on a partially configured RP
    // or an unconfigured production server. Callers may explicitly disable mock mode anywhere.
    const hasLiveConfig = [rpId, appId, signingKeyHex].some((value) => value !== null && value !== undefined);
    const production = process.env.NODE_ENV === 'production' || environment === 'production';
    const mockMode = mock ?? (!hasLiveConfig && !production);
    if (mockMode && (hasLiveConfig || production)) throw new WorldIdError(500, 'CONFIG', 'Mock World ID is local-only and must not have live RP configuration');
    if (!mockMode && (typeof rpId !== 'string' || !/^rp_[a-z0-9]+$/i.test(rpId))) throw new WorldIdError(500, 'CONFIG', 'Live World ID requires WORLD_RP_ID');
    if (!mockMode) {
      let endpoint;
      try { endpoint = new URL(url); } catch { /* Rejected below without reflecting configuration. */ }
      if (!endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new WorldIdError(500, 'CONFIG', 'WORLD_VERIFY_URL must be an HTTPS endpoint without credentials, query or fragment');
      }
    }
    Object.assign(this, { rpId, appId, action, environment, credential, signingKeyHex, url, fetchImpl, timeoutMs, mockMode });
  }
  get mock() { return this.mockMode; }

  /// Only signed public request material leaves the server; the RP signing key never does.
  async context() {
    const now = Math.floor(Date.now() / 1000);
    let rp_context;
    if (this.mock) {
      rp_context = { rp_id: 'rp_mock', nonce: `0x${randomBytes(32).toString('hex')}`, created_at: now, expires_at: now + 300, signature: '0xmock' };
    } else {
      if (typeof this.appId !== 'string' || !/^app_[a-z0-9]+$/i.test(this.appId) || !/^(?:0x)?[0-9a-f]{64}$/i.test(this.signingKeyHex ?? '')) {
        throw new WorldIdError(500, 'CONFIG', 'Live World ID context requires WORLD_APP_ID and a valid WORLD_RP_SIGNING_KEY');
      }
      try {
        const { signRequest } = await import('@worldcoin/idkit-core/signing');
        const signed = signRequest({ signingKeyHex: this.signingKeyHex, action: this.action, ttl: 300 });
        rp_context = { rp_id: this.rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig };
      } catch {
        throw new WorldIdError(500, 'CONFIG', 'World ID request signing failed; check the server RP signing key');
      }
    }
    return { app_id: this.mock ? 'app_mock' : this.appId, rp_id: rp_context.rp_id, action: this.action, credential: this.credential,
      environment: this.mock ? 'mock' : this.environment, mock: this.mock, allow_legacy_proofs: false, rp_context };
  }

  /// This onboarding gate requests exactly one v4 uniqueness credential, not a legacy fallback,
  /// session, or OR constraint. A 200 from World means *at least one* proof passed, not every proof.
  async verify(payload, wallet = null) {
    if (!object(payload) || payload.protocol_version !== '4.0' || 'session_id' in payload || !nonempty(payload.nonce)
      || !Array.isArray(payload.responses) || payload.responses.length !== 1 || !object(payload.responses[0])) {
      throw invalid('Expected one World ID 4.0 uniqueness proof (legacy and session proofs are not supported)');
    }
    const response = payload.responses[0];
    if (payload.action !== this.action) throw invalid(`Proof action must match the configured action; expected ${this.action}`);
    if ('session_nullifier' in response || !uint256(response.nullifier) || !uint256(response.signal_hash)
      || !Number.isSafeInteger(response.expires_at_min) || response.expires_at_min < 0
      || !Array.isArray(response.proof) || response.proof.length !== 5 || !Array.from(response.proof).every(uint256)) {
      throw invalid('Proof requires a nullifier, signal hash, expiry and five hex proof elements');
    }
    if (!Number.isSafeInteger(response.issuer_schema_id)) throw invalid('Proof is missing a numeric credential schema');
    if (response.issuer_schema_id !== CREDENTIALS[this.credential]) {
      throw new WorldIdError(400, 'WRONG_CREDENTIAL', `This agreement asks for a ${this.credential.replace(/_/g, ' ')} credential (schema ${CREDENTIALS[this.credential]})`);
    }
    const nullifier = canonical(response.nullifier);
    if (this.mock) {
      if (response.identifier !== 'mock' || (payload.environment !== undefined && payload.environment !== 'mock')) throw invalid('Mock mode accepts only explicitly simulated proofs');
      return { success: true, nullifier, action: this.action, credential: this.credential, environment: 'mock', mock: true };
    }
    if (response.identifier !== IDENTIFIERS[this.credential]) throw new WorldIdError(400, 'WRONG_CREDENTIAL', 'Proof identifier does not match the requested credential');
    if (!address(wallet)) throw invalid('A target wallet address is required for verification');
    // A wallet is `0x`+hex, so IDKit hashes it as its 20 bytes, not its 42 characters; only the SDK's own hashSignal matches.
    if (canonical(response.signal_hash) !== canonical(hashSignal(wallet.toLowerCase()))) throw invalid('The proof is bound to another wallet');
    if (payload.environment !== this.environment) throw invalid('Proof environment does not match this deployment');
    if (this.credential === 'selfie') {
      const bundle = payload.integrity_bundle;
      if (!Number.isSafeInteger(response.sybil_score) || response.sybil_score < 0 || !object(bundle) || bundle.version !== 2
        || !['apple_app_attest', 'android_keystore'].includes(bundle.signature_format)
        || !Number.isSafeInteger(bundle.timestamp) || bundle.timestamp < 0
                || typeof bundle.signature !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})+$/i.test(bundle.signature) || !nonempty(bundle.jwt)) {
        throw invalid('Selfie Check requires a sybil score and a version 2 integrity bundle');
      }
    }
    // Forward the checked IDKit payload unchanged, including Selfie Check integrity material.
    const requestBody = JSON.stringify(payload);
    const controller = new AbortController();
    let timer;
    let http, body;
    try {
      ({ http, body } = await Promise.race([
        (async () => {
          const http = await this.fetchImpl(`${this.url.replace(/\/+$/, '')}/${this.rpId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody, signal: controller.signal, redirect: 'error' });
          if (!http || typeof http.ok !== 'boolean' || typeof http.json !== 'function') throw badUpstream();
          const body = await http.json().catch(() => { throw badUpstream(); });
          return { http, body };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new WorldIdError(503, 'WORLD_TIMEOUT', 'World ID verification timed out; no identity fact was granted'));
            controller.abort();
          }, this.timeoutMs);
        }),
      ]));
    } catch (error) {
      if (error instanceof WorldIdError) throw error;
      throw new WorldIdError(503, 'WORLD_UNAVAILABLE', 'World ID verification is unavailable; try again later');
    } finally { clearTimeout(timer); }
    if (!object(body)) throw badUpstream();
    if (!http.ok || body.success === false) {
      if (http.status >= 500 || http.status === 429) throw new WorldIdError(503, 'WORLD_UNAVAILABLE', 'World ID verification is unavailable; try again later');
      throw new WorldIdError(400, body.code === 'app_not_migrated' ? 'APP_NOT_MIGRATED' : 'INVALID_PROOF', nonempty(body.detail) ? body.detail.slice(0, 500) : 'World ID verification failed');
    }
    // OpenAPI requires success/results, not action/environment echoes. The submitted action,
    // schema and wallet signal were checked above and are covered by this proof's verification.
    if (body.success !== true || ('environment' in body && body.environment !== this.environment) || ('action' in body && body.action !== this.action)
      || 'session_id' in body || nonempty(body.code) || !Array.isArray(body.results) || body.results.length !== 1) throw badUpstream();
    const result = body.results[0];
    if (!object(result) || result.identifier !== response.identifier) throw badUpstream();
    if (result.success === false) throw invalid('World ID rejected the requested credential');
    if (result.success !== true || !uint256(result.nullifier) || canonical(result.nullifier) !== nullifier
      || 'session_nullifier' in result || nonempty(result.code)
      || ('nullifier' in body && (!uint256(body.nullifier) || canonical(body.nullifier) !== nullifier))
      || ('issuer_schema_id' in result && result.issuer_schema_id !== CREDENTIALS[this.credential])
      || ('signal_hash' in result && (!uint256(result.signal_hash) || canonical(result.signal_hash) !== canonical(response.signal_hash)))) throw badUpstream();
    return { success: true, nullifier, action: this.action, credential: this.credential, environment: this.environment, mock: false };
  }
}

const registryQueues = new Map();
const registryError = () => new WorldIdError(503, 'REGISTRY_UNAVAILABLE', 'World ID bindings are unavailable or corrupt; onboarding is blocked until the registry is repaired');

function bindingsFrom(value) {
  if (!object(value)) throw registryError();
  const bindings = Object.create(null);
  for (const [nullifier, wallet] of Object.entries(value)) {
    if (!uint256(nullifier) || !address(wallet)) throw registryError();
    const key = canonical(nullifier);
    if (bindings[key] && bindings[key] !== wallet.toLowerCase()) throw registryError();
    bindings[key] = wallet.toLowerCase();
  }
  return bindings;
}

async function persistBindings(path, bindings) {
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(bindings, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

/// A nullifier binding is scoped by World's RP/action/credential semantics, not global personhood.
/// Atomic snapshots and a writer lock protect file-backed registries. A stale lock fails closed;
/// multi-host deployments should use a transactional database with a unique nullifier constraint.
export class HumanRegistry {
  constructor(path = null) { this.path = path ? resolve(path) : null; this.byNullifier = Object.create(null); this.loaded = false; }

  async update(operation) {
    const key = this.path ?? this;
    const previous = registryQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      let lock;
      try {
        let bindings = { ...this.byNullifier };
        if (this.path) {
          await mkdir(dirname(this.path), { recursive: true });
          try { lock = await open(`${this.path}.lock`, 'wx', 0o600); }
          catch (error) {
            if (error.code === 'EEXIST') throw new WorldIdError(503, 'REGISTRY_BUSY', 'World ID registry is locked; retry or ask the operator to inspect a stale lock');
            throw error;
          }
          try { bindings = bindingsFrom(JSON.parse(await readFile(this.path, 'utf8'))); }
          catch (error) {
            if (error.code !== 'ENOENT' || this.loaded) throw error;
            bindings = Object.create(null);
          }
          // Never forget an observed binding because a file was externally truncated/replaced.
          for (const [nullifier, wallet] of Object.entries(this.byNullifier)) {
            if (bindings[nullifier] !== wallet) throw registryError();
          }
        }
        const result = operation(bindings);
        if (this.path) await persistBindings(this.path, bindings);
        this.byNullifier = bindings;
        this.loaded = true;
        return result;
      } catch (error) {
        if (error instanceof WorldIdError) throw error;
        throw registryError();
      } finally {
        if (lock) {
          try { await lock.close(); await unlink(`${this.path}.lock`); }
          catch { throw registryError(); }
        }
      }
    });
    registryQueues.set(key, current);
    try { return await current; }
    finally { if (registryQueues.get(key) === current) registryQueues.delete(key); }
  }

  async load() { await this.update(() => {}); return this; }
  async bind(nullifier, wallet) {
    if (!uint256(nullifier) || !address(wallet)) throw invalid('A registry binding requires a valid nullifier and wallet address');
    const key = canonical(nullifier);
    return this.update((bindings) => {
      const bound = bindings[key];
      if (bound && bound !== wallet.toLowerCase()) throw new WorldIdError(409, 'HUMAN_ALREADY_BOUND', 'This World ID nullifier is already bound to another wallet for this verification scope');
      bindings[key] = wallet.toLowerCase();
      return wallet;
    });
  }
  walletOf(nullifier) {
    if (!uint256(nullifier)) throw invalid('Invalid World ID nullifier');
    if (this.path && !this.loaded) throw registryError();
    return this.byNullifier[canonical(nullifier)] ?? null;
  }
}
