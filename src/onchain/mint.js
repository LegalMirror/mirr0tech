import { readFileSync } from 'node:fs';
import { Contract, getAddress, id, isAddress, parseUnits, ZeroAddress } from 'ethers';
import { ensure } from '../errors.js';

export const MINT_TEST_FLAGS = JSON.parse(readFileSync(new URL('../../shared/mint-test-flags.json', import.meta.url)));
export function mintTestFlags(value = {}) {
  ensure(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => MINT_TEST_FLAGS.some(item => item.fact === key) && typeof value[key] === 'boolean'),
    400, 'INVALID_MINT', 'testAttestations must contain supported boolean test flags.');
  return Object.fromEntries(MINT_TEST_FLAGS.map(({ fact }) => [fact, value[fact] === true]));
}
const TOKEN = [
  'function custodian() view returns(address)', 'function hasRole(bytes32,address) view returns(bool)',
  'function policyHash() view returns(bytes32)', 'function decimals() view returns(uint8)',
  'function processed(bytes32) view returns(bool)', 'function mint(bytes32,uint256)',
  'function release(bytes32,address,uint256)',
];
const ORACLE = ['function sanctions() view returns(address)', 'function attestor() view returns(address)', 'function decide(address,uint8) view returns(bool,uint16)', 'function mayTransfer(address) view returns(bool,uint16)'];

export function mintInput(body) {
  ensure(body && isAddress(body.recipient) && body.recipient !== ZeroAddress
    && typeof body.amount === 'string' && body.amount.length <= 80 && /^\d+(?:\.\d{1,6})?$/.test(body.amount)
    && typeof body.requestId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId),
  400, 'INVALID_MINT', 'Provide a recipient address, positive amount with up to six decimals, and requestId.');
  ensure(body.bypassSubscription === undefined || typeof body.bypassSubscription === 'boolean', 400, 'INVALID_MINT', 'bypassSubscription must be boolean.');
  ensure(body.simulateDeposit === undefined || typeof body.simulateDeposit === 'boolean', 400, 'INVALID_MINT', 'simulateDeposit must be boolean.');
  const units = parseUnits(body.amount, 6);
  ensure(units > 0n && units < (1n << 256n), 400, 'INVALID_MINT', 'Mint amount must be positive and fit uint256.');
  return { recipient: getAddress(body.recipient), amount: body.amount, units: units.toString(), requestId: body.requestId, bypassSubscription: body.bypassSubscription === true, simulateDeposit: body.simulateDeposit === true, testAttestations: mintTestFlags(body.testAttestations) };
}

export function createRwaMinter(signer, { sanctionsAdmin = signer, mockSanctionsAddress = null } = {}) {
  return async ({ record, policy, operation, progress }) => {
    const d = record.deployment;
    const chainId = Number(BigInt(await signer.provider.send('eth_chainId', [])));
    ensure(chainId === d.chainId, 409, 'WRONG_CHAIN', 'Backend RPC does not match the deployed token’s chain.');
    if (operation.bypassSubscription || operation.simulateDeposit || Object.values(mintTestFlags(operation.testAttestations)).some(Boolean)) {
      ensure([11155111, 31337].includes(chainId), 403, 'TESTNET_ONLY', 'Simulated mint attestations are available on test networks only.');
    }
    const backend = await signer.getAddress();
    const token = new Contract(d.token, TOKEN, signer);
    const oracle = new Contract(d.oracle, ORACLE, signer.provider);
    const [custodian, hasRole, policyHash, decimals] = await Promise.all([
      token.custodian(), token.hasRole(id('MINTER_ROLE'), backend), token.policyHash(), token.decimals(),
    ]);
    ensure(hasRole && custodian.toLowerCase() === backend.toLowerCase(), 403, 'NOT_MINTER', 'The configured backend signer must be this token’s minter and custodian.');
    ensure(policyHash.toLowerCase() === record.policyHash.toLowerCase() && decimals === 6n, 409, 'TOKEN_MISMATCH', 'Token policy or decimals do not match the agreement.');
    const amount = BigInt(operation.units);
    const mintId = id(`agreement:${record.id}:mint:${operation.requestId}`);
    const releaseId = id(`agreement:${record.id}:release:${operation.requestId}`);
    const self = operation.recipient.toLowerCase() === custodian.toLowerCase();
    await progress({ backend, token: d.token, chainId });
    // Reconcile any recorded broadcast before considering a replacement transaction.
    for (const field of ['subscriptionTxHash', 'depositTxHash', ...MINT_TEST_FLAGS.map(({ fact }) => `${fact}TxHash`), 'mintTxHash', 'releaseTxHash']) {
      if (!operation[field]) continue;
      const receipt = await signer.provider.waitForTransaction(operation[field], 1, 120000);
      ensure(receipt, 409, 'TRANSACTION_PENDING', 'A previous transaction is still pending. Retry this same request later.');
      if (receipt.status === 0) await progress({ [field]: null });
    }
    // A retry after a timeout/restart checks the token’s operation IDs before issuing anything again.
    const alreadyMinted = await token.processed(mintId);
    if (!alreadyMinted) {
      const action = policy.actionOrder.indexOf('mint');
      ensure(action >= 0, 409, 'MINT_DISABLED', 'This agreement does not enable minting.');
      const context = { signer, oracle, record, policy, operation, progress, chainId };
      if (operation.bypassSubscription) await attestTestFact({ ...context, fact: 'subscriptionAccepted', label: 'subscription acceptance', txField: 'subscriptionTxHash' });
      // Only the explicit test flag records simulated receipt of bank funds.
      // Normal issuance obtains confirmation from the payment settlement flow.
      if (operation.simulateDeposit) {
        await attestTestFact({ ...context, fact: 'depositConfirmed', label: 'deposit confirmation', txField: 'depositTxHash' });
      }
      for (const { fact, label } of MINT_TEST_FLAGS) {
        if (!operation.testAttestations?.[fact]) continue;
        if (fact === 'sanctionsClear') await clearMockSanctions({ ...context, sanctionsAdmin, mockSanctionsAddress });
        else await attestTestFact({ ...context, fact, label, txField: `${fact}TxHash` });
      }
      const [allowed, clause] = await oracle.decide(operation.recipient, action);
      ensure(allowed, 403, 'POLICY_REFUSED', `Minting is refused by ${policy.clauseTable?.find(item => item.clauseId === Number(clause))?.ruleId ?? "policy"} (clause ${clause}). Complete the recipient’s required attestations first.`);
    }
    if (!self && !await token.processed(releaseId)) {
      const [allowed, clause] = await oracle.mayTransfer(operation.recipient);
      ensure(allowed, 403, 'POLICY_REFUSED', `The recipient is refused by transfer clause ${clause}. Complete recipient eligibility before minting.`);
    }
    const confirm = async (transaction, field) => {
      await progress({ [field]: transaction.hash });
      const receipt = await signer.provider.waitForTransaction(transaction.hash, 1, 120000);
      ensure(receipt?.status === 1, 502, 'MINT_TRANSACTION_FAILED', 'The mint/release transaction failed.');
    };
    if (!alreadyMinted) {
      await token.mint.staticCall(mintId, amount);
      await confirm(await token.mint(mintId, amount), 'mintTxHash');
    }
    await progress({ stage: self ? 'complete' : 'release', minted: true });
    if (!self && !await token.processed(releaseId)) {
      await token.release.staticCall(releaseId, operation.recipient, amount);
      await confirm(await token.release(releaseId, operation.recipient, amount), 'releaseTxHash');
    }
    return { stage: 'complete', minted: true, status: 'confirmed' };
  };
}

