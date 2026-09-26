// Seeds a running stack API with the golden-path state so the dashboard opens on a story:
// shares minted and released, a hooked and a hookless pool, three lenders in three states, a
// shipped buyback with one fill and one refused quote. Idempotent enough to rerun after a restart.
import { mockProof } from '../src/worldid.js';

const base = (process.env.STACK_URL ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const key = process.env.API_KEY ?? 'local-dev-stack-operator-key-only';
const call = async (path, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(`${base}/v1/stack${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  console.log(`${response.status} ${method} ${path}${data.error ? ` → ${data.error.code}: ${data.error.message.slice(0, 120)}` : ''}`);
  return data;
};
const ADMITTED = { mlaCountersigned: true, lenderCheckPassed: true, amlKycProvided: true, notInsolvent: true };

// Act 1
await call('/rwa/mint', { amount: '1000000' });
await call('/rwa/release', { wallet: 'Stranger', amount: '10' });                 // refused: not onboarded
const investor = (await call('/wallets')).find((wallet) => wallet.name === 'Investor').address;
await call('/wallets/Investor/worldid', { proof: mockProof(investor) });                     // World ID proof of human → humanVerified
await call('/wallets/Investor/facts', { policy: 'rwa', facts: { kycApproved: true, amlApproved: true } });
await call('/rwa/release', { wallet: 'Investor', amount: '500000' });
for (const wallet of ['Investor', 'Stranger']) await call(`/wallets/${encodeURIComponent(wallet)}/fund`, { amount: '1000000' });
await call('/rwa/pools', { wallet: 'Stranger', hooked: true });
await call('/rwa/pools', { wallet: 'Stranger', hooked: false });
await call('/rwa/liquidity', { wallet: 'Investor', hooked: false });               // refused: no policy, no door
await call('/rwa/liquidity', { wallet: 'Investor', hooked: true });
await call('/rwa/swap', { wallet: 'Investor', hooked: true });
await call('/rwa/liquidity', { wallet: 'Stranger', hooked: true });                // refused: Exhibit A

// Act 2
for (const wallet of ['Lender A', 'Lender B', 'Lender C', 'Operator']) await call(`/wallets/${encodeURIComponent(wallet)}/fund`, { amount: '3000000' });
await call('/wallets/Lender%20A/facts', { policy: 'credit', facts: ADMITTED });
await call('/wallets/Lender%20B/facts', { policy: 'credit', facts: { ...ADMITTED, mlaCountersigned: undefined } });
await call('/wallets/Lender%20C/facts', { policy: 'credit', facts: ADMITTED });
await call('/wallets/Lender%20C/sanction', { sanctioned: true });
await call('/wallets/Operator/facts', { policy: 'credit', facts: ADMITTED });
await call('/credit/deposit', { wallet: 'Lender A', amount: '1000000' });
await call('/credit/deposit', { wallet: 'Lender C', amount: '10' });               // refused: designated
await call('/credit/buyback', {});
await call('/credit/buyback/quote', { wallet: 'Lender A', amount: '100000' });
await call('/credit/buyback/fill', { wallet: 'Lender A', amount: '100000' });
await call('/credit/buyback/quote', { wallet: 'Stranger', amount: '10' });         // refused at quote time
console.log('seeded');
