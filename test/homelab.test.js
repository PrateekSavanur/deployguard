// Integration key (Argo CD Notifications) + declarative bootstrap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';
import { applyBootstrap } from '../src/bootstrap.js';

const INTEGRATION_KEY = 'dg_integration_test_key_0123456789';
const dir = mkdtempSync(join(tmpdir(), 'dg-test-'));
const bootstrapPath = join(dir, 'bootstrap.json');
process.env.DG_TEST_HOOK = 'http://homelert.test/webhook/deployguard';
writeFileSync(
  bootstrapPath,
  JSON.stringify({
    projects: [
      {
        slug: 'homelert', name: 'Homelert', repo_url: 'https://github.com/acme/homelert',
        environments: [{ name: 'homelab', health_url: 'http://homelert.homelert.svc.cluster.local/health' }],
      },
    ],
    channels: [{ name: 'Homelert', type: 'webhook', config: { url: '${DG_TEST_HOOK}' }, events: ['deploy_failed'] }],
  }),
);

let app;
let cookie;
before(async () => {
  app = await buildApp(
    {
      port: 0, host: '127.0.0.1', dbPath: ':memory:', publicUrl: '', adminPassword: 'pw', sessionSecret: 's'.repeat(40),
      sessionTtlHours: 1, secureCookies: false, healthIntervalSeconds: 60, healthTimeoutMs: 1000, healthFailureThreshold: 3,
      verifyWindowSeconds: 300, verifyIntervalSeconds: 15, healthRetentionDays: 14, githubToken: '',
      integrationApiKey: INTEGRATION_KEY, bootstrapPath, disableScheduler: true, logLevel: 'silent',
    },
    { logger: false, probe: async () => ({ ok: true, statusCode: 200, latencyMs: 1, error: null }) },
  );
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'pw' } });
  cookie = res.headers['set-cookie'].split(';')[0];
});
after(() => app.close());

const argo = (payload) =>
  app.inject({ method: 'POST', url: '/api/v1/deployments', payload, headers: { authorization: `Bearer ${INTEGRATION_KEY}` } });

test('bootstrap creates projects, health URLs and channels with env expansion', async () => {
  const p = (await app.inject({ method: 'GET', url: '/api/projects/homelert', headers: { cookie } })).json();
  assert.equal(p.project.repo_url, 'https://github.com/acme/homelert');
  assert.equal(p.environments[0].health_url, 'http://homelert.homelert.svc.cluster.local/health');
  const ch = app.db.prepare('SELECT * FROM alert_channels').all();
  assert.equal(ch.length, 1);
  assert.equal(JSON.parse(ch[0].config).url, 'http://homelert.test/webhook/deployguard');
});

test('bootstrap is idempotent and the file wins for what it declares', () => {
  app.db.prepare(`UPDATE environments SET health_url = 'http://changed/'`).run();
  applyBootstrap(app.db, JSON.parse(JSON.stringify({
    projects: [{ slug: 'homelert', environments: [{ name: 'homelab', health_url: 'http://homelert.homelert.svc.cluster.local/health' }] }],
    channels: [{ name: 'Homelert', type: 'webhook', config: { url: 'http://x/' }, events: ['env_down'] }],
  })));
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM alert_channels').get().n, 1);
  assert.equal(app.db.prepare('SELECT health_url FROM environments').get().health_url, 'http://homelert.homelert.svc.cluster.local/health');
  assert.deepEqual(JSON.parse(app.db.prepare('SELECT events FROM alert_channels').get().events), ['env_down']);
  assert.equal(app.db.prepare('SELECT name FROM projects').get().name, 'Homelert', 'name is kept when omitted');
});

test('bootstrap rejects bad specs atomically', () => {
  assert.throws(() => applyBootstrap(app.db, { projects: [{ slug: 'ok-one' }, { name: 'no slug' }] }), /slug/);
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM projects WHERE slug = 'ok-one'`).get().n, 0);
});

test('integration key reports for any project and auto-creates it', async () => {
  const missing = await argo({ environment: 'homelab', commit_sha: 'abc' });
  assert.equal(missing.statusCode, 400);

  const start = await argo({
    project: 'portfolio', environment: 'homelab', commit_sha: 'a1b2c3d4', status: 'started', source: 'argocd',
    external_id: 'portfolio-2026-10-12T10:00:00Z', repo_url: 'https://github.com/acme/portfolio.git',
  });
  assert.equal(start.statusCode, 201);
  assert.equal(start.json().project, 'portfolio');
  const done = await argo({ project: 'portfolio', environment: 'homelab', status: 'succeeded', external_id: 'portfolio-2026-10-12T10:00:00Z' });
  assert.equal(done.json().id, start.json().id);
  assert.equal(done.json().status, 'succeeded');

  const project = app.db.prepare(`SELECT * FROM projects WHERE slug = 'portfolio'`).get();
  assert.equal(project.repo_url, 'https://github.com/acme/portfolio.git');

  // Existing bootstrap project is reused, not duplicated
  const hl = await argo({ project: 'homelert', environment: 'homelab', commit_sha: 'fff111', status: 'succeeded' });
  assert.equal(hl.json().verification, 'verifying', 'bootstrap health URL drives verification');
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM projects WHERE slug = 'homelert'`).get().n, 1);

  const gate = await app.inject({
    method: 'GET', url: `/api/v1/deployments/${hl.json().id}`, headers: { authorization: `Bearer ${INTEGRATION_KEY}` },
  });
  assert.equal(gate.statusCode, 200);
});
