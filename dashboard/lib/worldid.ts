// World ID on the client: a proof payload for the mock verifier (same derivation as src/worldid.js),
// and the shape the real IDKit widget hands back.
export type ProofPayload = {
  protocol_version: "4.0" | "3.0";
  nonce: string;
  action: string;
  responses: unknown[];
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A mock 4.0 uniqueness proof whose nullifier is the human behind `asWallet` (default: the wallet itself). */
export async function mockProof(wallet: string, action: string, asWallet = wallet): Promise<ProofPayload> {
  return {
    protocol_version: "4.0",
    nonce: await sha256Hex(`nonce:${wallet}`),
    action,
    responses: [
      {
        identifier: "mock",
        issuer_schema_id: 1,
        nullifier: await sha256Hex(`human:${asWallet.toLowerCase()}`),
        expires_at_min: 0,
        proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
        signal_hash: await sha256Hex(`signal:${wallet.toLowerCase()}`),
      },
    ],
  };
}
