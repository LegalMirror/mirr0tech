import { legalAstSchema, sourceDocuments } from './ast.js';

// The model selects evidence IDs. Only the server copies text and counts occurrences.
// Passage boundaries preserve source characters; nothing is lowercased or fuzzy-matched.
export function sourcePassages(document, maxLength = 800) {
  const passages = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const doc of sourceDocuments(document)) {
    let start = 0, count = 0;
    const add = (end) => {
      const text = doc.text.slice(start, end).trim();
      if (text) {
        const offset = doc.text.indexOf(text, start);
        let occurrence = 0;
        for (let at = doc.text.indexOf(text); at < offset; at = doc.text.indexOf(text, at + 1)) occurrence++;
        passages.push({ id: `${doc.id}-passage-${++count}`,
          documentId: doc.id, text, occurrence });
      }
      start = end;
    };
    for (const { index, segment } of segmenter.segment(doc.text)) {
      if (index > start && index + segment.length - start > maxLength) add(index);
      while (index + segment.length - start > maxLength) {
        const space = doc.text.lastIndexOf(' ', start + maxLength);
        add(space > start ? space + 1 : start + maxLength);
      }
    }
    add(doc.text.length);
  }
  return passages;
}

export function passageAstSchema(passages) {
  const ids = Array.from({ length: 24 }, (_, i) => `node-${i + 1}`);
  const source = { type: 'object', properties: { spanId: passages.length <= 500
    ? { type: 'string', enum: passages.map((p) => p.id) }
    : { type: 'string', pattern: '^document-[0-9]+-passage-[0-9]+$' } }, required: ['spanId'], additionalProperties: false };
  const nodes = legalAstSchema.properties.nodes;
  const relations = legalAstSchema.properties.relations;
  const issues = legalAstSchema.properties.issues;
  return { ...legalAstSchema, properties: { ...legalAstSchema.properties,
    nodes: { ...nodes, maxItems: 24, items: { ...nodes.items, properties: { ...nodes.items.properties,
      id: { type: 'string', enum: ids }, parentId: { type: 'null' }, source } } },
    relations: { ...relations, maxItems: 12, items: { ...relations.items, properties: { ...relations.items.properties,
      from: { type: 'string', enum: ids }, to: { type: 'string', enum: ids }, source } } },
    // A light-analysis issue is bundle-level. Do not ask the model to link to omitted nodes.
    issues: { ...issues, maxItems: 8, items: { ...issues.items, properties: { ...issues.items.properties, nodeId: { type: 'null' } } } },
  } };
}

export function materializePassages(candidate, passages) {
  const byId = new Map(passages.map((passage) => [passage.id, passage]));
  const locate = (item) => {
    const passage = byId.get(item.source?.spanId);
    if (!passage) throw new Error(`Unknown source passage: ${item.source?.spanId}`);
    return { ...item, source: { documentId: passage.documentId, quote: passage.text, occurrence: passage.occurrence } };
  };
  return { ...candidate, nodes: candidate.nodes.map(locate), relations: candidate.relations.map(locate) };
}
