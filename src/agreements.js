// The product's core loop, one record per uploaded agreement:
//   uploaded → extracting → verified → analyzed (legal AST), or compiled → deploying → deployed (compiler fixtures).
// `verified` means the extraction returned an AST whose quotes are in the document; `compiled`
// means the policy hash, clause table and Solidity exist; `deployed` means the token, its oracle,
// its hook and a policy-managed pool are on chain. Records persist as one JSON file; the heavy
// export (located quotes, coverage, programs) is recomputed from the record when needed.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { bundleDocuments, documentFrom } from './policy/document.js';
import { compilePolicy } from './policy/compile.js';
import { cashierFixture } from './onchain/cashier.js';
import { ACTIONS, validateAst } from './policy/schema.js';
import { CREDENTIALS, DEFAULT_ACTION } from './worldid.js';
import { extractWorkspace } from './openai-extract.js';
import { isLegalAst, legalAstGraph } from './legal/ast.js';
import { PROFILES, exportCompiled } from '../scripts/export-ui.js';
import { AppError, ensure } from './errors.js';

export const STATES = ['uploaded', 'extracting', 'verified', 'analyzed', 'compiled', 'deploying', 'deployed', 'failed'];
// Why this credential is the minimum sufficient assurance, in the rule's own words.
const IDENTITY_RATIONALE = {
  document: 'KYC is an identity check, so the proportionate credential is a government document: a World ID Passport/NFC credential, verified by the gateway and bound to the wallet, satisfies it; its nullifier keeps one person from onboarding twice.',
  proof_of_human: 'The agreement asks for a person behind the wallet, not who: a World ID proof of human, verified by the gateway and bound to the wallet, is the minimum sufficient credential; its nullifier keeps one person from onboarding twice.',
  selfie: 'The agreement asks for a live person behind the wallet: a World ID selfie check, verified by the gateway and bound to the wallet, satisfies it; its nullifier keeps one person from onboarding twice.',
};
const isIdentityRule = (rule) => rule.id.endsWith('-identity-verified');
const REGENERATE_FROM = ['verified', 'analyzed', 'compiled', 'deployed', 'failed'];
const now = () => new Date().toISOString();

const summary = ({ documents, envelope, verification, config, ...record }) => ({
  ...record,
  verification: verification ? { confidence: { overall: verification.confidence.overall, verified: verification.confidence.verified, total: verification.confidence.total, counts: verification.confidence.counts }, contested: verification.contested.length } : null,
});

/// The explicit offline compiler fixture, only valid when its quotations match the document.
export function draftFor(spec, document, config = {}) {
  try { return validateAst((config.cashier?.enabled ? cashierFixture(document) : spec.fixture(document)).ast, document.text); } catch { return null; }
}

const factsOf = (node) => (node.type === 'fact' ? [node.name] : node.children ? node.children.flatMap(factsOf) : factsOf(node.child));

/// The Contract-AST view: agreement → actions → rules → facts, terms and open items, each rule
/// carrying what the extraction established about it.
export function astGraph({ title, rules, terms, unresolved, verification }) {
  const contested = new Set((verification?.contested ?? []).map((item) => item.ref));
  const byRef = verification?.confidence.byRef ?? {};
  const status = (ref) => (contested.has(ref) ? 'contested' : ref in byRef ? 'verified' : 'unverified');
  const nodes = new Map([['agreement', { id: 'agreement', kind: 'agreement', label: title }]]);
  const edges = [];
  const link = (from, node) => { nodes.set(node.id, nodes.get(node.id) ?? node); edges.push({ from, to: node.id }); };
  for (const rule of rules) {
    const ref = `rule:${rule.id}`;
    link('agreement', { id: `action:${rule.action}`, kind: 'action', label: rule.action });
    link(`action:${rule.action}`, { id: ref, kind: 'rule', label: rule.id, effect: rule.effect, clauseId: rule.clauseId, clause: rule.source.clause, status: status(ref), confidence: byRef[ref] ?? null });
    for (const fact of new Set(factsOf(rule.condition))) link(ref, { id: `fact:${fact}`, kind: 'fact', label: fact });
  }
  for (const term of terms) {
    const ref = `term:${term.name}`;
    link('agreement', { id: ref, kind: 'term', label: term.name, value: term.value, clause: term.source.clause, status: status(ref), confidence: byRef[ref] ?? null });
  }
  unresolved.forEach((item, index) => link('agreement', { id: `unresolved:${index}`, kind: 'unresolved', label: item.clause, description: item.description, status: 'unresolved' }));
  return { nodes: [...nodes.values()], edges };
}

