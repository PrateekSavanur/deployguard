import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';

const config = {
  port: 0,
  host: '127.0.0.1',
  dbPath: ':memory:',
  publicUrl: 'http://dg.test',
  adminPassword: 'hunter2',
  sessionSecret: 'x'.repeat(40),
  sessionTtlHours: 1,
  secureCookies: false,
  healthIntervalSeconds: 60,
  healthTimeoutMs: 1000,
  healthFailureThreshold: 2,
  verifyWindowSeconds: 0,
  verifyIntervalSeconds: 1,
  healthRetentionDays: 14,
  githubToken: '',
  disableScheduler: true,
  logLevel: 'silent',
};

let app;
let cookie;
let probeResult;

beforeEach(async () => {
  probeResult = { ok: true, statusCode: 200, latencyMs: 12, error: null };
  app = await buildApp(config, { logger: false, probe: async () => probeResult });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2' } });
  cookie = res.headers['set-cookie'].split(';')[0];
});
afterEach(() => app.close());

const dash = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } });

async function makeProject(name = 'Shop API') {
  const res = await dash('POST', '/api/projects', { name, repo_url: 'https://gitlab.example.com/acme/shop' });
  assert.equal(res.statusCode, 201);
  return res.json();
}

const ingest = (key, payload) =>
  app.inject({ method: 'POST', url: '/api/v1/deployments', payload, headers: { authorization: `Bearer ${key}` } });

test('dashboard API requires a session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/overview' });
  assert.equal(res.statusCode, 401);
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } });
  assert.equal(bad.statusCode, 401);
});

test('ingestion requires a valid API key', async () => {
  const res = await ingest('dg_bogus', { environment: 'prod', version: '1.0.0' });
  assert.equal(res.statusCode, 401);
});

test('validates payloads', async () => {
  const { api_key } = await makeProject();
  const res = await ingest(api_key.key, { status: 'exploded' });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().details.some((d) => d.includes('environment')));
  assert.ok(res.json().details.some((d) => d.includes('unknown status')));
});

test('started → succeeded lifecycle via external_id, with release summary', async () => {
  const { project, api_key } = await makeProject();
  const start = await ingest(api_key.key, {
    environment: 'production', version: 'v1.0.0', commit_sha: 'aaa111', status: 'started', external_id: 'run-1', deployer: 'asha',
  });
  assert.equal(start.statusCode, 201);
  assert.equal(start.json().status, 'in_progress');

  const done = await ingest(api_key.key, {
    environment: 'production', status: 'success', external_id: 'run-1',
    commits: [
      { sha: 'aaa111', message: 'feat(cart): add coupons', author: 'asha', timestamp: new Date(Date.now() - 3600_000).toISOString() },
      { sha: 'aaa000', message: 'fix!: drop legacy checkout\n\nBREAKING CHANGE: v1 endpoint removed', author: 'ravi' },
      { sha: 'aaa0f0', message: 'Merge pull request #4 from acme/x' },
    ],
  });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().id, start.json().id);
  assert.equal(done.json().status, 'succeeded');
  assert.equal(done.json().version, 'v1.0.0', 'earlier fields are preserved');

  const detail = (await dash('GET', `/api/deployments/${done.json().id}`)).json();
  assert.equal(detail.commits.length, 3);
  assert.equal(detail.summary.changeCount, 2);
  assert.ok(detail.summary.breaking);
  assert.match(detail.summary.markdown, /Features/);
  assert.deepEqual(
    detail.events.map((e) => e.kind),
    ['created', 'in_progress', 'succeeded'],
  );

  const proj = (await dash('GET', `/api/projects/${project.slug}`)).json();
  assert.equal(proj.environments[0].current.version, 'v1.0.0');
  assert.equal(proj.metrics.succeeded, 1);
});

test('late "started" webhook does not reopen a finished deployment', async () => {
  const { api_key } = await makeProject();
  await ingest(api_key.key, { environment: 'prod', version: '1', status: 'failed', external_id: 'r' });
  const late = await ingest(api_key.key, { environment: 'prod', version: '1', status: 'started', external_id: 'r' });
  assert.equal(late.json().status, 'failed');
});

