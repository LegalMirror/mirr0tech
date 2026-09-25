// Compiles both demo profiles in-process and writes the JSON the dashboard renders. Nothing under
// generated/ is touched: the dashboard sees exactly what the compiler would emit, recomputed.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convert } from 'html-to-text';
import { keccak256 } from 'ethers';
import { readDocuments } from '../src/policy/document.js';
import { sampleFixture } from '../src/policy/fixture.js';
import { mlaFixture } from '../src/policy/mla-fixture.js';
import { compilePolicy } from '../src/policy/compile.js';
import { buildOnchainPolicy } from '../src/policy/onchain.js';
import { buildAquaOrder, buildBuybackProgram, buybackTermsFrom, encodeOrder, encoders, loadOpcodes } from '../src/policy/programs.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (path) => `${root}${path}`;
const OUT = at('dashboard/public/data');
const OPCODES = at('vendor/swap-vm/src/opcodes/LimitOpcodes.sol');

export const PROFILES = [
  {
    profile: 'custodial-rwa', act: 1, label: 'Tokenize & trade', venue: 'Fund token + Uniswap v4 hook',
    documents: ['test/human_contracts/ea026411904ex10-9.htm'], config: 'examples/demo-config.json', fixture: sampleFixture,
  },
  {
    profile: 'wildcat-credit', act: 2, label: 'Lend it out', venue: 'Wildcat role provider + 1inch Aqua exit',
    documents: ['test/human_contracts/wildcat-mla.md', 'test/human_contracts/lender-check-policy.md', 'test/human_contracts/buyback-addendum.md'],
    config: 'examples/wildcat-config.json', fixture: mlaFixture,
  },
];

// The same options document.js hands to html-to-text, so the text before whitespace collapse is the
// text the compiler normalized.
const HTML_OPTIONS = { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] };
const EFFECT_NAMES = ['permit', 'require', 'forbid'];
const hex = (value) => `0x${value.toString(16)}`;
const bitsOf = (mask) => [...mask.toString(2)].reverse().flatMap((digit, index) => (digit === '1' ? [index] : []));

// Every whitespace run in the pre-normalized text is exactly one space in the normalized text. Keep
// the line structure for reading (one newline, or a paragraph break) and record where each
// normalized character lands, so a quote's offsets carry over to what the reader sees.
export function displayOf(source) {
  const isSpace = (ch) => /\s/.test(ch);
  let start = 0;
  let end = source.length;
  while (start < end && isSpace(source[start])) start++;
  while (end > start && isSpace(source[end - 1])) end--;
  let display = '';
  let text = '';
  const map = [];
  for (let i = start; i < end;) {
    map.push(display.length);
    if (!isSpace(source[i])) {
      display += source[i];
      text += source[i];
      i++;
      continue;
    }
    let newlines = 0;
    while (i < end && isSpace(source[i])) { if (source[i] === '\n') newlines++; i++; }
    display += newlines >= 2 ? '\n\n' : newlines === 1 ? '\n' : ' ';
    text += ' ';
  }
  map.push(display.length);
  return { display, text, map };
}

function occurrences(text, needle) {
  const found = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) found.push(index);
  return found;
}

// Where a "not compiled" marker sits: the heading or numbered paragraph the clause reference names.
export function anchorFor(clause, parts) {
  const lineStarting = (partIndex, matches) => {
    const part = parts[partIndex];
    if (!part) return null;
    let offset = 0;
    for (const line of part.display.split('\n')) {
      if (matches(line)) return { part: partIndex, offset };
      offset += line.length + 1;
    }
    return null;
  };
  const byName = (fragment) => parts.findIndex((part) => part.name.includes(fragment));
  const mla = clause.match(/^MLA (\d+)\)/);
  if (mla) return lineStarting(byName('wildcat-mla'), (line) => /^#+ /.test(line) && line.replace(/^#+ /, '').startsWith(`${mla[1]}) `));
  const policy = clause.match(/^Lender Check Policy (\d+\.\d+)/);
  if (policy) return lineStarting(byName('lender-check-policy'), (line) => line.startsWith(`${policy[1]} `));
  if (clause.startsWith('Exhibit A')) {
    for (let index = 0; index < parts.length; index++) {
      const hit = lineStarting(index, (line) => /^#*\s*EXHIBIT A\b/i.test(line));
      if (hit) return hit;
    }
  }
  if (clause.startsWith('Preamble')) return { part: 0, offset: 0 };
  return null;
}

// Label every 32-byte word of an encoded `tuple(uint8 effect,uint16 clauseId,uint256[] pos,uint256[] neg)[]`
// so the UI can point at the exact bytes a rule became.
export function annotateProgram(programHex, clauses) {
  const body = programHex.slice(2);
  const word = (offset) => BigInt(`0x${body.slice(offset * 2, offset * 2 + 64) || '0'}`);
  const cell = (offset, label) => ({ offset, label, hex: `0x${body.slice(offset * 2, offset * 2 + 64)}` });
  const count = Number(word(32));
  const header = [cell(0, 'offset of the rule array'), cell(32, `rule count = ${count}`)];
  const starts = [];
  for (let index = 0; index < count; index++) {
    header.push(cell(64 + 32 * index, `offset of rule ${index + 1}`));
    starts.push(64 + Number(word(64 + 32 * index)));
  }
  const rules = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : body.length / 2;
    const effect = Number(word(start));
    const clauseId = Number(word(start + 32));
    const words = [cell(start, `effect = ${effect} (${EFFECT_NAMES[effect]})`), cell(start + 32, `clauseId = ${clauseId}`),
      cell(start + 64, 'offset of pos[]'), cell(start + 96, 'offset of neg[]')];
    for (const [side, slot] of [['pos', 64], ['neg', 96]]) {
      const base = start + Number(word(start + slot));
      const length = Number(word(base));
      words.push(cell(base, `${side}.length = ${length}`));
      for (let term = 0; term < length; term++) words.push(cell(base + 32 + 32 * term, `${side}[${term}] (term ${term + 1})`));
    }
    const clause = clauses.find((entry) => entry.clauseId === clauseId);
    return { clauseId, ruleId: clause?.ruleId ?? null, effect: EFFECT_NAMES[effect], byteStart: start, byteEnd: end, words };
  });
  return { byteLength: body.length / 2, header, rules };
}

