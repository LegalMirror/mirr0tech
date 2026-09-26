// Key custody as a platform setting. The gateway starts on a file key; the issuer can move signing
// into a MultiBaas Cloud Wallet (an HSM-backed key): give MultiBaas the Azure Key Vault account and
// the key (or name a wallet it already holds), the gateway hands its roles and some gas over, and
// from then on every attestation, mint and deploy is signed inside the vault. The choice persists.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Router } from 'express';
import { formatEther } from 'ethers';
import { MultiBaasSigner, cloudWallet } from './multibaas-signer.js';
import { AppError, ensure } from './errors.js';

const AZURE_FIELDS = ['label', 'clientID', 'clientSecret', 'tenantID', 'subscriptionID', 'baseGroupName'];
const isString = (value) => typeof value === 'string' && value.length > 0;
const tolerate = async (promise) => {
  try { return (await promise).data; } catch (error) {
    const message = error.response?.data?.message ?? error.message;
    if (error.response?.status === 409 || /already|exists/i.test(message)) return { skipped: message };
    throw new AppError(502, 'MULTIBAAS', `MultiBaas: ${message}`);
  }
};

export class SigningSettings {
  /// `fileSigner` is the key the gateway started with; `multibaas` the client (null when unset);
  /// `agreements` so per-agreement venues rebind; `path` keeps the choice across restarts.
  constructor({ venues, fileSigner, multibaas = null, agreements = null, path = null }) {
    Object.assign(this, { venues, fileSigner, multibaas, agreements, path, provider: 'key', wallet: null });
  }

  async init() {
    if (!this.path) return this;
    const saved = await readFile(this.path, 'utf8').then(JSON.parse, () => null);
    if (saved?.provider === 'multibaas' && saved.wallet?.address && this.multibaas) {
      await this.venues.useSigner(new MultiBaasSigner(this.multibaas, saved.wallet.address, this.venues.provider));
      Object.assign(this, { provider: 'multibaas', wallet: saved.wallet });
    }
    return this;
  }

  async persist() {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ provider: this.provider, wallet: this.wallet }));
  }

  /// Who signs now, with what it has, and what the vault offers.
  async describe() {
    const address = await this.venues.signer.getAddress();
    const balance = formatEther(await this.venues.provider.getBalance(address));
    let hsm = null;
    if (this.multibaas) {
      const [configs, wallets] = await Promise.all([tolerate(this.multibaas.hsm.listHsm()), tolerate(this.multibaas.hsm.listHsmWallets())]);
      hsm = {
        configs: (configs.result ?? []).map((entry) => ({ id: entry.configuration?.id ?? null, label: entry.configuration?.label ?? null, wallets: entry.wallets?.length ?? 0 })),
        wallets: (wallets.result ?? []).map((entry) => ({ address: entry.publicAddress, keyName: entry.keyName, vaultName: entry.vaultName ?? null })),
      };
    }
    return { provider: this.provider, address, balance, fileKey: await this.fileSigner.getAddress(), multibaas: Boolean(this.multibaas), wallet: this.wallet, hsm };
  }

  /// `{ provider: 'key' }` signs from the file key again. `{ provider: 'multibaas', azure?, key?, wallet?, gas? }`
  /// registers the Azure account and key with MultiBaas when given, picks the Cloud Wallet, hands
  /// the roles (and `gas` ETH) to it and switches. Steps already done are skipped.
  async configure({ provider, azure = null, key = null, wallet = null, gas = null } = {}) {
    ensure(['key', 'multibaas'].includes(provider), 400, 'INVALID_BODY', 'provider must be key or multibaas');
    if (provider === 'key') {
      await this.venues.useSigner(this.fileSigner);
      Object.assign(this, { provider: 'key', wallet: null });
      this.agreements?.venues.clear();
      await this.persist();
      return this.describe();
    }
    ensure(this.multibaas, 503, 'NO_MULTIBAAS', 'Set MULTIBAAS_URL and MULTIBAAS_API_KEY to sign from a Cloud Wallet');
    ensure(gas === null || /^\d+(\.\d+)?$/.test(String(gas)), 400, 'INVALID_BODY', 'gas is an ETH amount, e.g. "0.05"');
    const steps = {};
    if (azure) {
      ensure(AZURE_FIELDS.every((field) => isString(azure[field])), 400, 'INVALID_BODY', `azure needs ${AZURE_FIELDS.join(', ')}`);
      steps.config = await tolerate(this.multibaas.hsm.addHsmConfig(Object.fromEntries(AZURE_FIELDS.map((field) => [field, azure[field]]))));
    }
    if (key) {
      ensure(isString(key.clientID) && isString(key.keyName) && isString(key.vaultName), 400, 'INVALID_BODY', 'key needs clientID, keyName, vaultName (and keyVersion unless create)');
      if (key.create) {
        const created = await tolerate(this.multibaas.hsm.createHsmKey({ clientID: key.clientID, keyName: key.keyName, vaultName: key.vaultName, useHardwareModule: key.useHardwareModule ?? true }));
        wallet ??= created.result?.publicAddress ?? null;
        steps.key = created;
      } else {
        ensure(isString(key.keyVersion), 400, 'INVALID_BODY', 'key.keyVersion is required to add an existing key');
        steps.key = await tolerate(this.multibaas.hsm.addHsmKey({ clientID: key.clientID, keyName: key.keyName, keyVersion: key.keyVersion, vaultName: key.vaultName }));
      }
    }
    const chosen = await cloudWallet(this.multibaas, wallet ?? undefined).catch((error) => { throw new AppError(400, 'NO_HSM_WALLET', error.message); });
    const tokens = (this.agreements?.list() ?? []).map((record) => record.deployment?.token).filter(Boolean);
    steps.handover = await this.venues.handover(chosen.publicAddress, { gas, tokens });
    await this.venues.useSigner(new MultiBaasSigner(this.multibaas, chosen.publicAddress, this.venues.provider));
    Object.assign(this, { provider: 'multibaas', wallet: { address: chosen.publicAddress, keyName: chosen.keyName ?? null, vaultName: chosen.vaultName ?? null } });
    this.agreements?.venues.clear();
    await this.persist();
    return { ...(await this.describe()), steps };
  }
}

export function signingRoutes(settings) {
  const router = Router();
  const wrap = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req)).then((value) => res.json(value)).catch(next);
  router.get('/settings/signing', wrap(() => settings.describe()));
  router.put('/settings/signing', wrap((req) => {
    ensure(req.body && typeof req.body === 'object' && !Array.isArray(req.body), 400, 'INVALID_BODY', 'Expected fields: provider (key | multibaas), azure?, key?, wallet?, gas?');
    return settings.configure(req.body);
  }));
  return router;
}