export class Agreements {
  /// `extract` and `deployer` are injectable: the extraction client and the chain deploy.
  /// `venueFactory` builds the operator service over one deployed agreement's token, oracle and hook.
  constructor({ path = null, uploadsPath = null, extract = extractWorkspace, deployer = null, venueFactory = null, worldIdAction = process.env.WORLD_ACTION ?? DEFAULT_ACTION, log = () => {} } = {}) {
    ensure(typeof worldIdAction === 'string' && worldIdAction.trim(), 500, 'CONFIG', 'WORLD_ACTION must not be empty');
    Object.assign(this, { path, uploadsPath, extract, deployer, venueFactory, worldIdAction, log, records: new Map(), exports: new Map(), venues: new Map(), jobs: new Map() });
    this.deployQueue = Promise.resolve();
    this.persistQueue = Promise.resolve();
  }

  async init() {
    if (this.path) {
      try { for (const record of JSON.parse(await readFile(this.path, 'utf8'))) this.records.set(record.id, record); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // A restart mid-job leaves no one to finish it.
    for (const record of this.records.values()) if (['uploaded', 'extracting', 'deploying'].includes(record.status)) this.transition(record, 'failed', { error: `Interrupted while ${record.status}` });
    return this;
  }

  async persist() {
    if (!this.path) return;
    const snapshot = JSON.stringify([...this.records.values()]);
    const write = this.persistQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    this.persistQueue = write.catch(() => {});
    await write;
  }

  /// Every job in flight; tests and shutdown wait on it.
  settled() { return Promise.all(this.jobs.values()); }

  list() { return [...this.records.values()].map(summary); }

  record(id) {
    const record = this.records.get(id);
    if (!record) throw new AppError(404, 'NOT_FOUND', `Unknown agreement ${id}`);
    return record;
  }

  get(id) {
    const record = this.record(id);
    return { ...summary(record), ast: record.envelope?.ast ?? null, export: this.exports.has(id) || record.policyHash ? this.export(id) : null };
  }

  ast(id) {
    const record = this.record(id);
    ensure(record.envelope, 409, 'INVALID_STATE', `Agreement is ${record.status}; the tree exists after AST generation`);
    if (isLegalAst(record.envelope.ast)) return legalAstGraph(record.envelope.ast);
    return astGraph(record.policyHash ? this.export(id) : record.envelope.ast);
  }

  transition(record, status, patch = {}) {
    Object.assign(record, patch, { status, updatedAt: now() });
    record.history.push({ status, at: record.updatedAt, ...(record.policyHash ? { policyHash: record.policyHash } : {}) });
    this.log(`${record.id} ${status}${record.error ? `: ${record.error}` : ''}`);
  }

  /// `documents` are the uploaded files ([{ name, text }]); their bytes are kept so the reader sees them as written.
  async create({ name, documents, profile = 'rwa-secondary', config = null, generation = undefined }) {
    const spec = PROFILES.find((entry) => entry.profile === profile);
    ensure(spec, 400, 'UNKNOWN_PROFILE', `Unknown profile ${profile}`);
    ensure(generation === undefined || ['demo', 'openai'].includes(generation), 400, 'INVALID_BODY', 'generation must be demo or openai');
    let document;
    try { document = bundleDocuments(documents.map((part) => documentFrom(part.name, part.text))); } catch (error) { throw new AppError(400, 'INVALID_DOCUMENT', error.message); }
    let deploymentConfig = config ?? JSON.parse(await readFile(spec.config, 'utf8'));
    // Bind a configured non-default RP action before hashing a new policy. Old records keep their
    // historical action until an explicit constraint update produces a new deployment.
    if (profile !== 'wildcat-credit' && deploymentConfig.worldId?.action === undefined && this.worldIdAction !== DEFAULT_ACTION) {
      deploymentConfig = { ...deploymentConfig, worldId: { credential: 'document', ...deploymentConfig.worldId, action: this.worldIdAction } };
    }
    const record = {
      id: `agr_${randomBytes(6).toString('hex')}`, name, profile, status: 'uploaded', createdAt: now(), updatedAt: now(),
      source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256, ...(document.parts ? { parts: document.parts } : {}) },
      documents, config: deploymentConfig, ...(generation ? { generation } : {}),
      extraction: null, envelope: null, verification: null, policyHash: null, clauseTableHash: null, coverage: null, deployment: null, error: null, history: [],
    };
    if (this.uploadsPath) {
      const directory = join(this.uploadsPath, record.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const [index, part] of documents.entries()) {
        const filename = `${index + 1}-${basename(part.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        await writeFile(join(directory, filename), part.text, { mode: 0o600, flag: 'wx' });
      }
    }
    this.records.set(record.id, record);
    this.transition(record, 'uploaded');
    await this.persist();
    this.generate(record.id);
    return summary(record);
  }

  /// Runs the extraction and the compiler in the background; the record tells where it is.
  generate(id) {
    const record = this.record(id);
    ensure(!this.jobs.has(id), 409, 'INVALID_STATE', 'Agreement has a job in flight');
    const spec = PROFILES.find((entry) => entry.profile === record.profile);
    this.exports.delete(id);
    this.venues.delete(id);
    this.transition(record, 'extracting', { error: null, extraction: null, envelope: null, verification: null, policyHash: null, clauseTableHash: null, coverage: null, deployment: null });
    const job = (async () => {
      try {
        await this.persist();
        const document = this.document(record);
        const draft = draftFor(spec, document, record.config);
        const { envelope, verification } = await this.extract({ profile: record.profile, document, draft, generation: record.generation });
        this.transition(record, 'verified', { envelope, verification, extraction: envelope.extraction });
        if (isLegalAst(envelope.ast)) {
          this.transition(record, 'analyzed');
          return;
        }
        const exported = this.export(id);
        this.transition(record, 'compiled', { policyHash: exported.policyHash, clauseTableHash: exported.clauseTableHash, coverage: { total: exported.coverage.total, counts: exported.coverage.counts, rules: exported.coverage.rules, terms: exported.coverage.terms } });
      } catch (error) {
        this.transition(record, 'failed', { error: error.message });
      } finally {
        try { await this.persist(); } finally { this.jobs.delete(id); }
      }
    })();
    this.jobs.set(id, job);
    return summary(record);
  }

  regenerate(id) {
    const record = this.record(id);
    ensure(REGENERATE_FROM.includes(record.status), 409, 'INVALID_STATE', `Agreement is ${record.status}`);
    return this.generate(id);
  }

  document(record) { return bundleDocuments(record.documents.map((part) => documentFrom(part.name, part.text))); }

  export(id) {
    const record = this.record(id);
    ensure(record.envelope, 409, 'INVALID_STATE', `Agreement is ${record.status}; nothing compiled yet`);
    if (!this.exports.has(id)) {
      this.exports.set(id, exportCompiled({ profile: record.profile, document: this.document(record), raws: record.documents.map((part) => ({ name: part.name, raw: part.text })), envelope: record.envelope, verification: record.verification, config: record.config }));
    }
    return this.exports.get(id);
  }

  /// The identity constraint the issuer put on the agreement: which World ID credential, on which actions.
  constraints(id) {
    const record = this.record(id);
    ensure(record.envelope, 409, 'INVALID_STATE', `Agreement is ${record.status}; nothing compiled yet`);
    if (isLegalAst(record.envelope.ast)) return { identity: null };
    const rules = record.envelope.ast.rules.filter(isIdentityRule);
    return { identity: rules.length ? { credential: record.config.worldId?.credential ?? 'document', actions: rules.map((rule) => rule.action), clause: rules[0].source.clause, quote: rules[0].source.quote } : null };
  }

  /// Puts a World ID constraint on the agreement (or lifts it with `identity: null`): a `require
  /// identityVerified` rule per action, quoting the sentence it enforces, and the credential in the
  /// config. Both are inside the policy hash, so the agreement recompiles and must be deployed again.
  async constrain(id, { identity } = {}) {
    const record = this.record(id);
    ensure(record.envelope && !this.jobs.has(id), 409, 'INVALID_STATE', `Agreement is ${record.status}`);
    ensure(!isLegalAst(record.envelope.ast), 409, 'UNSUPPORTED_AST', 'Legal document ASTs require an explicit compiler mapping before deployment constraints can be added');
    ensure(identity === null || (identity && typeof identity === 'object' && !Array.isArray(identity)), 400, 'INVALID_BODY', 'identity: { credential, actions, quote?, clause? } or null');
    const document = this.document(record);
    const ast = { ...record.envelope.ast, rules: record.envelope.ast.rules.filter((rule) => !isIdentityRule(rule)) };
    const { worldId: _previous, ...config } = record.config;
    if (identity) {
      const { credential = 'document', actions = ['mint', 'transfer'] } = identity;
      ensure(credential in CREDENTIALS, 400, 'INVALID_BODY', `credential must be one of ${Object.keys(CREDENTIALS).join(', ')}`);
      ensure(Array.isArray(actions) && actions.length && actions.every((action) => ACTIONS.includes(action)), 400, 'INVALID_BODY', `actions must be among ${ACTIONS.join(', ')}`);
      const current = this.constraints(id).identity;
      const quote = identity.quote ?? current?.quote;
      ensure(typeof quote === 'string' && quote.trim(), 400, 'INVALID_BODY', 'quote: the sentence of the agreement this constraint enforces');
      ensure(document.text.includes(quote), 400, 'QUOTE_NOT_FOUND', 'The quote is not in the agreement verbatim');
      const clause = identity.clause ?? current?.clause ?? 'Investor onboarding';
      for (const action of [...new Set(actions)]) {
        ast.rules.push({ id: `${action}-identity-verified`, action, effect: 'require', condition: { type: 'fact', name: 'identityVerified' }, source: { clause, quote }, rationale: IDENTITY_RATIONALE[credential] });
      }
      config.worldId = { credential, action: this.worldIdAction };
    }
    validateAst(ast, document.text);
    Object.assign(record, { envelope: { ...record.envelope, ast }, config });
    this.exports.delete(id);
    this.venues.delete(id);
    const exported = this.export(id);
    this.transition(record, 'compiled', { policyHash: exported.policyHash, clauseTableHash: exported.clauseTableHash, coverage: { total: exported.coverage.total, counts: exported.coverage.counts, rules: exported.coverage.rules, terms: exported.coverage.terms }, deployment: null, error: null });
    await this.persist();
    return summary(record);
  }

  /// The operator service over this agreement's deployment: facts, identity, release, the pool.
  async venue(id) {
    const record = this.record(id);
    ensure(this.venueFactory, 503, 'NO_CHAIN', 'This gateway has no chain to operate on');
    ensure(record.status === 'deployed', 409, 'INVALID_STATE', `Agreement is ${record.status}; the venue exists once deployed`);
    if (!this.venues.has(id)) {
      const compiled = compilePolicy(record.envelope, record.config, this.document(record), { demo: true });
      this.venues.set(id, await this.venueFactory({ id, deployment: record.deployment, policy: compiled.policy, clauseTable: compiled.clauseTable, credential: record.config.worldId?.credential ?? 'document', action: record.config.worldId?.action ?? DEFAULT_ACTION }));
    }
    return this.venues.get(id);
  }

  /// Token, oracle, hook and pool for this agreement, in the background; 409 unless compiled.
  deploy(id) {
    const record = this.record(id);
    ensure(this.deployer, 503, 'NO_CHAIN', 'This gateway has no signer to deploy with');
    ensure(record.status === 'compiled', 409, 'INVALID_STATE', `Agreement is ${record.status}; deploy needs compiled`);
    const document = this.document(record);
    const compiled = compilePolicy(record.envelope, record.config, document, { demo: true });
    ensure(compiled.solidity, 409, 'UNSUPPORTED_PROFILE', `The ${record.profile} profile has no token of its own to deploy; it is served by the stack's credit venue`);
    this.venues.delete(id);
    this.transition(record, 'deploying');
    // All agreements share the signer, including operator and anonymous demo requests.
    const job = this.deployQueue.then(async () => {
      try {
        const deployment = await this.deployer({ policyHash: compiled.policy.hash, name: record.name, sources: { compiledPolicy: compiled.compiledPolicy, token: compiled.solidity, ...(compiled.compiledCashierTerms ? { cashierTerms: compiled.compiledCashierTerms, cashier: compiled.cashier } : {}) } });
        this.transition(record, 'deployed', { deployment });
      } catch (error) {
        this.transition(record, 'compiled', { error: `Deploy failed: ${error.message}` });
      } finally {
        try { await this.persist(); } finally { this.jobs.delete(id); }
      }
    });
    this.deployQueue = job.catch(() => {});
    this.jobs.set(id, job);
    return summary(record);
  }
}
