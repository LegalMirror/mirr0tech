// Public discovery, limited demo capabilities and wallet/World investor capabilities are distinct.
export function addInvestorApi(document) {
  document.tags.push({ name: 'Public demo', description: 'Anonymous, isolated, quota-limited testnet contract workspaces' },
    { name: 'Investor', description: 'Wallet ownership + World credential login; wallet-signed bounded swaps' });
  Object.assign(document.components.securitySchemes, {
    demo: { type: 'http', scheme: 'bearer', description: 'Automatic demo_ workspace capability; own agreement lifecycle only' },
    investor: { type: 'http', scheme: 'bearer', description: 'Short-lived ia_ session issued after wallet signature and World verification; never operator authority' },
  });
  const field = { type: 'string' };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const response = { description: 'JSON result', content: { 'application/json': { schema: { type: 'object' } } } };
  const error = { description: 'Refused; structured error code and safe reason' };
  const operation = (tag, summary, security, body, status = '200') => ({ tags: [tag], summary, security,
    ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
    responses: { [status]: response, 400: error, 401: error, 403: error, 409: error, 429: error, 503: error } });
  document.paths['/v1/demo/config'] = { get: operation('Public demo', 'Read public demo availability and limits', []) };
  document.paths['/v1/demo/session'] = { post: operation('Public demo', 'Create an isolated anonymous workspace', [], null, '201') };
  document.paths['/v1/demo/logout'] = { post: operation('Public demo', 'Revoke this workspace capability', [{ demo: [] }]) };
  for (const [path, methods] of Object.entries(document.paths)) {
    if (path === '/v1/status' || /^\/v1\/agreements(?:\/\{id\}(?:\/(?:ast|constraints|regenerate|deploy))?)?$/.test(path)) {
      for (const operation of Object.values(methods)) operation.security = [{ bearer: [] }, { demo: [] }];
    }
  }
  const publicRoute = (path, method, summary, body) => {
    document.paths[`/v1/investor${path}`] = { [method]: operation('Investor', summary, [], body) };
  };
  publicRoute('/config', 'get', 'Read investor chain and World environment');
  publicRoute('/funds', 'get', 'List explicitly published funds, never private uploads');
  document.paths['/v1/investor/funds'].get.responses[200] = { ...response, content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } };
  publicRoute('/auth/challenge', 'post', 'Issue a wallet/fund/origin-bound World sign-in challenge', object({ wallet: field, fundId: field }));
  publicRoute('/auth/verify', 'post', 'Verify the wallet signature and Passport proof and issue an investor session', object({ challengeId: field, signature: field, proof: { type: 'object' } }));
  const protectedRoutes = [
    ['/auth/session', 'get', 'Read the current limited session'],
    ['/auth/logout', 'post', 'Revoke the current investor session'],
    ['/me', 'get', 'Read own balances, current eligibility and cashier state'],
    ['/activity', 'get', 'Read wallet/fund-scoped MultiBaas activity or labeled RPC fallback'],
    ['/identity', 'post', 'Attest only the verified credential fact, within issuer gas limits'],
    ['/quote', 'post', 'Read indicative NAV arithmetic and current blockers', object({ buy: { type: 'boolean' }, amount: field, route: { enum: ['auto', 'amm', 'cashier'] } }, ['buy', 'amount'])],
    ['/transactions/prepare', 'post', 'Prepare and simulate bounded calldata for the investor wallet to sign', object({ kind: { enum: ['approval', 'swap'] }, buy: { type: 'boolean' }, amount: field, minOut: field, deadline: { type: 'integer' }, route: { enum: ['auto', 'amm', 'cashier'] } }, ['kind', 'buy', 'amount'])],
    ['/transactions/confirm', 'post', 'Validate the actual RPC transaction and receipt against the session-bound intent', object({ intentId: field, txHash: field })],
  ];
  for (const [path, method, summary, body] of protectedRoutes) document.paths[`/v1/investor${path}`] = { [method]: operation('Investor', summary, [{ investor: [] }], body) };
  document.info.description += '\n\nPublic demo and investor discovery/auth endpoints are separate exceptions to operator auth. Demo tokens can access only their own agreement lifecycle. Investor tokens can access only the dedicated investor endpoints. Neither token is an operator key.';
  return document;
}
