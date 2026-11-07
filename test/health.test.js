import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectHealth, createReader, EvidenceError, RUNS, SITE } from '../src/health.js';
import { now, collection, run, jobs, fixture } from './fixtures.js';
const check = options => getProjectHealth({}, { read: fixture(options), now });

test('October incident: subsequent confirmed deployment resolves the failure', async () => {
  const h = await check();
  assert.equal(h.status, 'healthy');
  assert.equal(h.deployment.unresolvedFailures.length, 0);
  assert.equal(h.deployment.recoveredFailures[0].recoveredBy.id, 3);
  assert.equal(h.deployment.latestSuccessfulDeployment.id, 3);
});
test('green workflow with skipped deployment does not clear failure', async () => {
  const h = await check({ job: jobs('skipped', null) });
  assert.equal(h.status, 'degraded');
  assert.equal(h.deployment.latestSuccessfulDeployment, null);
  assert.equal(h.deployment.unresolvedFailures.length, 1);
});
test('fresh repository and green deployment cannot hide stale published data', async () => {
  const h = await check({ published: collection('2026-10-30T11:00:00Z') });
  assert.equal(h.status, 'degraded');
  assert.equal(h.repositoryCollection.status, 'healthy');
  assert.equal(h.publishedCollection.status, 'degraded');
});
test('missing endpoint and malformed evidence remain unknown', async () => {
  for (const published of [new EvidenceError('http_404'), {}, collection('2030-01-01T00:00:00Z')]) {
    const h = await check({ published });
    assert.equal(h.status, 'unknown');
    assert.equal(h.publishedCollection.status, 'unknown');
  }
});
test('a stale individual source cannot be hidden by a fresh aggregate timestamp', async () => {
  const published = collection(); published.sources.romanBlog.lastSuccessfulCheckAt = '2026-10-30T10:00:00Z';
  assert.equal((await check({ published })).status, 'degraded');
});
test('stalled workflow is degraded even when a successful deployment exists', async () => {
  const h = await check({ runs: [run(1, 'success', '2026-10-30T10:00:00Z')] });
  assert.equal(h.deployment.status, 'degraded');
});
test('newer failed run remains unresolved; running and cancelled runs cannot imply recovery', async () => {
  for (const newest of [run(4, 'failure'), { ...run(4, null), status: 'in_progress' }, run(4, 'cancelled')]) {
    const h = await check({ runs: [newest, run(3, 'failure'), run(2, 'success', '2026-10-30T13:00:00Z')],
      job: jobs('success', '2026-10-30T13:02:00Z') });
    assert.equal(h.deployment.status, 'degraded');
    assert.ok(h.deployment.unresolvedFailures.some(r => r.id === 3));
  }
});
test('empty runs and incomplete jobs never yield healthy', async () => {
  for (const options of [{ runs: [] }, { runs: [run(3)], job: { total_count: 101, jobs: [] } },
    { runs: [run(3)], job: { total_count: 1, jobs: [{ name: 'renamed', steps: [] }] } }]) {
    assert.equal((await check(options)).deployment.status, 'unknown');
  }
});
test('uses exact latest attempt and states bounded historical coverage', async () => {
  const r = run(3); r.run_attempt = 2;
  const h = await check({ runs: [r], job: url => {
    assert.match(url, /runs\/3\/attempts\/2\/jobs/); return jobs();
  } });
  assert.equal(h.deployment.latestSuccessfulDeployment.attempt, 2);
  assert.equal(h.deployment.coverage.bounded, true);
});
test('upstream outages are redacted and partial evidence is preserved', async () => {
  const read = fixture();
  const h = await getProjectHealth({}, { now, read: u => {
    if (u === RUNS) throw new Error('SECRET'); return read(u);
  } });
  assert.equal(h.status, 'unknown');
  assert.equal(h.publishedCollection.status, 'healthy');
  assert.doesNotMatch(JSON.stringify(h), /SECRET/);
});
test('reader limits destinations, credentials, redirects, size and errors', async () => {
  const calls = [];
  const read = createReader({ GITHUB_TOKEN: 'SECRET' }, { fetcher: async (url, init) => {
    calls.push({ url, init }); return Response.json({ ok: true });
  } });
  await read(RUNS); await read(SITE);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer SECRET');
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.ok(calls.every(c => c.init.redirect === 'manual'));
  await assert.rejects(read('https://evil.example/'), /endpoint_not_allowed/);
  assert.equal(calls.length, 2);
  for (const status of [302, 403, 429, 500]) {
    const r = createReader({}, { fetcher: async () => new Response('SECRET', { status }) });
    await assert.rejects(r(RUNS), e => !e.message.includes('SECRET') && e instanceof EvidenceError);
  }
  const big = createReader({}, { fetcher: async () => new Response('x'.repeat(2_000_001)) });
  await assert.rejects(big(SITE), /response_too_large/);
});