// The borrower's standing buyback, assembled from the addendum's terms exactly as the SwapVM test
// does. Token and maker addresses are fixed placeholders until a deployment exists, so the strategy
// hash here is illustrative; the policy hash inside the program is the real one.
function buybackOf(policy) {
  if (!existsSync(OPCODES)) return { available: false, reason: 'vendor/swap-vm is missing; run `npm run vendor` to decode the program.' };
  const opcodes = loadOpcodes(OPCODES);
  const policyGuardOpcode = opcodes.count;
  const fixedRateBalancesOpcode = opcodes.count + 1;
  const terms = buybackTermsFrom(policy);
  const placeholders = {
    maker: '0x00000000000000000000000000000000000b0770',
    positionToken: '0x000000000000000000000000000000000000d3a0',
    asset: '0x000000000000000000000000000000000000a55e',
  };
  const action = policy.actionOrder.indexOf('transfer');
  const inputs = {
    opcodes, policyGuardOpcode, fixedRateBalancesOpcode, policyHash: policy.hash, action,
    deadline: terms.deadlineTimestamp, positionToken: placeholders.positionToken, asset: placeholders.asset,
    capPosition: terms.capPosition, capAsset: terms.capAsset,
  };
  const instructions = [
    { name: 'Controls._deadline', opcode: opcodes['Controls._deadline'], bytes: encoders.deadline(opcodes, inputs.deadline),
      args: { deadline: String(inputs.deadline), date: terms.deadline }, source: 'buybackDeadline' },
    { name: 'PolicyGuard._policyGuard', opcode: policyGuardOpcode, bytes: encoders.policyGuard(policyGuardOpcode, policy.hash, action),
      args: { policyHash: policy.hash, action: `${action} (transfer)` }, source: 'policyHash' },
    { name: 'FixedRateBalances._fixedRateBalances', opcode: fixedRateBalancesOpcode,
      bytes: encoders.fixedRateBalances(fixedRateBalancesOpcode, placeholders.positionToken, terms.capPosition, placeholders.asset, terms.capAsset),
      args: { positionToken: placeholders.positionToken, capPosition: String(terms.capPosition), asset: placeholders.asset, capAsset: String(terms.capAsset) },
      source: 'buybackPrice · buybackCap' },
    { name: 'LimitSwap._limitSwap1D', opcode: opcodes['LimitSwap._limitSwap1D'], bytes: encoders.limitSwap(opcodes, placeholders.positionToken, placeholders.asset),
      args: { direction: BigInt(placeholders.positionToken) < BigInt(placeholders.asset) ? 'position → asset (1)' : 'asset → position (0)' }, source: 'template' },
    { name: 'Invalidators._invalidateTokenIn1D', opcode: opcodes['Invalidators._invalidateTokenIn1D'], bytes: encoders.invalidateTokenIn(opcodes),
      args: {}, source: 'buybackCap' },
  ];
  const program = buildBuybackProgram(inputs);
  if (`0x${instructions.map((entry) => entry.bytes.slice(2)).join('')}` !== program) throw new Error('Decoded buyback instructions do not reassemble the program');
  const order = buildAquaOrder(placeholders.maker, program);
  return {
    available: true,
    terms: { price: terms.price, cap: terms.cap, deadline: terms.deadline, deadlineTimestamp: terms.deadlineTimestamp,
      capPosition: String(terms.capPosition), capAsset: String(terms.capAsset) },
    placeholders,
    instructions,
    program,
    order: { maker: order.maker, traits: hex(order.traits), data: order.data },
    strategyHash: keccak256(encodeOrder(order)),
  };
}

