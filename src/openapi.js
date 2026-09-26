// The gateway's OpenAPI 3.1 document, served at /openapi.json and rendered by Swagger UI at /docs.
// Hand-written next to the routes it describes: every path here is one src/routes.js mounts.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const json = (schema, description) => ({ description, content: { 'application/json': { schema } } });
const error = (description) => json(ref('Error'), description);
const ok = (schema, description = 'OK') => ({ 200: json(schema, description) });
const bearer = [{ bearer: [] }];
const path = (name) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const WALLET = { ...path('wallet'), description: 'A demo wallet name (Investor, Stranger, Lender A…, Operator) or an address' };
const op = (tag, summary, { description, params, body, responses, security = bearer } = {}) => ({
  tags: [tag], summary, ...(description ? { description } : {}), security,
  ...(params ? { parameters: params } : {}),
  ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  responses: { ...responses, 401: error('Missing or wrong bearer token') },
});
const amount = obj({ amount: str('Decimal amount, six places at most', { example: '100' }) });
const walletAmount = obj({ wallet: str('Demo wallet name or address'), amount: str('Decimal amount') });
const walletHooked = obj({ wallet: str('Demo wallet name or address'), hooked: { type: 'boolean', description: 'true for the policy-hooked pool, false for the hookless one' } });

export const schemas = {
  Error: obj({ error: obj({ code: str('Machine-readable code, e.g. POLICY_REFUSED'), message: str('Plain-words reason'), details: { description: 'The audit entry, for a refusal', type: 'object' } }, ['code', 'message']) }),
  Health: obj({ status: str('ok | reconciliation_required'), mode: str('stack | mock | live'), policyHash: { type: ['string', 'null'] }, stack: { type: ['object', 'null'], properties: { chainId: { type: 'integer' }, rwa: str('Fund policy hash'), credit: str('Credit policy hash') } } }),
  Status: obj({
    model: obj({ provider: str('openai | demo'), mode: str('mock | live | unavailable'), model: str('Model id') }),
    compiler: obj({ solidity: obj({ core: str('solc version'), swapvm: str('solc version'), 'uniswap-v4': str('solc version') }) }),
    chain: { type: ['object', 'null'], properties: { chainId: { type: 'integer' }, deployer: str('Operator address'), attestor: str('PolicyAttestor'), poolManager: str('Uniswap v4 PoolManager') } },
  }),
  DocumentPart: obj({ name: str('File name; the extension picks the reader (.txt, .md, .htm, .html)'), text: str('The document as uploaded') }),
  AgreementUpload: {
    type: 'object', required: ['name'],
    properties: { generation: { type: 'string', enum: ['openai', 'demo'], description: 'OpenAI legal AST (default), or an explicit offline compiler fixture' }, name: str('Display name'), documents: { type: 'array', items: ref('DocumentPart'), description: 'One or more parts, hashed as one bundle' }, text: str('Short form: one document'), filename: str('Short form: its file name (default <name>.txt)'), profile: str('rwa-secondary (default) | custodial-rwa | wildcat-credit'), config: { type: 'object', description: 'Deployment config; the profile default when absent' } },
  },
  Agreement: obj({
    id: str('agr_<12 hex>'), name: str('Display name'), profile: str('Deployment profile'),
    status: str('uploaded | extracting | verified | analyzed | compiled | deploying | deployed | failed'),
    createdAt: str('ISO time'), updatedAt: str('ISO time'),
    source: obj({ name: str('Document name'), sha256: str('Bytes hash'), textSha256: str('Normalized text hash') }),
    extraction: { type: ['object', 'null'], properties: { provider: str('openai | demo'), model: str('Model id'), responseId: str('OpenAI response id'), analysisMode: str('light'), compilerMapping: { type: 'object', description: 'Explicit MVP mapping identifier, source hashes and scope; absent for analysis-only uploads' } } },
    verification: { type: ['object', 'null'], properties: { confidence: obj({ overall: { type: 'number' }, verified: { type: 'integer' }, total: { type: 'integer' }, counts: { type: 'object' } }), contested: { type: 'integer' } } },
    policyHash: { type: ['string', 'null'] }, clauseTableHash: { type: ['string', 'null'] },
    coverage: { type: ['object', 'null'], properties: { total: { type: 'integer' }, counts: { type: 'object' }, rules: { type: 'integer' }, terms: { type: 'integer' } } },
    deployment: { type: ['object', 'null'], properties: { chainId: { type: 'integer' }, policyHash: str('On-chain hash'), oracle: str('PolicyOracle'), token: str('CompiledMirrorToken or mock credit market'), roleProvider: str('Credit role provider'), market: str('Mock credit market'), router: str('Policy-bound venue router'), hook: str('MirrorPolicyHook'), poolManager: str('PoolManager'), poolId: str('Pool id'), txs: { type: 'object' } } },
    error: { type: ['string', 'null'] },
    history: { type: 'array', items: obj({ status: str('State entered'), at: str('ISO time'), policyHash: str('Hash in force') }, ['status', 'at']) },
  }, ['id', 'name', 'profile', 'status']),
  AgreementDetail: { allOf: [ref('Agreement'), obj({ ast: { type: ['object', 'null'], description: 'Version 2.0 legal AST: title, documents with hashes and normalized text, nodes with parentId and located source quotes, typed relations, issues. Version 1.0 is the executable subset for explicitly mapped MVP sources and historical compiler records.' }, documentAst: { type: ['object', 'null'], description: 'Original model-generated version 2.0 overview when ast is an executable compiler mapping' }, export: { type: ['object', 'null'], description: 'The compiled reading: rules with clauseId, dnf and located quotes; terms; unresolved; clauseTable; programs; coverage; verification; documents with display text' } })] },
  AstGraph: obj({
    nodes: { type: 'array', items: obj({ id: str('agreement | action:<a> | rule:<id> | fact:<name> | term:<name> | unresolved:<n>'), kind: str('agreement | document | section | clause | definition | obligation | permission | prohibition | condition | exception | party | remedy | date | amount; legacy compiler nodes are also supported'), label: str('Display label'), status: str('verified | contested | unverified | unresolved'), confidence: { type: ['number', 'null'] } }, ['id', 'kind', 'label']) },
    edges: { type: 'array', items: obj({ from: str('Node id'), to: str('Node id'), kind: str('contains | references | defines | applies_to | requires | excepts | overrides | amends | party_to') }) },
  }),
  PaymentEvent: {
    type: 'object', required: ['id', 'type', 'data'],
    description: 'A Stripe event, or a wire notification in the same shape. Only settled USD payments settle; other types are acknowledged and ignored.',
    properties: {
      id: str('Event id; the same id settles once', { example: 'evt_1Nq' }),
      type: str('payment_intent.succeeded | charge.succeeded | wire.received settle; anything else is ignored', { example: 'payment_intent.succeeded' }),
      data: obj({ object: obj({
        id: str('Payment id, kept as the reference', { example: 'pi_3Nq' }),
        amount: { type: 'integer', description: 'Minor units (cents)', example: 12550 },
        currency: str('usd', { example: 'usd' }),
        metadata: obj({ wallet: str('The investor wallet: demo name or address', { example: 'Investor' }), agreement: str('Settle on this agreement\'s token (agr_…); the stack\'s fund token when absent') }, ['wallet']),
      }, ['amount', 'currency', 'metadata']) }),
    },
  },
  Settlement: obj({
    id: str('Audit entry id'), at: str('ISO time'), type: str('payment.settle'), paymentId: str('Event id'), reference: { type: ['string', 'null'] },
    wallet: str('Wallet name or address'), amount: str('Decimal USD'),
    status: str('ok: shares released | held: the policy refused the mint, the money waits | failed: the chain refused (e.g. supply cap), the rail may retry'),
    txHash: str('Release transaction, when ok'), mintTxHash: str('Mint transaction, when ok'),
    refusal: { type: 'object', description: 'When held: the rule and the sentence that held it' },
    replay: { type: 'boolean', description: 'true when this event id had already settled' },
  }, ['id', 'type', 'paymentId', 'wallet', 'amount', 'status']),
  PaymentReceived: obj({ received: { type: 'boolean' }, ignored: str('Event type, when not a settling payment'), payment: { type: 'object' }, settlement: ref('Settlement') }, ['received']),
  Constraints: obj({ identity: { type: ['object', 'null'], description: 'null lifts the constraint', properties: { credential: str('document | proof_of_human | selfie', { example: 'document' }), actions: { type: 'array', items: { type: 'string', enum: ['mint', 'burn', 'transfer'] }, example: ['mint', 'transfer'] }, quote: str('The sentence of the agreement this enforces, verbatim; defaults to the current constraint\'s'), clause: str('Where it is in the agreement') } } }),
  Facts: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Fact name → value; names come from the policy factOrder', example: { kycApproved: true, amlApproved: true, sanctionsClear: true } },
  Decision: obj({ wallet: str('Name'), address: str('Address'), action: str('Policy action'), allowed: { type: 'boolean' }, clauseId: { type: 'integer' }, clause: { type: ['object', 'null'], description: 'The deciding clause: ruleId, clause, quote' }, facts: { type: 'object' }, sanctioned: { type: 'boolean' }, screeningCurrent: { type: 'boolean' } }),
  AuditEntry: obj({ id: str('Entry id'), at: str('ISO time'), type: str('attest | worldid.verify | rwa.* | credit.* | payment.settle | sanction | override'), status: str('ok | refused | held'), txHash: { type: ['string', 'null'] }, refusal: { type: ['object', 'null'] } }, ['id', 'at', 'type', 'status']),
};