// Merge one test attestation while preserving other live facts and their validity window.
// Explicit test flags may simulate identity and compliance; they never verify real-world evidence.
async function attestTestFact({ signer, oracle, record, policy, operation, progress, chainId, fact, label, txField }) {
  ensure(chainId === 11155111 || chainId === 31337, 403, 'TESTNET_ONLY', 'Automatic test attestations are available on test networks only.');
  const index = policy.factOrder?.indexOf(fact) ?? -1;
  ensure(index >= 0, 409, 'NO_ATTESTATION_FACT', `This policy does not define ${fact}.`);
  const attestor = new Contract(await oracle.attestor(), [
    'function hasRole(bytes32,address) view returns(bool)',
    'function factsOf(address,bytes32) view returns(uint256,uint256,uint32)',
    'function expiresAt(address,bytes32) view returns(uint32)',
    'function attest(address,bytes32,uint256,uint256,uint32,uint32)',
  ], signer);
  const [known, value] = await attestor.factsOf(operation.recipient, record.policyHash);
  const bit = 1n << BigInt(index);
  if ((known & value & bit) !== 0n) return;
  ensure(await attestor.hasRole(id('ATTESTOR_ROLE'), await signer.getAddress()), 403, 'NOT_ATTESTOR', `The backend needs ATTESTOR_ROLE to record test ${label}.`);
  const now = (await signer.provider.getBlock('latest')).timestamp;
  const previousExpiry = Number(await attestor.expiresAt(operation.recipient, record.policyHash));
  const expiry = previousExpiry > now ? Math.min(previousExpiry, now + 86400) : now + 86400;
  const tx = await attestor.attest(operation.recipient, record.policyHash, known | bit, value | bit, now, expiry);
  await progress({ [txField]: tx.hash });
  const receipt = await signer.provider.waitForTransaction(tx.hash, 1, 120000);
  ensure(receipt?.status === 1, 502, 'ATTESTATION_FAILED', `Test ${label} did not confirm. Retry this same request.`);
}

async function clearMockSanctions({ oracle, operation, progress, sanctionsAdmin, mockSanctionsAddress }) {
  const address = await oracle.sanctions();
  ensure(mockSanctionsAddress && address.toLowerCase() === mockSanctionsAddress.toLowerCase(), 409, 'NOT_MOCK_SANCTIONS', 'Sanctions simulation requires the configured test stack’s mock sanctions oracle.');
  const sanctions = new Contract(address, ['function admin() view returns(address)', 'function isSanctioned(address) view returns(bool)', 'function setSanctioned(address,bool)'], sanctionsAdmin);
  if (!await sanctions.isSanctioned(operation.recipient)) return;
  ensure((await sanctions.admin()).toLowerCase() === (await sanctionsAdmin.getAddress()).toLowerCase(), 403, 'NOT_SANCTIONS_ADMIN', 'The configured mock sanctions administrator must authorize test clearance.');
  const tx = await sanctions.setSanctioned(operation.recipient, false);
  await progress({ sanctionsClearTxHash: tx.hash });
  const receipt = await sanctionsAdmin.provider.waitForTransaction(tx.hash, 1, 120000);
  ensure(receipt?.status === 1, 502, 'ATTESTATION_FAILED', 'Test sanctions clearance did not confirm. Retry this same request.');
}
