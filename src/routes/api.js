// Dashboard API (session cookie auth).
import { createApiKey } from '../auth.js';
import { ALERT_KINDS, CHANNEL_TYPES, buildMessage, redactChannel, sendToChannel, validateChannel } from '../services/alerts.js';
import { getDeployment, githubRepo, slugify } from '../services/deployments.js';
import { computeMetrics } from '../services/metrics.js';
import { buildSummary } from '../services/summary.js';

export default async function apiRoutes(app, { db, config, health, auth }) {
  app.addHook('onRequest', async (request, reply) => {
    if (!auth.isValid(request)) return reply.code(401).send({ error: 'not signed in' });
    // CSRF guard: mutating requests must be JSON (cross-site forms can't send that without CORS).
    if (['POST', 'PATCH', 'PUT'].includes(request.method) && !request.headers['content-type']?.startsWith('application/json')) {
      return reply.code(415).send({ error: 'expected application/json' });
    }
  });

  const findProject = (slug) => db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  const notFound = (reply, what = 'not found') => reply.code(404).send({ error: what });

  function environmentsFor(projectId) {
    const envs = db.prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY position, name').all(projectId);
    const current = db.prepare(
      `SELECT * FROM deployments WHERE environment_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
    );
    const latest = db.prepare('SELECT * FROM deployments WHERE environment_id = ? ORDER BY id DESC LIMIT 1');
    const lastCheck = db.prepare('SELECT ok, status_code, latency_ms, error, at FROM health_checks WHERE environment_id = ? ORDER BY id DESC LIMIT 1');
    return envs.map((e) => ({
      ...e,
      current: current.get(e.id) || null,
      latest: latest.get(e.id) || null,
      last_check: lastCheck.get(e.id) || null,
    }));
  }

  // ── Overview ────────────────────────────────────────────────────
  app.get('/overview', async () => {
    const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
    const recent = db
      .prepare(
        `SELECT d.*, e.name AS environment, p.name AS project_name, p.slug AS project_slug
           FROM deployments d JOIN environments e ON e.id = d.environment_id JOIN projects p ON p.id = d.project_id
          ORDER BY d.id DESC LIMIT 15`,
      )
      .all();
    const attention = db
      .prepare(
        `SELECT d.*, e.name AS environment, p.name AS project_name, p.slug AS project_slug
           FROM deployments d JOIN environments e ON e.id = d.environment_id JOIN projects p ON p.id = d.project_id
          WHERE d.id IN (SELECT MAX(id) FROM deployments GROUP BY environment_id)
            AND (d.status IN ('failed','rolled_back') OR d.verification = 'unhealthy')
          ORDER BY d.id DESC`,
      )
      .all();
    const down = db
      .prepare(
        `SELECT e.*, p.name AS project_name, p.slug AS project_slug FROM environments e JOIN projects p ON p.id = e.project_id
          WHERE e.health_status = 'down'`,
      )
      .all();
    return {
      projects: projects.map((p) => ({ ...p, environments: environmentsFor(p.id) })),
      recent,
      attention,
      down,
      metrics: computeMetrics(db, { days: 30 }),
    };
  });

  // ── Projects ────────────────────────────────────────────────────
  app.post('/projects', async (request, reply) => {
    const name = String(request.body?.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const slug = slugify(request.body?.slug || name);
    if (!slug) return reply.code(400).send({ error: 'name must contain letters or numbers' });
    if (findProject(slug)) return reply.code(409).send({ error: `a project with slug "${slug}" already exists` });
    const repoUrl = request.body?.repo_url?.trim() || null;
    if (repoUrl && !/^https?:\/\//.test(repoUrl)) return reply.code(400).send({ error: 'repo_url must be an http(s) URL' });
    const { lastInsertRowid } = db.prepare('INSERT INTO projects (name, slug, repo_url) VALUES (?, ?, ?)').run(name, slug, repoUrl);
    const key = createApiKey(db, Number(lastInsertRowid), 'default');
    return reply.code(201).send({ project: findProject(slug), api_key: key });
  });

  app.get('/projects/:slug', async (request, reply) => {
    const project = findProject(request.params.slug);
    if (!project) return notFound(reply);
    const days = Math.min(Number(request.query.days) || 30, 365);
    return {
      project,
      github: Boolean(githubRepo(project.repo_url)),
      environments: environmentsFor(project.id),
      keys: db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE project_id = ? ORDER BY id').all(project.id),
      metrics: computeMetrics(db, { projectId: project.id, days }),
    };
  });

  app.patch('/projects/:slug', async (request, reply) => {
    const project = findProject(request.params.slug);
    if (!project) return notFound(reply);
    const name = request.body?.name?.trim() || project.name;
    const repoUrl = request.body?.repo_url === undefined ? project.repo_url : request.body.repo_url?.trim() || null;
    if (repoUrl && !/^https?:\/\//.test(repoUrl)) return reply.code(400).send({ error: 'repo_url must be an http(s) URL' });
    db.prepare('UPDATE projects SET name = ?, repo_url = ? WHERE id = ?').run(name, repoUrl, project.id);
    return findProject(project.slug);
  });

  app.delete('/projects/:slug', async (request, reply) => {
    const project = findProject(request.params.slug);
    if (!project) return notFound(reply);
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    return reply.code(204).send();
  });

  // ── API keys ────────────────────────────────────────────────────
  app.post('/projects/:slug/keys', async (request, reply) => {
    const project = findProject(request.params.slug);
    if (!project) return notFound(reply);
    const name = String(request.body?.name || 'ci').slice(0, 60);
    return reply.code(201).send(createApiKey(db, project.id, name));
  });

  app.delete('/keys/:id', async (request, reply) => {
    const { changes } = db.prepare('DELETE FROM api_keys WHERE id = ?').run(Number(request.params.id));
    return changes ? reply.code(204).send() : notFound(reply);
  });

  // ── Environments ────────────────────────────────────────────────
  app.patch('/environments/:id', async (request, reply) => {
    const env = db.prepare('SELECT * FROM environments WHERE id = ?').get(Number(request.params.id));
    if (!env) return notFound(reply);
    const body = request.body || {};
    let healthUrl = env.health_url;
    if (body.health_url !== undefined) {
      healthUrl = body.health_url?.trim() || null;
      if (healthUrl && !/^https?:\/\//.test(healthUrl)) return reply.code(400).send({ error: 'health_url must be an http(s) URL' });
    }
    const position = Number.isInteger(body.position) ? body.position : env.position;
    const reset = healthUrl !== env.health_url;
    db.prepare(
      `UPDATE environments SET health_url = ?, position = ?,
         health_status = CASE WHEN ? THEN 'unknown' ELSE health_status END,
         consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures END
       WHERE id = ?`,
    ).run(healthUrl, position, reset ? 1 : 0, reset ? 1 : 0, env.id);
    return db.prepare('SELECT * FROM environments WHERE id = ?').get(env.id);
  });

  app.delete('/environments/:id', async (request, reply) => {
    const { changes } = db.prepare('DELETE FROM environments WHERE id = ?').run(Number(request.params.id));
    return changes ? reply.code(204).send() : notFound(reply);
  });

  app.post('/environments/:id/check', async (request, reply) => {
    const env = db.prepare('SELECT * FROM environments WHERE id = ?').get(Number(request.params.id));
    if (!env) return notFound(reply);
    if (!env.health_url) return reply.code(400).send({ error: 'environment has no health_url' });
    return health.checkEnvironment(env);
  });

  app.get('/environments/:id/health', async (request) => {
    const hours = Math.min(Number(request.query.hours) || 24, 24 * 14);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const checks = db
      .prepare('SELECT ok, status_code, latency_ms, error, at FROM health_checks WHERE environment_id = ? AND at >= ? ORDER BY at')
      .all(Number(request.params.id), since);
    const ok = checks.filter((c) => c.ok).length;
    return { hours, checks, uptime: checks.length ? ok / checks.length : null };
  });

  // ── Deployments ─────────────────────────────────────────────────
  app.get('/deployments', async (request) => {
    const q = request.query;
    const where = [];
    const params = [];
    if (q.project) {
      where.push('p.slug = ?');
      params.push(q.project);
    }
    if (q.environment) {
      where.push('e.name = ?');
      params.push(q.environment);
    }
    if (q.status === 'problem') {
      where.push(`(d.status IN ('failed','rolled_back') OR d.verification = 'unhealthy')`);
    } else if (q.status) {
      where.push('d.status = ?');
      params.push(q.status);
    }
    if (q.q) {
      where.push('(d.version LIKE ? OR d.commit_sha LIKE ? OR d.deployer LIKE ? OR d.branch LIKE ?)');
      const like = `%${q.q}%`;
      params.push(like, like, like, like);
    }
    if (q.before) {
      where.push('d.id < ?');
      params.push(Number(q.before));
    }
    const limit = Math.min(Number(q.limit) || 50, 200);
    const rows = db
      .prepare(
        `SELECT d.*, e.name AS environment, p.name AS project_name, p.slug AS project_slug,
                (SELECT COUNT(*) FROM deployment_commits c WHERE c.deployment_id = d.id) AS commit_count
           FROM deployments d JOIN environments e ON e.id = d.environment_id JOIN projects p ON p.id = d.project_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY d.id DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    return { deployments: rows.slice(0, limit), has_more: rows.length > limit };
  });

  app.get('/deployments/:id', async (request, reply) => {
    const deployment = getDeployment(db, Number(request.params.id));
    if (!deployment) return notFound(reply);
    const commits = db.prepare('SELECT * FROM deployment_commits WHERE deployment_id = ? ORDER BY id').all(deployment.id);
    const events = db.prepare('SELECT * FROM deployment_events WHERE deployment_id = ? ORDER BY id').all(deployment.id);
    const checks = db
      .prepare('SELECT ok, status_code, latency_ms, error, at FROM health_checks WHERE deployment_id = ? ORDER BY id')
      .all(deployment.id);
    const previous = deployment.previous_deployment_id ? getDeployment(db, deployment.previous_deployment_id) : null;
    const next = db
      .prepare('SELECT id FROM deployments WHERE environment_id = ? AND id > ? ORDER BY id LIMIT 1')
      .get(deployment.environment_id, deployment.id);
    const alerts = db.prepare('SELECT * FROM alert_log WHERE deployment_id = ? ORDER BY id').all(deployment.id);
    return {
      deployment: { ...deployment, metadata: deployment.metadata ? JSON.parse(deployment.metadata) : null },
      commits,
      events,
      checks,
      previous,
      next_id: next?.id ?? null,
      alerts,
      summary: buildSummary(deployment, commits, previous),
    };
  });

  // ── Alert channels ──────────────────────────────────────────────
  app.get('/channels', async () => ({
    channels: db.prepare('SELECT * FROM alert_channels ORDER BY id').all().map(redactChannel),
    kinds: ALERT_KINDS,
    types: Object.keys(CHANNEL_TYPES),
  }));

  app.post('/channels', async (request, reply) => {
    const { errors, value } = validateChannel(request.body);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO alert_channels (name, type, config, events, project_id) VALUES (?, ?, ?, ?, ?)')
      .run(value.name, value.type, JSON.stringify(value.config), JSON.stringify(value.events), value.projectId);
    return reply.code(201).send(redactChannel(db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(lastInsertRowid)));
  });

  app.patch('/channels/:id', async (request, reply) => {
    const ch = db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(Number(request.params.id));
    if (!ch) return notFound(reply);
    const body = request.body || {};
    const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : ch.enabled;
    let events = JSON.parse(ch.events);
    if (Array.isArray(body.events)) {
      const unknown = body.events.filter((e) => !ALERT_KINDS[e]);
      if (unknown.length) return reply.code(400).send({ error: `unknown events: ${unknown.join(', ')}` });
      events = body.events;
    }
    db.prepare('UPDATE alert_channels SET enabled = ?, events = ? WHERE id = ?').run(enabled, JSON.stringify(events), ch.id);
    return redactChannel(db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(ch.id));
  });

  app.delete('/channels/:id', async (request, reply) => {
    const { changes } = db.prepare('DELETE FROM alert_channels WHERE id = ?').run(Number(request.params.id));
    return changes ? reply.code(204).send() : notFound(reply);
  });

  app.post('/channels/:id/test', async (request, reply) => {
    const ch = db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(Number(request.params.id));
    if (!ch) return notFound(reply);
    const ctx = {
      project: { name: 'DeployGuard', slug: 'deployguard' },
      environment: { name: 'test' },
      detail: 'This is a test alert. If you can read it, the channel works.',
    };
    const msg = buildMessage('deploy_succeeded', ctx, config.publicUrl);
    msg.title = '🔔 DeployGuard test alert';
    try {
      await sendToChannel(ch.type, JSON.parse(ch.config), 'test', msg, ctx);
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });

  app.get('/alerts', async (request) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    return db
      .prepare(
        `SELECT a.*, c.name AS channel_name, c.type AS channel_type FROM alert_log a
           LEFT JOIN alert_channels c ON c.id = a.channel_id ORDER BY a.id DESC LIMIT ?`,
      )
      .all(limit);
  });
}
