// Models quote with real punctuation; decoded sources may hold straight quotes, other dashes or U+FFFD.
const QUOTE = /['"`‘’‚‛“”„´′″�]/;
const DASH = /[-‐‑‒–—―−]/;

/// The text folded for matching, with each folded character's index in the original.
function fold(text) {
  let folded = '';
  const at = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      if (folded.endsWith(' ')) continue;
      folded += ' ';
    } else folded += QUOTE.test(char) ? "'" : DASH.test(char) ? '-' : char;
    at.push(index);
  }
  return { folded, at };
}

/// The verbatim source span a quote stands for, or null when the source does not contain it.
export function verbatim(quote, source, folded = fold(source)) {
  if (source.includes(quote)) return quote;
  const needle = fold(quote.trim()).folded.trim();
  const start = needle ? folded.folded.indexOf(needle) : -1;
  if (start < 0) return null;
  return source.slice(folded.at[start], folded.at[start + needle.length - 1] + 1);
}

/// Returns { ast, unanchored }: every quote replaced by its verbatim span; a quote with none moves to unresolved.
export function anchorQuotes(ast, source) {
  const folded = fold(source);
  const unanchored = [];
  const anchor = (kind, key) => (item) => {
    const quote = verbatim(item.source.quote, source, folded);
    if (quote === null) unanchored.push({ kind, [key]: item[key], clause: item.source.clause });
    return quote === null ? [] : [{ ...item, source: { ...item.source, quote } }];
  };
  const rules = ast.rules.flatMap(anchor('rule', 'id'));
  const terms = ast.terms.flatMap(anchor('term', 'name'));
  const unresolved = [...ast.unresolved, ...unanchored.map((entry) => ({
    clause: entry.clause,
    description: `The quote for ${entry.kind} ${entry.id ?? entry.name} was not found in the source, so it is not enforced.`,
  }))];
  return { ast: { ...ast, rules, terms, unresolved }, unanchored };
}
