import { documentFrom } from '../src/policy/document.js';
export const legalDocument = documentFrom('services.txt', '1. Payment. The Client must pay USD 100 within 30 days. 2. Exception. Section 1 does not apply during a dispute.');
export const legalAst = {
  schemaVersion: '2.0', title: 'Services agreement',
  nodes: [
    { id: 'clause-1', kind: 'clause', label: '1. Payment', summary: 'The Client must pay USD 100 within 30 days.', parentId: null, source: { documentId: 'document-1', quote: '1. Payment. The Client must pay USD 100 within 30 days.', occurrence: 0 } },
    { id: 'payment-duty', kind: 'obligation', label: 'Payment obligation', summary: 'Pay USD 100 within 30 days.', parentId: 'clause-1', source: { documentId: 'document-1', quote: 'The Client must pay USD 100 within 30 days.', occurrence: 0 } },
    { id: 'clause-2', kind: 'exception', label: '2. Dispute exception', summary: 'Payment does not apply during a dispute.', parentId: null, source: { documentId: 'document-1', quote: 'Section 1 does not apply during a dispute.', occurrence: 0 } },
  ],
  relations: [{ id: 'dispute-exception', from: 'clause-2', to: 'clause-1', kind: 'excepts', source: { documentId: 'document-1', quote: 'Section 1 does not apply during a dispute.', occurrence: 0 } }],
  issues: [],
};

// The Responses API returns passage references; exact quotations are assembled server-side.
export const modelLegalAst = {
  ...legalAst,
  nodes: legalAst.nodes.map((node, index) => ({ ...node, id: `node-${index + 1}`,
    parentId: node.parentId ? `node-${legalAst.nodes.findIndex((parent) => parent.id === node.parentId) + 1}` : null,
    source: { spanId: 'document-1-passage-1' } })),
  relations: legalAst.relations.map((relation) => ({ ...relation,
    from: `node-${legalAst.nodes.findIndex((node) => node.id === relation.from) + 1}`,
    to: `node-${legalAst.nodes.findIndex((node) => node.id === relation.to) + 1}`,
    source: { spanId: 'document-1-passage-1' } })),
};