// The deployed agreement's own venue answers the same routes as the stack, over its token, oracle and hook.
const VENUE_ROUTES = ['/wallets', '/wallets/{wallet}', '/wallets/{wallet}/explain', '/wallets/{wallet}/facts', '/worldid/context', '/wallets/{wallet}/worldid', '/wallets/{wallet}/sanction', '/wallets/{wallet}/fund', '/rwa/mint', '/rwa/release', '/rwa/pools', '/rwa/liquidity', '/rwa/swap', '/audit', '/events'];
function agreementVenuePaths(paths, agreementId) {
  return Object.fromEntries(VENUE_ROUTES.map((route) => [`/v1/agreements/{id}/stack${route}`, Object.fromEntries(Object.entries(paths[`/v1/stack${route}`]).map(([method, operation]) => [method, {
    ...operation, tags: ['Agreements'], summary: `${operation.summary} (this agreement's venue)`, parameters: [agreementId, ...(operation.parameters ?? [])],
    responses: { ...operation.responses, 409: error('The venue exists once the agreement is deployed') },
  }]))]));
}

export function openapiDocument({ serverUrl = '/' } = {}) {
  const agreementId = { ...path('id'), description: 'Agreement id (agr_…)' };
  const document = openapiBase(serverUrl, agreementId);
  Object.assign(document.paths, agreementVenuePaths(document.paths, agreementId));
  return document;
}

