import { z } from 'zod';

export const REPO = 'rmlowe/roman-mission-monitor';
export const API = `https://api.github.com/repos/${REPO}`;
export const SITE = 'https://rmlowe.github.io/roman-mission-monitor/health.json';
export const RUNS = `${API}/actions/workflows/update-mission.yml/runs?branch=main&per_page=20`;
export const COLLECTION = `${API}/contents/data/collection-health.json?ref=main`;
const MAX_AGE_SECONDS = 3 * 3600;
const stamp = z.iso.datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const id = z.number().int().positive();
const runSchema = z.object({
  id, run_number: id, run_attempt: id, head_branch: z.literal('main'),
  event: z.enum(['push', 'schedule', 'workflow_dispatch']),
  status: z.string(), conclusion: z.string().nullable(), created_at: stamp, updated_at: stamp,
});
const runsSchema = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema).max(20) });
const jobsSchema = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(z.object({
  name: z.string(), steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(),
    completed_at: stamp.nullable().optional() })),
})).max(100) });
const sourceSchema = z.object({ lastSuccessfulCheckAt: stamp });
const collectionSchema = z.object({ schemaVersion: z.literal(1), lastSuccessfulCheckAt: stamp,
  sources: z.object({ romanBlog: sourceSchema, romanCommissioning: sourceSchema }),
});

