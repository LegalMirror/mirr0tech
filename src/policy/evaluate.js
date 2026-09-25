// Deliberately self-contained: the compiler emits this trusted interpreter as JS.
// Unknown facts propagate through NOT as unknown, so missing evidence never grants access.
export function evaluatePolicy(ast, action, facts) {
  function evaluate(node) {
    if (node.type === 'fact') return typeof facts[node.name] === 'boolean' ? facts[node.name] : null;
    if (node.type === 'not') { const value = evaluate(node.child); return value === null ? null : !value; }
    const values = node.children.map(evaluate);
    if (node.type === 'all') return values.includes(false) ? false : values.includes(null) ? null : true;
    if (node.type === 'any') return values.includes(true) ? true : values.includes(null) ? null : false;
    return null;
  }
  const rules = ast.rules.filter((rule) => rule.action === action);
  const trace = rules.map((rule) => ({
    id: rule.id, effect: rule.effect, result: evaluate(rule.condition),
    source: rule.source, rationale: rule.rationale,
  }));
  const failures = trace.filter((rule) =>
    (rule.effect === 'require' && rule.result !== true) ||
    (rule.effect === 'forbid' && rule.result !== false));
  const permitted = trace.some((rule) => rule.effect === 'permit' && rule.result === true);
  return {
    allowed: permitted && failures.length === 0,
    reasons: [...(permitted ? [] : ['NO_MATCHING_PERMISSION']), ...failures.map((rule) => rule.id)],
    trace,
  };
}