function openapiBase(serverUrl, agreementId) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'mirr0tech gateway', version: '0.1.0',
      description: 'A legal agreement goes in; out comes the policy that admits, refuses and pays under it. This API uploads agreements, watches them compile and deploy, drives the deployed venues, and takes the payment rail\'s webhooks.\n\nAuthentication: `Authorization: Bearer <API_KEY>` for everything under `/v1`; `VIEWER_KEY` opens GET routes and quotes. `/webhooks/*` carry no bearer: each rail signs its events.',
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: 'Health', description: 'Liveness and what the gateway serves' },
      { name: 'Agreements', description: 'The core loop: upload → generate → verify → compile → deploy' },
      { name: 'Webhooks', description: 'Endpoints other systems call. Signed, never bearer-authenticated, always 2xx once verified so the caller does not retry a policy decision.' },
      { name: 'Stack', description: 'The deployed two-act stack: facts, identity, the fund token and its pool, the credit market and its buyback' },
      { name: 'Dashboard', description: 'Read models and lender operations the dashboard uses' },
    ],
    paths: {
      '/health': { get: { tags: ['Health'], summary: 'Liveness', security: [], responses: ok(ref('Health')) } },
      '/openapi.json': { get: { tags: ['Health'], summary: 'This document', security: [], responses: { 200: { description: 'OpenAPI 3.1' } } } },
      '/v1/status': { get: op('Health', 'Model, compiler and chain health', { responses: ok(ref('Status')) }) },

      '/v1/agreements': {
        get: op('Agreements', 'List agreements', { responses: ok({ type: 'array', items: ref('Agreement') }) }),
        post: op('Agreements', 'Upload an agreement and start generating its policy', {
          description: 'Returns at once in `extracting`; the deliberation, validation and compilation run in the background. Poll the record. Body limit 4 MB.',
          body: ref('AgreementUpload'),
          responses: { 201: json(ref('Agreement'), 'Created, extracting'), 400: error('INVALID_BODY, UNKNOWN_PROFILE or INVALID_DOCUMENT'), 413: error('Over 4 MB') },
        }),
      },
      '/v1/agreements/{id}': { get: op('Agreements', 'One agreement with its compiled reading', { params: [agreementId], responses: { ...ok(ref('AgreementDetail')), 404: error('Unknown id') } }) },
      '/v1/agreements/{id}/ast': { get: op('Agreements', 'The tree: agreement → actions → rules → facts', { params: [agreementId], responses: { ...ok(ref('AstGraph')), 404: error('Unknown id'), 409: error('Not compiled yet') } }) },
      '/v1/agreements/{id}/constraints': {
        get: op('Agreements', 'The World ID constraint on the agreement', { params: [agreementId], responses: { ...ok(ref('Constraints')), 409: error('Nothing compiled yet') } }),
        put: op('Agreements', 'Put a World ID constraint on the agreement, or lift it', {
          description: 'Adds a `require identityVerified` rule per action, quoting the sentence it enforces, and records the credential in the config. Both are inside the policy hash: the agreement recompiles and must be deployed again. `identity: null` lifts it.',
          params: [agreementId], body: ref('Constraints'),
          responses: { ...ok(ref('Agreement'), 'Recompiled'), 400: error('INVALID_BODY or QUOTE_NOT_FOUND'), 409: error('A job is in flight') },
        }),
      },
      '/v1/agreements/{id}/regenerate': { post: op('Agreements', 'Run a new deliberation', { params: [agreementId], responses: { 202: json(ref('Agreement'), 'Extracting again; the earlier hash stays in history'), 404: error('Unknown id'), 409: error('A job is in flight, or the state does not allow it') } }) },
      '/v1/agreements/{id}/deploy': { post: op('Agreements', 'Deploy oracle, token, hook and pool for this agreement', { description: 'Compiles the generated Solidity at runtime and deploys on the chain the gateway signs on. 202 with `deploying`; poll for `deployed`.', params: [agreementId], responses: { 202: json(ref('Agreement'), 'Deploying'), 404: error('Unknown id'), 409: error('INVALID_STATE: deploy needs `compiled`; UNSUPPORTED_PROFILE: the credit profile has no token of its own'), 503: error('NO_CHAIN: no signer') } }) },
      '/v1/agreements/{id}/liquidity': { get: op('Agreements', 'Read backend token balances and deployed pool liquidity', { params: [agreementId], responses: { ...ok({ type: 'object' }), 409: error('NO_POOL or LEGACY_POOL_ASSET'), 503: error('NO_SEEDER') } }) },
      '/v1/agreements/{id}/liquidity/seeds': { post: op('Agreements', 'Seed the deployed pool from the backend wallet', { params: [agreementId], body: obj({ requestId: str('Unique request ID, 16–80 letters, numbers, underscores or hyphens'), rwaAmount: str('Maximum RWA deposit, six decimals'), usdAmount: str('Maximum shared mUSDC deposit, six decimals') }), responses: { 202: json({ type: 'object' }, 'Seed operation; poll its status'), 400: error('INVALID_SEED'), 409: error('LEGACY_POOL_ASSET, SEED_CONFLICT or BUSY') } }) },
      '/v1/agreements/{id}/liquidity/seeds/{requestId}': { get: op('Agreements', 'Read pool seed status and transaction hashes', { params: [agreementId, path('requestId')], responses: { ...ok({ type: 'object' }), 404: error('Unknown seed request') } }) },
      '/v1/agreements/{id}/mint': { post: op('Agreements', 'Mint the selected RWA token and release it using the backend signer', { params: [agreementId], description: 'Operator or local workspace authorization required. Reuse the same requestId to retry without duplicate issuance. Eligibility and supply limits apply.', body: obj({ recipient: str('Recipient wallet'), amount: str('Positive decimal amount, at most six places'), requestId: str('Unique idempotency ID, 16–80 letters, numbers, underscores or hyphens'), testAttestations: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['issuerAuthorized', 'offeringCompliant', 'identityVerified', 'kycApproved', 'amlApproved', 'sanctionsClear'].map(fact => [fact, { type: 'boolean', default: false }])), description: 'Explicit testnet-only simulations. Identity is not verified by World ID; sanctions clearance updates only the configured mock oracle.' }, simulateDeposit: { type: 'boolean', default: false, description: 'Explicit testnet-only bank deposit simulation: record depositConfirmed=true for the recipient. No real payment is verified. Normal issuance requires a bank settlement attestation.' }, bypassSubscription: { type: 'boolean', default: false, description: 'Testnet only: record subscriptionAccepted=true through the backend attestor; other policy checks still apply' } }, ['recipient', 'amount', 'requestId']), responses: { 202: json({ type: 'object' }, 'Mint operation; poll its status'), 400: error('INVALID_MINT'), 409: error('NOT_DEPLOYED, MINT_UNSUPPORTED, MINT_CONFLICT or BUSY'), 503: error('NO_MINTER') } }) },
      '/v1/agreements/{id}/mints/{requestId}': { get: op('Agreements', 'Read mint status, stage and transaction hashes', { params: [agreementId, path('requestId')], responses: { ...ok({ type: 'object' }), 404: error('Unknown agreement or mint request') } }) },
      '/v1/agreements/{id}/swap/state': { get: op('Agreements', 'Read swap balances and liquidity through the backend Sepolia RPC', { params: [agreementId, { name: 'wallet', in: 'query', required: true, schema: { type: 'string' } }], responses: ok({ type: 'object' }) }) },
      '/v1/agreements/{id}/swap/receipts/{hash}': { get: op('Agreements', 'Read a Sepolia swap receipt', { params: [agreementId, { name: 'hash', in: 'path', required: true, schema: { type: 'string' } }], responses: ok({ type: ['object', 'null'] }) }) },
      '/v1/agreements/{id}/swap/quote': { post: op('Agreements', 'Quote an exact-input swap through the deployed Uniswap v4 pool', { params: [agreementId], body: obj({ wallet: str('Sepolia wallet'), direction: { type: 'string', enum: ['buy', 'sell'] }, amount: str('Input token base units'), slippageBps: { type: 'integer', minimum: 1, maximum: 500 } }), responses: { ...ok({ type: 'object' }), 400: error('INVALID_SWAP'), 409: error('NOT_DEPLOYED, STALE_DEPLOYMENT, NO_UNISWAP_POOL, POOL_NOT_ROUTED or SWAP_SIMULATION_FAILED'), 503: error('UNISWAP_NOT_CONFIGURED or UNISWAP_UNAVAILABLE') } }) },
      ...Object.fromEntries(['approval', 'transaction'].map((step) => [`/v1/agreements/{id}/swap/${step}`, { post: op('Agreements', `Prepare unsigned Uniswap ${step}`, { description: 'Wallet-signed only. No gateway broadcast. Requires an unexpired quote for this agreement and wallet.', params: [agreementId], body: obj({ wallet: str('Quoted wallet'), quoteId: str('Gateway quote ID'), signature: str('Permit2 signature when quote includes permitData') }), responses: { ...ok({ type: 'object' }), 409: error('INVALID_QUOTE or QUOTE_EXPIRED'), 502: error('UNISWAP_REQUEST_FAILED or UNISWAP_INVALID_RESPONSE') } }) }])),

      '/webhooks/payments': {
        post: {
          tags: ['Webhooks'], summary: 'A payment rail reports money in',
          description: 'Stripe signature scheme: `Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with `PAYMENT_WEBHOOK_SECRET`, 5-minute tolerance. A settled USD event attests `depositConfirmed` for `metadata.wallet`, then the policy decides the mint: allowed → shares minted and released (`status: ok`); refused → the money is held and the audit names the sentence (`status: held`). The same event id settles once (`replay: true`). Other event types answer `{ received: true, ignored }`.',
          security: [{ stripeSignature: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: ref('PaymentEvent') } } },
          responses: { 200: json(ref('PaymentReceived'), 'Verified and decided'), 400: error('INVALID_SIGNATURE, INVALID_JSON or INVALID_PAYMENT'), 404: error('Unknown wallet'), 503: error('NO_WEBHOOK_SECRET: the gateway has no secret configured') },
        },
      },

      '/v1/stack': { get: op('Stack', 'Deployment record, demo wallets and policies', { responses: ok({ type: 'object' }) }) },
      '/v1/stack/wallets': { get: op('Stack', 'Every demo wallet with balances and decisions', { responses: ok({ type: 'array', items: { type: 'object' } }) }) },
      '/v1/stack/wallets/{wallet}': { get: op('Stack', 'One wallet: balances, credential, fund and credit decisions', { params: [WALLET], responses: { ...ok({ type: 'object' }), 404: error('Unknown wallet') } }) },
      '/v1/stack/wallets/{wallet}/explain': { get: op('Stack', 'Why the policy admits or refuses this wallet for an action', { params: [WALLET, { name: 'policy', in: 'query', schema: { type: 'string', enum: ['rwa', 'credit'] } }, { name: 'action', in: 'query', schema: { type: 'string' }, description: 'mint | burn | transfer | deposit | withdraw' }], responses: ok(ref('Decision')) }) },
      '/v1/stack/wallets/{wallet}/facts': { post: op('Stack', 'Attest facts for a wallet (replaces the set)', { params: [WALLET], body: obj({ policy: str('rwa | credit'), facts: ref('Facts'), days: { type: 'integer', description: 'Validity, default 30' } }, ['policy', 'facts']), responses: { ...ok(ref('AuditEntry')), 400: error('Unknown fact') } }) },
      '/v1/stack/worldid/context': { get: op('Stack', 'The signed request context IDKit needs', { responses: ok({ type: 'object' }) }) },
      '/v1/stack/wallets/{wallet}/worldid': { post: op('Stack', 'Verify a World ID proof and attest identityVerified', { params: [WALLET], body: obj({ proof: { type: 'object', description: 'The IDKit result' }, days: { type: 'integer' } }, ['proof']), responses: { ...ok(ref('AuditEntry')), 400: error('INVALID_PROOF'), 409: error('HUMAN_ALREADY_BOUND: this human onboarded another wallet') } }) },
      '/v1/stack/wallets/{wallet}/sanction': { post: op('Stack', 'Designate or clear a wallet on the sanctions oracle', { params: [WALLET], body: obj({ sanctioned: { type: 'boolean' } }), responses: ok(ref('AuditEntry')) }) },
      '/v1/stack/wallets/{wallet}/override': { post: op('Stack', 'Borrower override under the MLA', { params: [WALLET], responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/wallets/{wallet}/fund': { post: op('Stack', 'Give a demo wallet mock USD (and gas on a public chain)', { params: [WALLET], body: amount, responses: ok({ type: 'object' }) }) },
      '/v1/stack/rwa/mint': { post: op('Stack', 'Mint fund shares to custody', { body: amount, responses: ok(ref('AuditEntry')) }) },
      '/v1/stack/rwa/release': { post: op('Stack', 'Release shares from custody to a wallet, under the transfer policy', { body: walletAmount, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED with the sentence') } }) },
      '/v1/stack/rwa/pools': { post: op('Stack', 'Create the Uniswap v4 pool (hooked or hookless)', { body: walletHooked, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/rwa/liquidity': { post: op('Stack', 'Add liquidity through the hook', { body: walletHooked, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/rwa/swap': { post: op('Stack', 'Swap in the pool', { body: walletHooked, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/credit/deposit': { post: op('Stack', 'Deposit into the credit market, decided by the role provider', { body: walletAmount, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/credit/withdraw': { post: op('Stack', 'Withdraw from the credit market', { body: walletAmount, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/credit/buyback': {
        get: op('Stack', 'The buyback strategy in force', { responses: ok({ type: 'object' }) }),
        post: op('Stack', 'Ship the buyback to Aqua (fixed price, or a Dutch tender)', { body: { type: 'object', properties: { auction: { type: 'boolean' } } }, responses: ok(ref('AuditEntry')) }),
      },
      '/v1/stack/credit/buyback/quote': { post: op('Stack', 'Quote a fill (a static call; a viewer may ask)', { body: walletAmount, responses: { ...ok({ type: 'object' }), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/credit/buyback/fill': { post: op('Stack', 'Fill through SwapVM with the policy guard', { body: walletAmount, responses: { ...ok(ref('AuditEntry')), 403: error('POLICY_REFUSED') } }) },
      '/v1/stack/credit/buyback/dock': { post: op('Stack', 'Dock the buyback', { responses: ok(ref('AuditEntry')) }) },
      '/v1/stack/audit': { get: op('Stack', 'The local audit, oldest first', { responses: ok({ type: 'array', items: ref('AuditEntry') }) }) },
      '/v1/stack/events': { get: op('Stack', 'Gateway audit events (not a complete chain history)', { responses: ok(obj({ source: str('local', { enum: ['local'] }), events: { type: 'array', items: { type: 'object' } } })) }) },

      '/v1/policy/profiles': { get: op('Dashboard', 'The compiled profiles with coverage', { responses: ok({ type: 'array', items: { type: 'object' } }) }) },
      '/v1/policy': { get: op('Dashboard', 'One profile\'s compiled reading', { params: [{ name: 'profile', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'object' }) }) },
      '/v1/lenders': { get: op('Dashboard', 'Parties under a profile with their standing', { params: [{ name: 'profile', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'array', items: { type: 'object' } }) }) },
      '/v1/lenders/{id}/attestations': { patch: op('Dashboard', 'Set a party\'s facts (identityVerified is kept, never set by hand)', { params: [path('id'), { name: 'profile', in: 'query', schema: { type: 'string' } }], body: ref('Facts'), responses: ok({ type: 'object' }) }) },
      '/v1/lenders/{id}/worldid': { post: op('Dashboard', 'Verify a party\'s World ID proof', { params: [path('id'), { name: 'profile', in: 'query', schema: { type: 'string' } }], body: obj({ proof: { type: 'object' } }), responses: { ...ok({ type: 'object' }), 409: error('HUMAN_ALREADY_BOUND') } }) },
      '/v1/lenders/{id}/approve': { post: op('Dashboard', 'Approve a lender (attest the admitting facts)', { params: [path('id'), { name: 'profile', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'object' }) }) },
      '/v1/lenders/{id}/reject': { post: op('Dashboard', 'Reject a lender', { params: [path('id'), { name: 'profile', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'object' }) }) },
      '/v1/lenders/{id}/revoke': { post: op('Dashboard', 'Revoke a lender', { params: [path('id'), { name: 'profile', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'object' }) }) },
      '/v1/audit': { get: op('Dashboard', 'Timeline events for a profile, newest first', { params: [{ name: 'profile', in: 'query', schema: { type: 'string' } }], responses: ok({ type: 'array', items: { type: 'object' } }) }) },
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'API_KEY (operator) or VIEWER_KEY (GET and quotes)' },
        stripeSignature: { type: 'apiKey', in: 'header', name: 'Stripe-Signature', description: 't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>"> under PAYMENT_WEBHOOK_SECRET' },
      },
      schemas,
    },
  };
}

/// Swagger UI from the CDN, pointed at this gateway's document.
export const swaggerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>mirr0tech gateway API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script>window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', persistAuthorization: true, tagsSorter: 'alpha' });</script>
</body></html>
`;
