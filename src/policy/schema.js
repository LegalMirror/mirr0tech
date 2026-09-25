import Ajv from 'ajv';

export const FACTS = [
  'kycApproved', 'amlApproved', 'sanctionsClear', 'subscriptionAccepted',
  'issuerAuthorized', 'offeringCompliant', 'redemptionAuthorized',
  'depositConfirmed', 'depositAvailable', 'sufficientBalance',
];
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
      action: { type: 'string', enum: ['mint', 'burn', 'transfer'] },
      effect: { type: 'string', enum: ['permit', 'require', 'forbid'] },
      condition: { $ref: '#/$defs/expression' },
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