export class EvidenceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Fixed endpoints only. Never forward the optional GitHub token to Pages or redirects.
export function createReader(env = {}, { fetcher = fetch, signal } = {}) {
  return async url => {
    if (url !== RUNS && url !== COLLECTION && url !== SITE &&
        !(url.startsWith(API + '/') && /^actions\/runs\/[0-9]+\/attempts\/[0-9]+\/jobs\?per_page=100$/.test(url.slice(API.length + 1)))) {
      throw new EvidenceError('endpoint_not_allowed');
    }
    const headers = { Accept: url === COLLECTION ? 'application/vnd.github.raw+json' : 'application/json',
      'User-Agent': 'project-health-mcp', 'Cache-Control': 'no-cache' };
    if (url.startsWith(API)) {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }
    try {
      const response = await fetcher(url, { headers, redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new EvidenceError(response.status === 429 || response.status === 403 ? 'rate_limited_or_forbidden' : `http_${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new EvidenceError('invalid_response');
      const chunks = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 2_000_000) throw new EvidenceError('response_too_large');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'unavailable_or_invalid_json');
    }
  };
}

function failure(error) {
  return error instanceof EvidenceError ? error.code : 'invalid_response';
}
export function assessCollection(raw, now, url) {
  const data = collectionSchema.parse(raw);
  const times = [data.lastSuccessfulCheckAt, data.sources.romanBlog.lastSuccessfulCheckAt,
    data.sources.romanCommissioning.lastSuccessfulCheckAt].map(Date.parse);
  if (times.some(t => t > now + 60_000)) throw new EvidenceError('future_timestamp');
  const ageSeconds = Math.max(0, Math.floor((now - Math.min(...times)) / 1000));
  return { status: ageSeconds > MAX_AGE_SECONDS ? 'degraded' : 'healthy',
    lastSuccessfulCheckAt: data.lastSuccessfulCheckAt, sources: data.sources,
    ageSeconds, staleAfterSeconds: MAX_AGE_SECONDS, evidenceUrl: url };
}
const runLink = run => `https://github.com/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
function summary(run) {
  return { id: run.id, attempt: run.run_attempt, runNumber: run.run_number,
    status: run.status, conclusion: run.conclusion, createdAt: run.created_at,
    updatedAt: run.updated_at, evidenceUrl: runLink(run) };
}

export async function assessDeployment(read, now) {
  const data = runsSchema.parse(await read(RUNS));
  const runs = data.workflow_runs.sort((a, b) => b.run_number - a.run_number);
  if (runs.some(r => Date.parse(r.updated_at) > now + 60_000 || Date.parse(r.created_at) > now + 60_000)) {
    throw new EvidenceError('future_timestamp');
  }
  const successful = runs.filter(r => r.status === 'completed' && r.conclusion === 'success');
  const deployments = []; const errors = [];
  // Four at a time; at most 20 attempt-specific job requests and no unbounded pagination.
  for (let i = 0; i < successful.length; i += 4) {
    await Promise.all(successful.slice(i, i + 4).map(async run => {
      const url = `${API}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
      try {
        const jobs = jobsSchema.parse(await read(url));
        if (jobs.total_count !== jobs.jobs.length) throw new EvidenceError('jobs_truncated');
        const steps = jobs.jobs.filter(j => j.name === 'update-and-deploy')
          .flatMap(j => j.steps).filter(s => s.name === 'Deploy to GitHub Pages');
        if (steps.length !== 1) throw new EvidenceError('deployment_step_missing_or_ambiguous');
        const step = steps[0];
        if (step.conclusion === 'success') {
          if (!step.completed_at || Date.parse(step.completed_at) > now + 60_000 ||
              Date.parse(step.completed_at) < Date.parse(run.created_at)) throw new EvidenceError('invalid_deployment_timestamp');
          deployments.push({ ...summary(run), completedAt: step.completed_at, runNumber: run.run_number });
        } else if (step.conclusion !== 'skipped') throw new EvidenceError('unexpected_deployment_step');
      } catch (error) { errors.push({ evidenceUrl: url, code: failure(error), runNumber: run.run_number }); }
    }));
  }
  deployments.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  const latest = deployments[0] ?? null;
  const failed = runs.filter(r => r.status === 'completed' && ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(r.conclusion));
  const incidents = failed.map(run => {
    const recovery = deployments.find(d => d.runNumber > run.run_number && Date.parse(d.completedAt) > Date.parse(run.updated_at));
    return { ...summary(run), resolution: recovery ? 'recovered' : 'unresolved', recoveredBy: recovery ?? null };
  });
  const latestCompleted = runs.find(r => r.status === 'completed');
  const age = latestCompleted ? Math.max(0, Math.floor((now - Date.parse(latestCompleted.updated_at)) / 1000)) : null;
  const unresolved = incidents.filter(i => i.resolution === 'unresolved');
  const relevantErrors = errors.filter(e => !latest || e.runNumber >= latest.runNumber);
  let status = 'healthy';
  if (unresolved.length || (age !== null && age > MAX_AGE_SECONDS)) status = 'degraded';
  else if (!latest || !latestCompleted || latestCompleted.conclusion !== 'success' || relevantErrors.length) status = 'unknown';
  return { status, latestRun: runs[0] ? summary(runs[0]) : null,
    latestSuccessfulDeployment: latest, lastCompletedRunAgeSeconds: age,
    staleAfterSeconds: MAX_AGE_SECONDS, unresolvedFailures: unresolved,
    recoveredFailures: incidents.filter(i => i.resolution === 'recovered'), errors,
    coverage: { runsExamined: runs.length, totalRuns: data.total_count, bounded: true,
      oldestRunCreatedAt: runs.at(-1)?.created_at ?? null, attempts: 'latest attempt per run only',
      note: 'Only failures within these 20 recent runs are assessed. Older incidents and superseded attempts are not an incident archive.' },
    evidenceUrl: RUNS };
}

export async function getProjectHealth(env = {}, { read, now = Date.now() } = {}) {
  read ??= createReader(env, { signal: AbortSignal.timeout(25000) });
  const capture = async (url, fn) => {
    try { return await fn(); }
    catch (error) { return { status: 'unknown', code: failure(error), evidenceUrl: url }; }
  };
  const [deployment, publishedCollection, repositoryCollection] = await Promise.all([
    capture(RUNS, () => assessDeployment(read, now)),
    capture(SITE, async () => assessCollection(await read(SITE), now, SITE)),
    capture(COLLECTION, async () => assessCollection(await read(COLLECTION), now, COLLECTION)),
  ]);
  const states = [deployment.status, publishedCollection.status, repositoryCollection.status];
  return { schemaVersion: 1, project: 'roman-mission-monitor', checkedAt: new Date(now).toISOString(),
    status: states.includes('degraded') ? 'degraded' : states.includes('unknown') ? 'unknown' : 'healthy',
    deployment, publishedCollection, repositoryCollection,
    limitations: [
      'A successful workflow is not evidence of deployment unless its Pages deployment step succeeded.',
      'Repository freshness does not prove published freshness. Published JSON is fetched independently.',
      'Freshness measures source checks, not the age of NASA news or mission events.',
      'Checks are not an atomic snapshot: an in-flight deployment can briefly produce differing evidence.',
      'Healthy means these checks passed; it does not validate scientific content or browser rendering.',
    ] };
}
