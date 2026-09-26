import Ajv from 'ajv';

const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,79}$' };
const array = (items, maxItems = 1500) => ({ type: 'array', items, maxItems });
const source = object({ documentId: id, quote: string, occurrence: { type: 'integer', minimum: 0 } });
export const NODE_KINDS = ['section', 'clause', 'definition', 'obligation', 'permission', 'prohibition', 'condition', 'exception', 'party', 'remedy', 'date', 'amount'];
export const RELATION_KINDS = ['references', 'defines', 'applies_to', 'requires', 'excepts', 'overrides', 'amends', 'party_to'];
export const legalAstSchema = object({
  schemaVersion: { type: 'string', enum: ['2.0'] },
  title: string,
  nodes: { ...array(object({ id, kind: { type: 'string', enum: NODE_KINDS }, label: string, summary: string,
    parentId: { anyOf: [id, { type: 'null' }] }, source })), minItems: 1 },
  relations: array(object({ id, from: id, to: id, kind: { type: 'string', enum: RELATION_KINDS }, source }), 3000),
  issues: array(object({ nodeId: { anyOf: [id, { type: 'null' }] }, description: string })),
});
const validate = new Ajv({ allErrors: true }).compile(legalAstSchema);

export const isLegalAst = (ast) => ast?.schemaVersion === '2.0';
export function sourceDocuments(document) {
  return document.sourceDocuments ?? [{ id: 'document-1', name: document.name, sha256: document.sha256, textSha256: document.textSha256, text: document.text }];
}

// The model provides exact quotations, never trusted character offsets. Repeated quotes are
// explicitly disambiguated by their zero-based occurrence within one source document.
export function validateLegalAst(ast, document) {
  if (!validate(ast)) throw new Error(`Invalid legal AST: ${JSON.stringify(validate.errors)}`);
  const documents = sourceDocuments(document);
  const docs = new Map(documents.map((doc) => [doc.id, doc]));
  const nodes = new Map();
  for (const node of ast.nodes) {
    if (nodes.has(node.id) || docs.has(node.id) || node.id === 'agreement') throw new Error(`Duplicate or reserved node id: ${node.id}`);
    nodes.set(node.id, node);
  }
  const locate = (citation) => {
    const doc = docs.get(citation.documentId);
    if (!doc) throw new Error(`Unknown source document: ${citation.documentId}`);
    let start = -1;
    // Bound work even when an untrusted model supplies a very large occurrence.
    if (citation.occurrence > doc.text.length) throw new Error('Invalid quote occurrence');
    for (let i = 0; i <= citation.occurrence; i++) {
      start = doc.text.indexOf(citation.quote, start + 1);
      if (start < 0) throw new Error(`Source quote not found in ${doc.name}`);
    }
    return { ...citation, start, end: start + citation.quote.length };
  };
  const located = ast.nodes.map((node) => {
    const seen = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error(`Cyclic hierarchy at ${node.id}`);
      seen.add(parentId);
      const parent = nodes.get(parentId);
      if (!parent) throw new Error(`Unknown parent: ${parentId}`);
      if (parent.source.documentId !== node.source.documentId) throw new Error('A parent must belong to the same document');
      if (!['section', 'clause', 'definition', 'obligation', 'permission', 'prohibition', 'condition', 'exception', 'remedy'].includes(parent.kind)) throw new Error('Invalid structural parent');
      parentId = parent.parentId;
    }
    return { ...node, source: locate(node.source) };
  });
  const relationIds = new Set();
  const links = new Set();
  const relations = ast.relations.map((relation) => {
    if (relationIds.has(relation.id)) throw new Error(`Duplicate relation id: ${relation.id}`);
    relationIds.add(relation.id);
    if (!nodes.has(relation.from) || !nodes.has(relation.to)) throw new Error('Dangling clause relationship');
    if (relation.from === relation.to) throw new Error('A clause relationship cannot link to itself');
    const key = `${relation.from}/${relation.kind}/${relation.to}`;
    if (links.has(key)) throw new Error('Duplicate clause relationship');
    links.add(key);
    return { ...relation, source: locate(relation.source) };
  });
  for (const issue of ast.issues) if (issue.nodeId !== null && !nodes.has(issue.nodeId)) throw new Error('Unknown issue node');
  return { ...ast, documents, nodes: located, relations };
}

export function legalAstGraph(ast) {
  return {
    nodes: [
      { id: 'agreement', kind: 'agreement', label: ast.title },
      ...ast.documents.map((doc) => ({ id: doc.id, kind: 'document', label: doc.name })),
      ...ast.nodes.map((node) => ({ ...node, description: node.summary })),
    ],
    edges: [
      ...ast.documents.map((doc) => ({ from: 'agreement', to: doc.id, kind: 'contains' })),
      ...ast.nodes.map((node) => ({ from: node.parentId ?? node.source.documentId, to: node.id, kind: 'contains' })),
      ...ast.relations,
    ],
  };
}
