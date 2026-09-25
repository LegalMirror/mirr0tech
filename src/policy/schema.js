import Ajv from 'ajv';

// Bit index is the position in this array. The order is committed inside the policy hash,
// so a reordering produces a different policy and a different deployment.
export const FACTS = [
  'kycApproved', 'amlApproved', 'sanctionsClear', 'subscriptionAccepted',
  'issuerAuthorized', 'offeringCompliant', 'redemptionAuthorized',
  'depositConfirmed', 'depositAvailable', 'sufficientBalance',
  // Private-credit facts, grounded in the Wildcat template MLA and the borrower's Lender Check
  // Policy. `sanctionsClear` above is shared: it is read from the sanctions oracle, never attested.
  'mlaCountersigned', 'lenderCheckPassed', 'amlKycProvided', 'notInsolvent',
  'screeningCurrent', 'openTermState', 'borrowerOverride',
];

// Bit index is the position in this array; it is committed inside the policy hash. A fill on a
// venue is a `transfer`; the agreements have no concept of a swap or a liquidity position.
export const ACTIONS = ['mint', 'burn', 'transfer', 'deposit', 'withdraw'];
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const array = (items) => ({ type: 'array', items });

// This JSON Schema is also sent to the model as a strict Structured Output schema.
export const astSchema = {
  ...object({
    schemaVersion: { type: 'string', enum: ['1.0'] },
    title: string,
    parties: array(object({ name: string, role: string })),
    rules: array(object({
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
      action: { type: 'string', enum: ACTIONS },
      effect: { type: 'string', enum: ['permit', 'require', 'forbid'] },
      condition: { $ref: '#/$defs/expression' },
      source: object({ clause: string, quote: string }),
      rationale: string,
    })),
    // Numeric or dated terms with a verbatim quote; consumed by templates, never by the evaluator.
    terms: array(object({
      name: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,63}$' },
      value: { type: 'string', pattern: '^(-?[0-9]+(\\.[0-9]+)?|[0-9]{4}-[0-9]{2}-[0-9]{2})$' },
      unit: string,
      source: object({ clause: string, quote: string }),
      rationale: string,
    })),
    unresolved: array(object({ clause: string, description: string })),
  }),
  $defs: {
    expression: {
      anyOf: [
        object({ type: { type: 'string', enum: ['fact'] }, name: { type: 'string', enum: FACTS } }),
        object({ type: { type: 'string', enum: ['all', 'any'] }, children: { ...array({ $ref: '#/$defs/expression' }), minItems: 1 } }),
        object({ type: { type: 'string', enum: ['not'] }, child: { $ref: '#/$defs/expression' } }),
      ],
    },
  },
};

const validate = new Ajv({ allErrors: true }).compile(astSchema);
export function validateAst(ast, sourceText) {
  if (!validate(ast)) throw new Error(`Invalid policy AST: ${JSON.stringify(validate.errors)}`);
  const ids = new Set();
  function depth(node, level = 0) {
    if (level > 16) throw new Error('Policy expression exceeds maximum depth');
    if (node.children) node.children.forEach((child) => depth(child, level + 1));
    if (node.child) depth(node.child, level + 1);
  }
  if (ast.rules.length > 200) throw new Error('Too many policy rules');
  const termNames = new Set();
  for (const term of ast.terms) {
    if (termNames.has(term.name)) throw new Error(`Duplicate term name: ${term.name}`);
    termNames.add(term.name);
    if (sourceText !== undefined && !sourceText.includes(term.source.quote)) {
      throw new Error(`Source quote not found for term ${term.name}`);
    }
  }
  for (const rule of ast.rules) {
    if (ids.has(rule.id)) throw new Error(`Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    depth(rule.condition);
    if (sourceText !== undefined && !sourceText.includes(rule.source.quote)) {
      throw new Error(`Source quote not found for ${rule.id}`);
    }
  }
  return ast;
}
