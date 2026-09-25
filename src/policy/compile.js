import { validateAst, ACTIONS } from './schema.js';
import { canonical, sha256 } from './document.js';
import { evaluatePolicy } from './evaluate.js';
import { buildOnchainPolicy, emitCompiledPolicy } from './onchain.js';
import { compileCondition, evaluateTerms } from './dnf.js';
import { resolveComponents, PROFILES } from './components.js';


// The on-chain evaluator only earns trust if it decides identically to the interpreter the backend
// runs. Before emitting anything, replay every rule over all three-valued assignments of the facts
// it mentions and refuse to compile on the first disagreement.
function proveEquivalence(ast, factOrder) {
  const factsOf = (node, found = new Set()) => {
    if (node.type === 'fact') found.add(node.name);
    if (node.child) factsOf(node.child, found);
    if (node.children) node.children.forEach((child) => factsOf(child, found));
    return found;
  };
  let checked = 0;
  for (const rule of ast.rules) {
    const names = [...factsOf(rule.condition)];
    if (names.length > 12) throw new Error(`Rule ${rule.id} mentions too many facts to verify exhaustively`);
    const terms = compileCondition(rule.condition);
    const probe = { rules: [{ ...rule, action: 'mint', effect: 'require' }] };
    for (let index = 0; index < 3 ** names.length; index++) {
      const facts = {};
      let known = 0n;
      let value = 0n;
      let rest = index;
      for (const name of names) {
        const digit = rest % 3;
        rest = Math.floor(rest / 3);
        if (digit === 2) continue;
        facts[name] = digit === 1;
        const bit = 1n << BigInt(factOrder.indexOf(name));
        known |= bit;
        if (digit === 1) value |= bit;
      }
      const expected = evaluatePolicy(probe, 'mint', facts).trace[0].result;
      if (evaluateTerms(terms, known, value) !== expected) {
        throw new Error(`Compiled rule ${rule.id} disagrees with the interpreter on ${JSON.stringify(facts)}`);
      }
      checked++;
    }
  }
  return checked;
}

function checkCustodialConfig(config, ast, { secondary = false } = {}) {
  if (secondary && config.secondaryVenue !== 'uniswap-v4') throw new Error('The secondary profile requires secondaryVenue: uniswap-v4');
  if (secondary && !ast.rules.some((r) => r.action === 'transfer' && r.effect === 'permit')) throw new Error('The secondary profile needs a transfer permit quoting the agreement');
  if (config.decimals !== 6 || config.custody !== 'backend' || config.currency !== 'USD' || config.priceModel !== 'one-token-per-usd') throw new Error('Only the six-decimal custodial USD demo price model is implemented');
  if (!/^[1-9][0-9]{0,77}$/.test(config.maxSupply) || BigInt(config.maxSupply) >= 2n ** 256n) throw new Error('Invalid uint256 supply cap');
  for (const value of [config.name, config.symbol]) if (typeof value !== 'string' || !/^[A-Za-z0-9 ._-]{1,64}$/.test(value)) throw new Error('Invalid token name or symbol');
}

function checkCreditConfig(config, ast) {
  if (config.venue !== 'wildcat') throw new Error('The credit profile targets Wildcat V2 markets');
  if (!Number.isInteger(config.attestationValiditySeconds) || config.attestationValiditySeconds <= 0 || config.attestationValiditySeconds > 90 * 86400) {
    throw new Error('attestationValiditySeconds must be a positive integer of at most 90 days');
  }
  if (!Number.isInteger(config.credentialTimeToLiveSeconds) || config.credentialTimeToLiveSeconds <= 0) {
    throw new Error('credentialTimeToLiveSeconds must be a positive integer');
  }
  if (!ast.rules.some((rule) => rule.action === 'deposit' && rule.effect === 'permit')) {
    throw new Error('A credit policy must permit deposits under at least one rule');
  }
}

export function compilePolicy(envelope, config, document, { demo = false } = {}) {
  validateAst(envelope.ast, document.text);
  if (envelope.source.sha256 !== document.sha256 || envelope.source.textSha256 !== document.textSha256) throw new Error('Source document hash mismatch');
  if (envelope.ast.unresolved.length && !demo) throw new Error('Unresolved legal terms cannot be compiled for execution. Use --demo only for local simulation.');
  const profile = config.profile ?? 'custodial-rwa';
  if (!PROFILES[profile]) throw new Error(`Unknown deployment profile: ${profile}`);
  if (profile === 'custodial-rwa') checkCustodialConfig(config, envelope.ast);
  else if (profile === 'rwa-secondary') checkCustodialConfig(config, envelope.ast, { secondary: true });
  else checkCreditConfig(config, envelope.ast);
  if (!Array.isArray(config.assumptions) || config.assumptions.length === 0) throw new Error('Explicit deployment assumptions are required');

  // Link the AST against the component library: every rule and term must resolve to a component.
  const resolution = resolveComponents(envelope.ast, config);
  const onchain = buildOnchainPolicy(envelope.ast);
  const checked = proveEquivalence(envelope.ast, onchain.facts);

  // The fact and action orders are bit positions on chain, so they belong inside the hash: a
  // reordering is a different policy and must produce a different deployment.
  // Component ids and versions are inside the hash: the hash names the blocks that enforce the document.
  const policy = {
    version: 3, demo, profile, source: envelope.source, ast: envelope.ast, config,
    components: resolution.components, coverage: resolution.coverage,
    factOrder: onchain.facts, actionOrder: onchain.actions, clauseTableHash: onchain.clauseTableHash,
  };
  policy.hash = `0x${sha256(canonical(policy))}`;

  const enabled = (action) => envelope.ast.rules.some((rule) => rule.action === action && rule.effect === 'permit');
  const solidity = profile !== 'wildcat-credit' ? `// SPDX-License-Identifier: MIT
// Generated by Mirrortech. Legal facts are attested and enforced by the backend.
pragma solidity ^0.8.24;
import {MirrorToken} from "../contracts/MirrorToken.sol";
contract CompiledMirrorToken is MirrorToken {
    constructor(address admin, address minter) MirrorToken(
        ${JSON.stringify(config.name)}, ${JSON.stringify(config.symbol)}, admin, minter,
        ${policy.hash}, ${config.maxSupply}, ${enabled('mint')}, ${enabled('burn')}
    ) {}
}
` : null;

  const javascript = `// Generated from validated data; no model-generated code is executed.\nexport const policy = ${JSON.stringify(policy, null, 2)};\n${evaluatePolicy.toString()}\nexport const evaluate = (action, facts) => evaluatePolicy(policy.ast, action, facts);\n`;
  const compiledPolicy = emitCompiledPolicy(onchain, policy.hash);
  const clauseTable = { policyHash: policy.hash, clauseTableHash: onchain.clauseTableHash, clauses: onchain.clauses };
  return { policy, solidity, javascript, compiledPolicy, clauseTable, onchain, components: resolution.manifest, contracts: resolution.contracts, equivalenceChecks: checked };
}

export function verifyPolicy(policy) {
  const { hash, ...content } = policy;
  if (hash !== `0x${sha256(canonical(content))}`) throw new Error('Compiled policy integrity check failed');
  validateAst(policy.ast);
  return policy;
}

export { ACTIONS };
