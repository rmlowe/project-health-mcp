import { RUNS, COLLECTION, SITE } from '../src/health.js';
export const now = Date.parse('2026-10-30T16:00:00Z');
export function collection(at = '2026-10-30T15:20:00Z') {
  return { schemaVersion: 1, lastSuccessfulCheckAt: at, sources: {
    romanBlog: { lastSuccessfulCheckAt: at }, romanCommissioning: { lastSuccessfulCheckAt: at },
  } };
}
export function run(n, conclusion = 'success', at = '2026-10-30T15:21:00Z') {
  return { id: n, run_number: n, run_attempt: 1, head_branch: 'main', event: 'schedule',
    status: 'completed', conclusion, created_at: at, updated_at: at };
}
export function jobs(conclusion = 'success', completed = '2026-10-30T15:22:00Z') {
  return { total_count: 1, jobs: [{ name: 'update-and-deploy', steps: [
    { name: 'Deploy to GitHub Pages', conclusion, completed_at: completed },
  ] }] };
}
export function fixture({ runs = [run(3), run(2, 'failure', '2026-10-30T14:24:00Z')],
  published = collection(), repository = collection(), job = jobs() } = {}) {
  return async url => {
    if (url === RUNS) return { total_count: runs.length, workflow_runs: runs };
    if (url === SITE) { if (published instanceof Error) throw published; return published; }
    if (url === COLLECTION) return repository;
    return typeof job === 'function' ? job(url) : job;
  };
}
