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
async function rpc(method, params = {}) {
  const response = await worker.fetch(request(method, params), env, ctx);
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