export async function exportProfile(spec) {
  const document = await readDocuments(spec.documents.map(at));
  const envelope = spec.fixture(document);
  const config = JSON.parse(await readFile(at(spec.config), 'utf8'));
  const compiled = compilePolicy(envelope, config, document, { demo: true });
  const onchain = buildOnchainPolicy(envelope.ast);
  if (onchain.clauseTableHash !== compiled.policy.clauseTableHash) throw new Error('On-chain policy disagrees with the compiled policy');

  // Per-part display text, and each part's offset inside the bundled normalized text.
  const parts = [];
  let cursor = 0;
  for (const path of spec.documents) {
    const raw = await readFile(at(path), 'utf8');
    const source = /\.html?$/i.test(path) ? convert(raw, HTML_OPTIONS) : raw;
    const { display, text, map } = displayOf(source);
    const meta = document.parts?.find((part) => path.endsWith(part.name)) ?? document;
    if (document.text.slice(cursor, cursor + text.length) !== text) throw new Error(`Display text for ${path} does not normalize to the compiled text`);
    parts.push({ name: path.split('/').pop(), sha256: meta.sha256, textSha256: meta.textSha256, start: cursor, end: cursor + text.length, display, map });
    cursor += text.length + 1;
  }
  if (cursor - 1 !== document.text.length) throw new Error('Part offsets do not add up to the bundled text');

  const { ast } = envelope;
  const clauseOf = new Map(onchain.clauses.map((clause) => [clause.ruleId, clause.clauseId]));
  const locate = (quote) => occurrences(document.text, quote).map((start) => {
    const end = start + quote.length;
    const partIndex = parts.findIndex((part) => start >= part.start && end <= part.end);
    const part = parts[partIndex];
    return { start, end, part: partIndex, displayStart: part.map[start - part.start], displayEnd: part.map[end - part.start] };
  });

  const rules = ast.rules.map((rule) => {
    const clauseId = clauseOf.get(rule.id);
    const compiled = onchain.byAction[onchain.actions.indexOf(rule.action)].find((entry) => entry.clauseId === clauseId);
    return {
      ...rule, clauseId,
      dnf: compiled.terms.map((term) => ({ pos: bitsOf(term.pos), neg: bitsOf(term.neg), posMask: hex(term.pos), negMask: hex(term.neg) })),
      quotes: locate(rule.source.quote),
    };
  });
  const terms = ast.terms.map((term) => ({ ...term, quotes: locate(term.source.quote) }));
  const unresolved = ast.unresolved.map((entry) => ({ ...entry, anchor: anchorFor(entry.clause, parts) }));
  for (const item of [...rules, ...terms]) if (!item.quotes.length) throw new Error(`Quote not located: ${item.id ?? item.name}`);

  const programs = onchain.actions.map((action, index) => ({
    action, index, hex: onchain.programs[index], ...annotateProgram(onchain.programs[index], onchain.clauses),
  }));

  return {
    schemaVersion: 1,
    profile: spec.profile, act: spec.act, label: spec.label, venue: spec.venue,
    title: ast.title, parties: ast.parties,
    source: { name: document.name, sha256: document.sha256, textSha256: document.textSha256, parts: document.parts ?? null },
    policyHash: compiled.policy.hash,
    clauseTableHash: onchain.clauseTableHash,
    equivalenceChecks: compiled.equivalenceChecks,
    demo: compiled.policy.demo,
    config,
    extraction: envelope.extraction,
    factOrder: onchain.facts,
    actionOrder: onchain.actions,
    text: document.text,
    documents: parts.map(({ map, ...part }) => part),
    rules,
    terms,
    unresolved,
    clauseTable: onchain.clauses,
    programs,
    buyback: ast.terms.some((term) => term.name === 'buybackPrice') ? buybackOf(compiled.policy) : null,
  };
}

export async function exportAll(outDir = OUT) {
  await mkdir(outDir, { recursive: true });
  const profiles = [];
  for (const spec of PROFILES) {
    const exported = await exportProfile(spec);
    await writeFile(`${outDir}/${spec.profile}.json`, `${JSON.stringify(exported)}\n`);
    profiles.push({ profile: exported.profile, act: exported.act, label: exported.label, venue: exported.venue, title: exported.title, policyHash: exported.policyHash });
    console.log(`ui:export ${spec.profile.padEnd(15)} ${exported.rules.length} rules · ${exported.terms.length} terms · ${exported.unresolved.length} unresolved · ${exported.policyHash}`);
  }
  await writeFile(`${outDir}/index.json`, `${JSON.stringify({ profiles }, null, 2)}\n`);
  return profiles;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await exportAll();
