// Maps the venue service's audit entries onto the dashboard's timeline events. Pure, so the live
// gateway and the static export (the Sepolia timeline shipped with the repo) render the same rows.
const KIND = { 'custodial-rwa': 'rwa', 'rwa-secondary': 'rwa', 'wildcat-credit': 'credit' };
const VENUE = { rwa: 'token / uniswap-v4', credit: 'wildcat / aqua' };
const KINDS = { 'worldid.verify': 'HumanVerified', attest: 'Attested', override: 'Attested', revoke: 'Revoked', 'rwa.mint': 'Minted', 'rwa.release': 'PolicyChecked', 'rwa.pool.create': 'PolicyChecked',
  'rwa.pool.addLiquidity': 'PolicyChecked', 'rwa.pool.swap': 'PolicyChecked', 'credit.deposit': 'CredentialDecision', 'credit.withdraw': 'CredentialDecision',
  'credit.buyback.ship': 'Shipped', 'credit.buyback.quote': 'PolicyChecked', 'credit.buyback.fill': 'Fill', 'credit.buyback.dock': 'Shipped' };

/// Timeline events for `profile`, newest first; `chainId` picks the explorer the tx hashes link to.
export function auditEvents(entries, profile, chainId) {
  const kind = KIND[profile];
  return entries.filter((entry) => !entry.policy || entry.policy === kind).map((entry) => {
    const refused = entry.status === 'refused';
    const quoteRefused = refused && entry.type === 'credit.buyback.quote';
    return {
      id: entry.id, at: entry.at,
      kind: refused ? (quoteRefused ? 'QuoteRefused' : 'Refused') : (entry.type === 'sanction' ? (entry.sanctioned ? 'Revoked' : 'Attested') : KINDS[entry.type] ?? 'PolicyChecked'),
      subject: entry.wallet ?? entry.refusal?.subject ?? 'Operator', action: ACTION[entry.type] ?? entry.type,
      summary: refused ? `${entry.refusal?.name ?? 'refused'}${entry.refusal?.clause ? ` — ${entry.refusal.clause.clause}: “${entry.refusal.clause.quote}”` : ''}` : summaryOf(entry),
      facts: entry.facts ?? {}, txHash: entry.txHash ?? null, venue: VENUE[entry.policy ?? kind] ?? 'attestor',
      // What the chain decided; the browser shows this instead of replaying partial facts.
      outcome: refused ? 'refused' : 'ok', clauseId: entry.refusal?.clause?.clauseId ?? entry.refusal?.clauseId ?? null,
      explorer: entry.txHash && EXPLORER[chainId] ? `${EXPLORER[chainId]}/tx/${entry.txHash}` : null,
    };
  }).reverse();
}

const EXPLORER = { 11155111: 'https://sepolia.etherscan.io' };
// The policy action each venue call is decided under; facts-only entries have none.
const ACTION = {
  'rwa.mint': 'mint', 'rwa.release': 'transfer', 'rwa.pool.create': 'transfer', 'rwa.pool.addLiquidity': 'transfer', 'rwa.pool.swap': 'transfer',
  'credit.deposit': 'deposit', 'credit.withdraw': 'withdraw', 'credit.buyback.ship': 'transfer', 'credit.buyback.quote': 'transfer', 'credit.buyback.fill': 'transfer', 'credit.buyback.dock': 'transfer',
};

function summaryOf(entry) {
  switch (entry.type) {
    case 'attest': return `attested ${Object.keys(entry.facts ?? {}).join(', ')}`;
    case 'worldid.verify': return `proof of human verified (World ID, nullifier ${entry.nullifier})`;
    case 'revoke': return `revoked ${(entry.facts ?? []).join(', ')}`;
    case 'override': return 'borrower override under MLA 13(c)(y)';
    case 'sanction': return entry.sanctioned ? 'designated by the sanctions oracle' : 'designation lifted';
    case 'rwa.mint': return `minted ${entry.amount} to custody`;
    case 'rwa.release': return `released ${entry.amount}`;
    case 'rwa.pool.create': return `created a ${entry.hooked ? 'hooked' : 'hookless'} pool`;
    case 'rwa.pool.addLiquidity': return `added liquidity to the ${entry.hooked ? 'hooked' : 'hookless'} pool`;
    case 'rwa.pool.swap': return `swapped in the ${entry.hooked ? 'hooked' : 'hookless'} pool`;
    case 'credit.deposit': return `deposited ${entry.amount}`;
    case 'credit.withdraw': return `withdrew ${entry.amount}`;
    case 'credit.buyback.ship': return `shipped buyback ${entry.strategyHash?.slice(0, 10)}…`;
    case 'credit.buyback.quote': return `quoted ${entry.amount} → ${entry.result?.amountOut} at ${entry.result?.price}`;
    case 'credit.buyback.fill': return `filled ${entry.amount}`;
    case 'credit.buyback.dock': return 'docked the buyback';
    default: return entry.type;
  }
}
