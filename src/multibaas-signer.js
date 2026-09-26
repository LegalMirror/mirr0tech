// The operator key in a hardware store instead of a file: an ethers signer whose transactions are
// signed and submitted by a MultiBaas Cloud Wallet (an HSM-backed key MultiBaas holds). The gateway
// builds the transaction as usual; only the signature leaves the vault, never the key.
import { AbstractSigner, getAddress } from 'ethers';

export class MultiBaasSigner extends AbstractSigner {
  /// `client` is `multibaasClient()`; `address` the Cloud Wallet's public address (`listHsmWallets`).
  constructor(client, address, provider = null, { pollMs = 500, attempts = 120 } = {}) {
    super(provider);
    Object.assign(this, { client, address: getAddress(address), pollMs, attempts });
  }

  async getAddress() { return this.address; }
  connect(provider) { return new MultiBaasSigner(this.client, this.address, provider, { pollMs: this.pollMs, attempts: this.attempts }); }
  signTransaction() { throw new Error('MultiBaasSigner signs inside the HSM; use sendTransaction'); }
  signMessage() { throw new Error('MultiBaasSigner does not sign messages'); }
  signTypedData() { throw new Error('MultiBaasSigner does not sign typed data'); }

  /// Fills the transaction from the chain, hands it to the vault, and returns the response once the node has it.
  async sendTransaction(tx) {
    const populated = await this.populateTransaction({ ...tx, from: this.address, type: 2 });
    const request = { tx: {
      from: this.address, to: populated.to ?? null, value: (populated.value ?? 0n).toString(), data: populated.data ?? '0x',
      gas: Number(populated.gasLimit), nonce: populated.nonce, gasFeeCap: populated.maxFeePerGas.toString(), gasTipCap: populated.maxPriorityFeePerGas.toString(), type: 2,
    } };
    const { data } = await this.client.hsm.signAndSubmitTransaction(request);
    const hash = data?.result?.tx?.hash;
    if (!data?.result?.submitted || !hash) throw new Error(`MultiBaas did not submit the transaction: ${data?.message ?? 'no response'}`);
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const response = await this.provider.getTransaction(hash);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    throw new Error(`Transaction ${hash} was submitted by MultiBaas but the node has not seen it`);
  }
}

/// The wallet the gateway signs with, from the deployment's HSM wallets: the one named, or the only one.
export async function cloudWallet(client, address = process.env.MULTIBAAS_WALLET) {
  const { data } = await client.hsm.listHsmWallets();
  const wallets = data?.result ?? [];
  const wallet = address ? wallets.find((entry) => entry.publicAddress.toLowerCase() === address.toLowerCase()) : wallets.length === 1 ? wallets[0] : null;
  if (!wallet) throw new Error(address ? `MultiBaas has no HSM wallet ${address}` : `Set MULTIBAAS_WALLET to one of ${wallets.map((entry) => entry.publicAddress).join(', ') || 'no HSM wallets yet'}`);
  return wallet;
}
