import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openapiDocument } from '../src/openapi.js';

test('the OpenAPI document describes every operation with a tag and responses, webhooks under their own tag', () => {
  const document = openapiDocument({ serverUrl: 'http://gateway.test' });
  assert.equal(document.openapi, '3.1.0');
  assert.deepEqual(document.servers, [{ url: 'http://gateway.test' }]);
  const tags = new Set(document.tags.map((tag) => tag.name));
  for (const [route, methods] of Object.entries(document.paths)) {
    assert.match(route, /^\/(health|openapi\.json|v1\/|webhooks\/)/, route);
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(['get', 'post', 'put', 'patch'].includes(method), `${method} ${route}`);
      assert.ok(operation.summary && operation.tags?.length === 1 && tags.has(operation.tags[0]), `${method} ${route} is tagged`);
      assert.ok(Object.keys(operation.responses).some((code) => code.startsWith('2')), `${method} ${route} has a success response`);
      for (const [name] of (route.match(/\{(\w+)\}/g) ?? []).map((m) => [m.slice(1, -1)])) assert.ok(operation.parameters?.some((p) => p.name === name && p.in === 'path'), `${route} declares {${name}}`);
    }
  }
  for (const schema of JSON.stringify(document).matchAll(/#\/components\/schemas\/(\w+)/g)) assert.ok(document.components.schemas[schema[1]], `schema ${schema[1]} exists`);

  const webhook = document.paths['/webhooks/payments'].post;
  assert.deepEqual(webhook.tags, ['Webhooks']);
  assert.deepEqual(webhook.security, [{ stripeSignature: [] }]);
  assert.equal(document.components.securitySchemes.stripeSignature.name, 'Stripe-Signature');
  assert.equal(webhook.requestBody.content['application/json'].schema.$ref, '#/components/schemas/PaymentEvent');
  assert.ok(webhook.responses[200] && webhook.responses[400] && webhook.responses[503]);
  for (const route of ['/v1/agreements', '/v1/agreements/{id}/deploy', '/v1/stack/wallets/{wallet}/worldid', '/v1/stack/events', '/v1/status']) assert.ok(document.paths[route], route);
});

test('the gateway serves the document and Swagger UI without a bearer', async (t) => {
  const venues = { record: { chainId: 31337, rwa: {}, credit: {} } };
  const server = createApp(null, 'a-test-operator-key-at-least-24-characters', venues).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const spec = await fetch(`${url}/openapi.json`);
  assert.equal(spec.status, 200);
  const document = await spec.json();
  assert.equal(document.servers[0].url, url);
  assert.ok(document.paths['/webhooks/payments']);
  const docs = await fetch(`${url}/docs`);
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get('content-type'), /text\/html/);
  const html = await docs.text();
  assert.match(html, /swagger-ui-bundle\.js/);
  assert.match(html, /url: '\/openapi\.json'/);
});
