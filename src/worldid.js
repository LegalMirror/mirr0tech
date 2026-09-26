// World ID: a document credential becomes the `identityVerified` fact. The verifier talks to World's
// Developer Portal (POST /api/v4/verify/{rp_id}); without an rp id it accepts well-formed mock
// proofs so the pipeline runs with no app registered. The registry binds each nullifier to one
// wallet: one human, one investor wallet, under Exhibit A's onboarding checks.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const WORLD_VERIFY_URL = 'https://developer.world.org/api/v4/verify';
export const DEFAULT_ACTION = 'onboard-investor';
/// Which credential the widget asks for. KYC needs a document; the others are for other trust moments.
export const CREDENTIALS = { document: 9303, proof_of_human: 1, selfie: 11 };

export class WorldIdError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const sha = (text) => `0x${createHash('sha256').update(text).digest('hex')}`;

/// A proof shaped like the 4.0 uniqueness response, whose nullifier is derived from the wallet
/// (a different human per wallet) unless one is given (the same human on a second wallet).
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
    signingKeyHex = process.env.WORLD_RP_SIGNING_KEY ?? null, url = process.env.WORLD_VERIFY_URL ?? WORLD_VERIFY_URL, fetchImpl = fetch } = {}) {
    if (!(credential in CREDENTIALS)) throw new WorldIdError(500, 'CONFIG', `WORLD_CREDENTIAL must be one of ${Object.keys(CREDENTIALS).join(', ')}`);
    Object.assign(this, { rpId, appId: appId ?? rpId, action, environment, credential, signingKeyHex, url, fetchImpl });
  }
  get mock() { return !this.rpId; }

  /// What IDKit needs to open a request: the app, the action and a server-signed rp_context.
  async context() {
    const now = Math.floor(Date.now() / 1000);
    let rp_context;
    if (this.signingKeyHex && this.rpId) {
      const { signRequest } = await import('@worldcoin/idkit-core/signing');
      const signed = signRequest({ signingKeyHex: this.signingKeyHex, action: this.action, ttl: 300 });
      rp_context = { rp_id: this.rpId, nonce: signed.nonce, created_at: signed.createdAt, expires_at: signed.expiresAt, signature: signed.sig };
    } else {
      rp_context = { rp_id: this.rpId ?? 'rp_mock', nonce: `0x${randomBytes(32).toString('hex')}`, created_at: now, expires_at: now + 300, signature: '0xmock' };
    }
    return { app_id: this.appId ?? 'app_mock', rp_id: rp_context.rp_id, action: this.action, credential: this.credential, environment: this.mock ? 'mock' : this.environment, mock: this.mock, rp_context };
  }

  /// Verifies a proof payload for `wallet`; returns { success, nullifier, action, environment }. The
  /// payload is forwarded to World as IDKit handed it over; the signal must be this wallet.
  async verify(payload, wallet = null) {
    const response = payload?.responses?.[0];
    if (!response || !['3.0', '4.0'].includes(payload.protocol_version)) throw new WorldIdError(400, 'INVALID_PROOF', 'Expected a World ID 3.0 or 4.0 proof payload');
    if (payload.action !== this.action) throw new WorldIdError(400, 'INVALID_PROOF', `Proof is for action ${payload.action}, expected ${this.action}`);
    if (wallet && !this.mock && response.signal_hash) {
      const { hashSignal } = await import('@worldcoin/idkit-core/hashing');
      if (String(response.signal_hash).toLowerCase() !== String(hashSignal(wallet)).toLowerCase()) throw new WorldIdError(400, 'INVALID_PROOF', 'The proof is bound to another wallet');
    }
    // The agreement names the credential; a proof of another kind is the alternative path, not an error of the user.
    if (response.issuer_schema_id !== undefined && Number(response.issuer_schema_id) !== CREDENTIALS[this.credential]) {
      throw new WorldIdError(400, 'WRONG_CREDENTIAL', `This agreement asks for a ${this.credential.replace(/_/g, ' ')} credential (schema ${CREDENTIALS[this.credential]}), the proof carries schema ${response.issuer_schema_id}`);
    }
    if (this.mock) {
      if (!/^0x[0-9a-f]{64}$/i.test(response.nullifier ?? '') || !response.proof) throw new WorldIdError(400, 'INVALID_PROOF', 'Mock proof needs a nullifier and a proof');
      return { success: true, nullifier: response.nullifier, action: payload.action, environment: 'mock' };
    }
    const http = await this.fetchImpl(`${this.url}/${this.rpId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, environment: this.environment }) });
    const body = await http.json().catch(() => ({}));
    if (!http.ok || body.success === false) throw new WorldIdError(400, body.code === 'app_not_migrated' ? 'APP_NOT_MIGRATED' : 'INVALID_PROOF', body.detail ?? body.code ?? `World ID verification failed (${http.status})`);
    return { success: true, nullifier: body.nullifier ?? body.results?.[0]?.nullifier ?? response.nullifier, action: body.action ?? payload.action, environment: body.environment ?? this.environment };
  }
}

/// nullifier → wallet, persisted so a restart cannot let one human onboard a second wallet.
export class HumanRegistry {
  constructor(path = null) { this.path = path; this.byNullifier = {}; }
  async load() {
    if (this.path) this.byNullifier = await readFile(this.path, 'utf8').then(JSON.parse, () => ({}));
    return this;
  }
  async bind(nullifier, wallet) {
    const bound = this.byNullifier[nullifier];
    if (bound && bound.toLowerCase() !== wallet.toLowerCase()) throw new WorldIdError(409, 'HUMAN_ALREADY_BOUND', 'This human already onboarded another wallet');
    this.byNullifier[nullifier] = wallet;
    if (this.path) { await mkdir(dirname(this.path), { recursive: true }); await writeFile(this.path, `${JSON.stringify(this.byNullifier, null, 2)}\n`); }
    return wallet;
  }
  walletOf(nullifier) { return this.byNullifier[nullifier] ?? null; }
}
