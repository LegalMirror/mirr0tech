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
import { auditEvents } from '../src/audit-events.js';
import { buildAquaOrder, buildBuybackProgram, buildDutchBuybackProgram, buybackTermsFrom, encodeOrder, encoders, loadOpcodes } from '../src/policy/programs.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (path) => `${root}${path}`;
const OUT = at('dashboard/public/data');
const OPCODES = at('vendor/swap-vm/src/opcodes/LimitOpcodes.sol');

export const PROFILES = [
  {
    profile: 'custodial-rwa', act: 1, label: 'Tokenize', venue: 'Permissioned fund token (custodial mint and burn)',
    documents: ['test/human_contracts/ea026411904ex10-9.htm'], config: 'examples/demo-config.json', fixture: sampleFixture,
  },
  {
    profile: 'rwa-secondary', act: 1, label: 'Trade on Uniswap', venue: 'Fund token + Uniswap v4 policy hook',
    documents: ['test/human_contracts/ea026411904ex10-9.htm'], config: 'examples/rwa-secondary-config.json',
    fixture: (document) => sampleFixture(document, { secondary: true }),
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
  // The same addendum as a tender offer (A1.5): the bid opens at the floor and improves to the ceiling.
  let auction = null;
  if (terms.ceiling && terms.windowSeconds) {
    const startTime = 0; // set when the borrower ships
    const decayFactor = BigInt(Math.round(Math.pow(Number(terms.price) / Number(terms.ceiling), 1 / terms.windowSeconds) * 1e18));
    const auctionInstructions = [
      instructions[0], instructions[1], instructions[2],
      { name: 'DutchAuction._dutchAuctionBalanceOut1D', opcode: opcodes['DutchAuction._dutchAuctionBalanceOut1D'],
        bytes: encoders.dutchAuctionBalanceOut(opcodes, startTime, terms.windowSeconds, decayFactor),
        args: { floor: terms.price, ceiling: terms.ceiling, windowHours: String(terms.windowHours), decayFactor: String(decayFactor), startTime: 'set when shipped' },
        source: 'buybackCeiling · buybackWindowHours' },
      instructions[3], instructions[4],
    ];
    const auctionProgram = buildDutchBuybackProgram({ ...inputs, capAssetFloor: terms.capAsset, floor: terms.price, ceiling: terms.ceiling, startTime, windowSeconds: terms.windowSeconds });
    if (`0x${auctionInstructions.map((entry) => entry.bytes.slice(2)).join('')}` !== auctionProgram) throw new Error('Decoded auction instructions do not reassemble the program');
    auction = { ceiling: terms.ceiling, windowHours: String(terms.windowHours), capAssetCeiling: String(terms.capAssetCeiling), instructions: auctionInstructions, program: auctionProgram };
  }
  return {
    available: true,
    auction,
    terms: { price: terms.price, cap: terms.cap, deadline: terms.deadline, deadlineTimestamp: terms.deadlineTimestamp,
      capPosition: String(terms.capPosition), capAsset: String(terms.capAsset) },
    placeholders,
    instructions,
    program,
    order: { maker: order.maker, traits: hex(order.traits), data: order.data },
    strategyHash: keccak256(encodeOrder(order)),
  };
}

// ── Paragraph coverage ─────────────────────────────────────────────────────────────────────────────
// Every paragraph of every document is labelled with its clause path and classified: compiled (a rule
// or term quotes it), unresolved (the compiler flagged it), or not executable (nothing quotes it).

const DOC_PREFIX = [['MLA', 'wildcat-mla'], ['Lender Check Policy', 'lender-check-policy'], ['Addendum', 'buyback-addendum']];
const prefixOf = (name) => DOC_PREFIX.find(([, fragment]) => name.includes(fragment))?.[0] ?? '';

// A line that opens its own paragraph even without a blank line before it.
const OPENS_CLAUSE = /^(#+\s|[-*+]\s|\(?[a-z]\)\s|[A-Z]?\d+(?:\.\d+)*(?:[.)]|\s))/;

/** Blank-line separated blocks, further split before every clause label. Offsets are into `display`. */
export function paragraphsOf(display) {
  const out = [];
  let current = null;
  let offset = 0;
  for (const line of display.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (!line.trim()) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (current && OPENS_CLAUSE.test(line)) {
      out.push(current);
      current = null;
    }
    if (current) current.end = end;
    else current = { start, end };
  }
  if (current) out.push(current);
  return out;
}

const isCapsHeading = (line) => line.length <= 100 && /[A-Z]{3}/.test(line) && !/[a-z]/.test(line);
const BOILERPLATE = [/^\d{1,3}$/, /^Exhibit [A-Z] - \d+$/i, /^[\s*_#-]+$/];

/**
 * Walks a document's paragraphs keeping a clause path: `13) e) 1.` in the MLA, `2.1.1` in the
 * converted HTML, `A1.1` in the addendum. Paths are what an unresolved clause reference is matched on.
 */
export function labelParagraphs(display, { markdown, prefix }) {
  let exhibit = null;
  let clause = { path: [], label: '' };
  let preamble = true;
  let definitions = false;
  // Markdown lists nest without indentation once collapsed: a "1." after an item opens a sub-list,
  // and a number that continues an outer level closes the inner ones.
  let list = [];
  let previousWasItem = false;
  return paragraphsOf(display).map(({ start, end }) => {
    const text = display.slice(start, end);
    const first = text.split('\n')[0].trim();
    const md = markdown ? /^(#+)\s+(.*)$/.exec(first) : null;
    const heading = Boolean(md) || (!markdown && isCapsHeading(first));
    const body = (md ? md[2] : first).replace(/^\*\*/, '');
    const boilerplate = BOILERPLATE.some((pattern) => pattern.test(first));
    let own = null;
    let listItem = false;
    let m;
    if (boilerplate) {
      // Page numbers and rules carry no clause of their own.
    } else if ((m = /^EXHIBIT\s+([A-Z])\b/i.exec(body)) && (heading || body.length < 80)) {
      exhibit = `Exhibit ${m[1].toUpperCase()}`;
      clause = { path: [], label: '' };
      preamble = false;
      definitions = false;
    } else if ((m = /^([A-Z]?\d+(?:\.\d+)+)\.?(?=\s|\S)/.exec(body))) {
      own = { path: m[1].split('.'), label: m[1] };
    } else if ((m = /^([A-Z]?\d+)\)\s/.exec(body))) {
      own = { path: [m[1]], label: `${m[1]})` };
    } else if ((m = /^\(?([a-z])\)\s/.exec(body))) {
      const section = clause.path.slice(0, 1);
      const sectionLabel = clause.label.split(' ')[0];
      own = { path: [...section, m[1]], label: `${sectionLabel} ${m[1]})`.trim() };
    } else if ((m = /^(\d+)\.(\S)/.exec(body))) {
      own = { path: [m[1]], label: m[1] };
    } else if ((m = /^(\d+)\.\s/.exec(body))) {
      if (md) own = { path: [m[1]], label: m[1] };
      else {
        const n = Number(m[1]);
        if (n === 1) list = previousWasItem ? [...list, 1] : [1];
        else {
          while (list.length && list.at(-1) + 1 !== n) list.pop();
          list = list.length ? [...list.slice(0, -1), n] : [n];
        }
        listItem = true;
        own = {
          path: [...clause.path, ...list.map(String)],
          label: `${clause.label} ${list.map((item) => `${item}.`).join(' ')}`.trim(),
        };
      }
    } else if (md && md[1].length <= 3 && !exhibit && !preamble) {
      clause = { path: [], label: '' };
    }
    if (/^(DEFINITIONS\b|TERMS AND CONDITIONS\b)/i.test(body) || /^\d+\)\s+Definitions\b/i.test(body)) preamble = false;
    if (own) {
      preamble = false;
      if (!listItem) clause = own;
    }
    if (!listItem && !boilerplate && (own || heading)) list = [];
    if (!boilerplate) previousWasItem = listItem;
    if (/^(\d+\)\s+)?DEFINITIONS\b/i.test(body)) definitions = true;
    else if ((own && !listItem) || (md && !/definitions/i.test(body))) definitions = false;

    const path = preamble ? ['Preamble'] : [...(exhibit ? [exhibit] : []), ...(own ?? clause).path];
    const local = preamble ? 'Preamble' : definitions && !(own ?? clause).label ? 'Definitions' : (own ?? clause).label;
    const label = [prefix, exhibit && !preamble ? exhibit : null, local].filter(Boolean).join(' ');
    const kind = boilerplate ? 'boilerplate' : heading ? 'heading' : definitions ? 'definition' : own ? 'clause' : 'text';
    return { start, end, path: definitions && !own && !clause.path.length ? ['Definitions'] : path, label, kind };
  });
}

/** "MLA 13) c), e)" → [{doc, path: ['13','c']}, {doc, path: ['13','e']}]; ranges like 2.1–2.2 expand. */
export function parseClauseRef(clause) {
  const refs = [];
  for (let piece of clause.split(';')) {
    piece = piece.trim();
    let doc = null;
    for (const [prefix, fragment] of DOC_PREFIX) {
      if (piece.startsWith(`${prefix} `)) {
        doc = fragment;
        piece = piece.slice(prefix.length + 1);
      }
    }
    if (/^Preamble\b/i.test(piece)) { refs.push({ doc, path: ['Preamble'] }); continue; }
    const exhibit = /^Exhibit ([A-Z])\b/.exec(piece);
    if (exhibit) { refs.push({ doc, path: [`Exhibit ${exhibit[1]}`] }); continue; }
    let previous = null;
    for (const entry of piece.split(',').map((value) => value.trim()).filter(Boolean)) {
      const range = /^([A-Z]?\d+(?:\.\d+)*)\s*[–-]\s*([A-Z]?\d+(?:\.\d+)*)$/.exec(entry);
      if (range) {
        const from = range[1].split('.');
        const to = range[2].split('.');
        const head = from.slice(0, -1);
        if (from.length === to.length && head.join('.') === to.slice(0, -1).join('.')) {
          for (let n = Number(from.at(-1)); n <= Number(to.at(-1)); n++) refs.push({ doc, path: [...head, String(n)] });
        }
        continue;
      }
      const tokens = /^[A-Z]?\d+(?:\.\d+)+$/.test(entry) ? entry.split('.') : entry.match(/[A-Za-z0-9]+(?=\))/g);
      if (!tokens) continue;
      const path = previous && tokens.length < previous.length ? [...previous.slice(0, previous.length - tokens.length), ...tokens] : tokens;
      previous = path;
      refs.push({ doc, path });
    }
  }
  return refs;
}

const startsWithPath = (path, prefix) => prefix.length <= path.length && prefix.every((token, index) => path[index] === token);

export function coverageOf({ parts, rules, terms, unresolved, enforcedBy }) {
  const refs = unresolved.map((entry) => parseClauseRef(entry.clause));
  const labelled = parts.map((part) => labelParagraphs(part.display, { markdown: part.name.endsWith('.md'), prefix: prefixOf(part.name) }));
  const matches = (index, part, paragraph) =>
    refs[index].some((ref) => (ref.doc === null || part.name.includes(ref.doc)) && startsWithPath(paragraph.path, ref.path));
  // An unresolved entry's marker sits on the first paragraph its clause reference names, falling back
  // to the heading heuristic when the reference names no clause ("Agreement generally").
  const anchors = unresolved.map((entry, index) => {
    for (const [partIndex, paragraphs] of labelled.entries()) {
      const hit = paragraphs.find((paragraph) => matches(index, parts[partIndex], paragraph));
      if (hit) return { part: partIndex, offset: hit.start };
    }
    return entry.anchor;
  });
  const paragraphs = parts.flatMap((part, partIndex) =>
    labelled[partIndex].map((paragraph) => {
      const inside = (quote) => quote.part === partIndex && quote.displayStart < paragraph.end && quote.displayEnd > paragraph.start;
      const ruleIds = rules.filter((rule) => rule.quotes.some(inside)).map((rule) => rule.id);
      const termNames = terms.filter((term) => term.quotes.some(inside)).map((term) => term.name);
      const flagged = unresolved.flatMap((entry, index) => {
        const anchor = anchors[index];
        const anchored = anchor?.part === partIndex && anchor.offset >= paragraph.start && anchor.offset <= paragraph.end;
        return anchored || matches(index, part, paragraph) ? [index] : [];
      });
      const components = [...new Set([...ruleIds.flatMap((id) => enforcedBy.rules[id] ?? []), ...termNames.flatMap((name) => enforcedBy.terms[name] ?? [])])];
      const status = ruleIds.length || termNames.length ? 'compiled' : flagged.length ? 'unresolved' : 'not-executable';
      return {
        part: partIndex, displayStart: paragraph.start, displayEnd: paragraph.end, label: paragraph.label, kind: paragraph.kind,
        status, rules: ruleIds, terms: termNames, unresolved: flagged, components,
      };
    }));
  // Headings and page furniture are shown with a status but not counted as paragraphs of the agreement.
  const counted = paragraphs.filter((paragraph) => paragraph.kind !== 'heading' && paragraph.kind !== 'boilerplate');
  const count = (status) => counted.filter((paragraph) => paragraph.status === status).length;
  return {
    anchors,
    paragraphs,
    total: counted.length,
    counts: { compiled: count('compiled'), unresolved: count('unresolved'), 'not-executable': count('not-executable') },
    rules: new Set(paragraphs.flatMap((paragraph) => paragraph.rules)).size,
    terms: new Set(paragraphs.flatMap((paragraph) => paragraph.terms)).size,
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

  const enforcedBy = compiled.policy.coverage ?? { rules: {}, terms: {} };
  const { anchors, ...coverage } = coverageOf({ parts, rules, terms, unresolved, enforcedBy });
  unresolved.forEach((entry, index) => { entry.anchor = anchors[index]; });

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
    components: (compiled.components ?? []).map(({ id, version, kind, venue, description, rules: ruleIds, terms: termNames }) =>
      ({ id, version, kind, venue, description, rules: ruleIds, terms: termNames })),
    enforcedBy,
    coverage,
  };
}

export async function exportAll(outDir = OUT) {
  await mkdir(outDir, { recursive: true });
  const profiles = [];
  for (const spec of PROFILES) {
    const exported = await exportProfile(spec);
    await writeFile(`${outDir}/${spec.profile}.json`, `${JSON.stringify(exported)}\n`);
    const { paragraphs: _paragraphs, ...coverage } = exported.coverage;
    profiles.push({ profile: exported.profile, act: exported.act, label: exported.label, venue: exported.venue, title: exported.title, policyHash: exported.policyHash, coverage });
    const { counts, total } = exported.coverage;
    console.log(`ui:export ${spec.profile.padEnd(15)} ${exported.rules.length} rules · ${exported.terms.length} terms · ${exported.unresolved.length} unresolved · paragraphs ${counts.compiled}/${counts.unresolved}/${counts['not-executable']} of ${total} · ${exported.policyHash}`);
  }
  await writeFile(`${outDir}/index.json`, `${JSON.stringify({ profiles }, null, 2)}\n`);
  if (existsSync(at('deployments/sepolia.json'))) await writeFile(`${outDir}/deployment.json`, await readFile(at('deployments/sepolia.json'), 'utf8'));
  if (existsSync(at('deployments/sepolia-parties.json'))) {
    const parties = JSON.parse(await readFile(at('deployments/sepolia-parties.json'), 'utf8'));
    for (const spec of PROFILES) if (parties[spec.profile]) await writeFile(`${outDir}/parties-${spec.profile}.json`, `${JSON.stringify(parties[spec.profile])}\n`);
  }
  if (existsSync(at('deployments/sepolia-audit.json'))) {
    const entries = JSON.parse(await readFile(at('deployments/sepolia-audit.json'), 'utf8'));
    for (const spec of PROFILES) await writeFile(`${outDir}/audit-${spec.profile}.json`, `${JSON.stringify(auditEvents(entries, spec.profile, 11155111))}\n`);
  }
  return profiles;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await exportAll();
