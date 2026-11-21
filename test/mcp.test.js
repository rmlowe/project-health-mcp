import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fixture } from './fixtures.js';

const token = 'local-test-token-at-least-32-characters';
const env = { MCP_AUTH_MODE: 'bearer', MCP_AUTH_TOKEN: token, GITHUB_TOKEN: 'private-test-key' };
const ctx = { waitUntil(p) { return p; } };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(method = 'tools/list', params = {}, headers = {}) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { Host: 'localhost', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
async function rpc(method, params = {}, bindings = env) {
  const response = await worker.fetch(request(method, params), bindings, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const raw = await response.text();
  return JSON.parse(raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').find(l => l.startsWith('data:')).slice(5) : raw);
}

test('disabled, incomplete, unauthorized and cross-origin requests never reach upstream', async () => {
  globalThis.fetch = () => { throw new Error('must not fetch'); };
  for (const config of [{}, { MCP_AUTH_MODE: 'disabled' }, { MCP_AUTH_TOKEN: 'short' }]) {
    assert.equal((await worker.fetch(request(), config, ctx)).status, 404);
  }
  for (const auth of ['', 'Bearer wrong', `Basic ${token}`]) {
    assert.equal((await worker.fetch(request('tools/list', {}, { Authorization: auth }), env, ctx)).status, 401);
  }
  assert.equal((await worker.fetch(request('tools/list', {}, { Origin: 'https://evil.example' }), env, ctx)).status, 403);
});

test('legacy-compatible handshake and tool discovery expose exactly one read-only tool', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'project-health-mcp');
  const listed = await rpc('tools/list');
  assert.deepEqual(listed.result.tools.map(t => t.name), ['get_project_health']);
  assert.ok(listed.result.tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
});


test('authenticated health call returns matching text and structured data', async () => {
  const read = fixture();
  globalThis.fetch = async url => Response.json(await read(String(url)));
  const { result } = await rpc('tools/call', { name: 'get_project_health', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.project, 'roman-mission-monitor');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.doesNotMatch(JSON.stringify(result), /private-test-key/);
});

test('invalid project makes no requests; upstream failure reports unknown evidence', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('private-test-key'); };
  const invalid = await rpc('tools/call', { name: 'get_project_health', arguments: { project: 'arbitrary-url' } });
  assert.ok(invalid.error || invalid.result?.isError);
  assert.equal(calls, 0);
  const { result } = await rpc('tools/call', { name: 'get_project_health', arguments: {} });
  assert.equal(result.structuredContent.status, 'unknown');
  assert.doesNotMatch(result.content[0].text, /private-test-key/);
});

const climateEnv = { ...env,
  HOME_CLIMATE_MCP_URL: 'https://home-climate-dashboard.robertmlowe.workers.dev/mcp',
  HOME_CLIMATE_ACCESS_CLIENT_ID: 'fixture.access', HOME_CLIMATE_ACCESS_CLIENT_SECRET: 'fixture-secret',
};
const climateParams = { name: 'get_project_health', arguments: { project: 'home-climate-dashboard' } };

test('Home Climate calls the scoped tool and reads the SSE result using only service credentials', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, climateEnv.HOME_CLIMATE_MCP_URL);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['CF-Access-Client-Secret'], 'fixture-secret');
    assert.equal(init.headers['CF-Access-Client-Id'], 'fixture.access');
    assert.equal(new Headers(init.headers).has('Authorization'), false);
    const call = JSON.parse(init.body);
    assert.equal(call.method, 'tools/call');
    assert.deepEqual(call.params, { name: 'get_collection_health', arguments: {} });
    const result = { structuredContent: { retrievedAt: new Date().toISOString(), collectionStatus: 'recent_collections',
      rooms: [{ name: 'Bedroom', collectionStale: false, validReadingStale: false, temperature: { last: 21 } }] } };
    const message = JSON.stringify({ jsonrpc: '2.0', id: call.id, result });
    return new Response(': heartbeat\r\n\r\nevent: message\r\ndata: ' + message + '\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const { result } = await rpc('tools/call', climateParams, climateEnv);
  assert.equal(calls, 1);
  assert.equal(result.structuredContent.status, 'healthy');
  assert.equal(result.structuredContent.collectionStatus, 'recent_collections');
  assert.equal(result.structuredContent.rooms.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|temperature/);
});

test('Home Climate handles stale JSON evidence, denied requests and invalid configuration', async () => {
  globalThis.fetch = async () => Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: {
    collectionStatus: 'some_rooms_stale', retrievedAt: new Date().toISOString(),
    rooms: [{ name: 'Office', validReadingStale: true, collectionStale: true }],
  } } });
  assert.equal((await rpc('tools/call', climateParams, climateEnv)).result.structuredContent.status, 'degraded');
  globalThis.fetch = async () => new Response(null, { status: 403 });
  assert.equal((await rpc('tools/call', climateParams, climateEnv)).result.structuredContent.code, 'http_403');
  let calls = 0;
  globalThis.fetch = async () => { calls++; };
  const bad = { ...climateEnv, HOME_CLIMATE_MCP_URL: 'https://example.invalid/mcp' };
  assert.equal((await rpc('tools/call', climateParams, bad)).result.structuredContent.status, 'unknown');
  assert.equal(calls, 0);
});