test('detects rollbacks and links previous deployment', async () => {
  const { api_key } = await makeProject();
  await ingest(api_key.key, { environment: 'prod', version: 'v1', commit_sha: 's1' });
  const v2 = (await ingest(api_key.key, { environment: 'prod', version: 'v2', commit_sha: 's2' })).json();
  const back = (await ingest(api_key.key, { environment: 'prod', version: 'v1', commit_sha: 's1' })).json();
  assert.equal(back.is_rollback, true);
  const detail = (await dash('GET', `/api/deployments/${back.id}`)).json();
  assert.equal(detail.previous.id, v2.id);
  // Redeploying the same version is not a rollback
  const again = (await ingest(api_key.key, { environment: 'prod', version: 'v1', commit_sha: 's1' })).json();
  assert.equal(again.is_rollback, false);
});

test('compare URL is generated for GitHub repos', async () => {
  const res = await dash('POST', '/api/projects', { name: 'Web', repo_url: 'https://github.com/acme/web' });
  const key = res.json().api_key.key;
  await ingest(key, { environment: 'prod', version: 'v1', commit_sha: 'abc', commits: [{ sha: 'abc', message: 'x' }] });
  const d = (await ingest(key, { environment: 'prod', version: 'v2', commit_sha: 'def', commits: [{ sha: 'def', message: 'y' }] })).json();
  const detail = (await dash('GET', `/api/deployments/${d.id}`)).json();
  assert.equal(detail.deployment.compare_url, 'https://github.com/acme/web/compare/abc...def');
});

test('post-deploy verification marks unhealthy deploy and env down', async () => {
  const { api_key } = await makeProject();
  const d = (
    await ingest(api_key.key, { environment: 'prod', version: 'v3', health_url: 'http://svc.test/healthz' })
  ).json();
  assert.equal(d.verification, 'verifying');

  probeResult = { ok: false, statusCode: 503, latencyMs: 5, error: null };
  const env = app.db.prepare('SELECT * FROM environments').get();
  await app.health.checkEnvironment(env);
  await app.health.checkEnvironment(env);

  const gate = await app.inject({
    method: 'GET', url: `/api/v1/deployments/${d.id}`, headers: { authorization: `Bearer ${api_key.key}` },
  });
  assert.equal(gate.json().verification, 'unhealthy');
  assert.equal(app.db.prepare('SELECT health_status FROM environments').get().health_status, 'down');

  const overview = (await dash('GET', '/api/overview')).json();
  assert.equal(overview.attention.length, 1);
  assert.equal(overview.metrics.failed, 1, 'unhealthy deploy counts toward change failure rate');
});

test('verification passes after the window when checks are healthy', async () => {
  const { api_key } = await makeProject();
  const d = (await ingest(api_key.key, { environment: 'prod', version: 'v4', health_url: 'http://svc.test/' })).json();
  const env = app.db.prepare('SELECT * FROM environments').get();
  await app.health.checkEnvironment(env);
  const detail = (await dash('GET', `/api/deployments/${d.id}`)).json();
  assert.equal(detail.deployment.verification, 'healthy');
  assert.equal(detail.checks.length, 1);
});

test('alert channels: validation, redaction and delivery log', async () => {
  const bad = await dash('POST', '/api/channels', { name: 'x', type: 'slack', config: {} });
  assert.equal(bad.statusCode, 400);
  const ok = await dash('POST', '/api/channels', {
    name: 'Ops', type: 'webhook', config: { url: 'http://127.0.0.1:9/nope', secret: 'shh' },
  });
  assert.equal(ok.statusCode, 201);
  assert.ok(!JSON.stringify(ok.json()).includes('shh'));

  const { api_key } = await makeProject();
  await ingest(api_key.key, { environment: 'prod', version: 'v1', status: 'failed' });
  // delivery is async; give it a moment to fail against the closed port
  for (let i = 0; i < 50 && !app.db.prepare('SELECT COUNT(*) n FROM alert_log').get().n; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const log = (await dash('GET', '/api/alerts')).json();
  assert.equal(log[0].kind, 'deploy_failed');
  assert.equal(log[0].delivered, 0);
});

test('mutating dashboard requests must be JSON (CSRF guard)', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/projects', payload: 'name=evil', headers: { cookie, 'content-type': 'text/plain' },
  });
  assert.equal(res.statusCode, 415);
});

test('status-only update needs an existing external_id', async () => {
  const { api_key } = await makeProject();
  const res = await ingest(api_key.key, { environment: 'prod', status: 'succeeded', external_id: 'never-started' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /version or commit_sha is required/);
});

test('serves the dashboard and health endpoint without auth', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().status, 'ok');
});
