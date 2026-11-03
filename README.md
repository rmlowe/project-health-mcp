# Project Health MCP

Read-only Cloudflare Worker reporting deployment health, collection freshness and recovery evidence. First supported project: **Roman Mission Monitor**. No database, scheduler, dashboard or automatic remediation.

## Tool

`get_project_health({ "project": "roman-mission-monitor" })` (project may be omitted).

Returns `healthy`, `degraded` or `unknown`, a check timestamp, independent deployment/published/repository checks, unresolved and recovered failures, and evidence URLs. Partial results survive upstream failures. A known degraded check takes precedence over unknown checks; inspect the component results too.

- **Deployment:** query the latest 20 runs of `update-mission.yml` on `main`. Verify the named `Deploy to GitHub Pages` step in `update-and-deploy` for successful runs, using the exact attempt. A green run with a skipped deployment is not deployment evidence. A failure is recovered only when a higher-numbered run has a verified deployment completed after the failure. Cancelled/in-progress runs never clear failures. A cancelled latest completed run produces unknown unless another known failure already makes the result degraded.
- **Published collection:** read `https://rmlowe.github.io/roman-mission-monitor/health.json`, shipped with the site. The companion Roman change must be deployed first; until then this check is unknown (typically HTTP 404).
- **Repository collection:** read `data/collection-health.json` from `main` independently. Fresh repository data cannot substitute for published freshness.
- **Freshness:** use the oldest aggregate/blog/commissioning successful-check timestamp. More than three hours old is degraded. The same tolerance applies to the last completed workflow. This matches Roman's hourly schedule and existing three-hour policy. Future timestamps beyond 60 seconds, missing sources and schema mismatches are unknown. NASA article age is irrelevant.

Coverage is bounded, not an incident archive. Only the latest attempt of each returned run is assessed; a successful rerun hides its prior failed attempt. Failures older than the 20-run window are not listed. Healthy does not validate scientific interpretation or browser rendering. Checks are not an atomic snapshot; retry if deployment is in flight.

## Local validation

Node.js 24 or newer:

```sh
npm ci
npm test
npm run build
```

Tests cover recovery, skipped deployments, stale published data despite green pipelines, partial outages, malformed/future evidence, bounded coverage, request limits, credential isolation, Access JWT verification and MCP calls. A workerd test exercises native fetch options to catch the redirect incompatibility previously encountered with Workers.

For local MCP clients, set `.dev.vars` (gitignored):

```text
MCP_AUTH_MODE=bearer
MCP_AUTH_TOKEN=<a-random-token-of-at-least-32-characters>
```

Then `npm run dev`; use `http://localhost:8787/mcp` with that bearer token.

## Deploy

1. Merge and deploy the [companion Roman health endpoint](https://github.com/rmlowe/roman-mission-monitor/pull/7). Verify its JSON matches the collection snapshot shipped with the site.
2. Run `npm ci`, `npx wrangler login`, then `npm run deploy`. Committed configuration deliberately disables `/mcp` (404).
3. Protect **all traffic** to `project-health-mcp` with Cloudflare Access and the existing approved-user policy. Enable Managed OAuth on this new application with the same client redirect URLs as TfL/Last.fm.
4. Replace `vars` in `wrangler.jsonc` with:

```json
"vars": {
  "MCP_AUTH_MODE": "access",
  "MCP_ACCESS_TEAM_DOMAIN": "https://YOUR-TEAM.cloudflareaccess.com",
  "MCP_ACCESS_AUD": "THIS-NEW-APPLICATION-AUDIENCE"
}
```

5. Optionally set a dedicated GitHub token using `npx wrangler secret put GITHUB_TOKEN`. Use a fine-grained token limited to `rmlowe/roman-mission-monitor`, **Actions: read** and **Contents: read** (plus mandatory metadata). No writes are needed. Public evidence works without a token, but up to 23 HTTP requests per check (22 to GitHub) can exhaust the shared unauthenticated allowance quickly. A token is recommended for routine use. Never commit it or paste it into chat.
6. Run `npm run deploy` again. Add `https://project-health-mcp.<your-workers-subdomain>.workers.dev/mcp` to your client with OAuth.

The team domain and audience are non-secret; commit the configuration after setup. Preview URLs and observability are disabled. Access assertions are cryptographically verified against the configured issuer/audience; no shared-token fallback in Access mode. Missing/invalid configuration fails closed.

Outbound endpoints are fixed in code. GitHub credentials never go to Pages or redirects. Requests have eight-second timeouts, a shared 25-second check deadline, a two-megabyte response limit and at most four concurrent job lookups. Raw upstream errors, tokens and logs are not returned. Rate limits produce unknown evidence, not healthy results.

## Acceptance check

> Use Project Health to check Roman Mission Monitor. Separate deployment health from published freshness, explain unresolved or recovered failures, and include evidence links and the history window.

Compare a live result with GitHub Actions and the published JSON after deployment. Fixture tests validate the October failure-and-recovery pattern; they do not replace this live check. This repository does not deploy automatically on merge; CI only tests and builds the Worker.
