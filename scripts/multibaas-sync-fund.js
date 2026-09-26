// Explicit operator indexing command; it does not deploy, fund or publish a fund.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { syncFundDeployment } from '../src/multibaas.js';

async function main() {
  const [fundId, startingBlock, agreementsFile, stackFile] = process.argv.slice(2);
  if (!/^agr_[a-f0-9]{12}$/.test(fundId ?? '') || startingBlock === undefined) {
    throw new Error('Usage: node scripts/multibaas-sync-fund.js <agreement-id> <starting-block> [agreements-file] [stack-record]');
  }
  const stack = JSON.parse(await readFile(stackFile ?? process.env.DEPLOYMENT_PATH ?? 'deployments/sepolia.json', 'utf8'));
  const records = JSON.parse(await readFile(agreementsFile ?? `${process.env.DATA_DIR ?? 'generated'}/agreements-${stack.chainId}.json`, 'utf8'));
  const agreement = records.find((record) => record.id === fundId);
  if (agreement?.status !== 'deployed' || !agreement.deployment?.cashier?.enabled) throw new Error('Choose a deployed cashier agreement');
  const deployment = agreement.deployment;
  if (deployment.chainId !== stack.chainId || deployment.policyHash !== agreement.policyHash) throw new Error('Agreement deployment scope does not match the stack');
  const { tokenAbi, assetAbi } = deployment.cashier;
  if (!tokenAbi || !assetAbi) throw new Error('This older deployment record lacks its token/asset ABIs; use syncFundDeployment with explicitly verified ABIs as documented in docs/INVESTOR_TRADING.md');
  const { abi: attestor } = JSON.parse(await readFile('artifacts/rwa-secondary/PolicyAttestor.json', 'utf8'));
  const record = { ...stack, rwa: { ...stack.rwa, ...deployment, policyHash: agreement.policyHash, clauseTableHash: agreement.clauseTableHash } };
  const result = await syncFundDeployment(record, { fundId, startingBlock, abis: { token: tokenAbi, asset: assetAbi, attestor }, log: console.log });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
