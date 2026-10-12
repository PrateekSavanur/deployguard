// Declarative setup from a JSON file (BOOTSTRAP_PATH), applied on every start, so a
// GitOps-managed install (e.g. a Kubernetes ConfigMap) needs no clicking around:
//
// {
//   "projects": [
//     { "slug": "homelert", "name": "Homelert", "repo_url": "https://github.com/acme/homelert",
//       "environments": [{ "name": "homelab", "health_url": "http://homelert.homelert.svc.cluster.local/health" }] }
//   ],
//   "channels": [
//     { "name": "Homelert", "type": "webhook", "config": { "url": "http://…/webhook/deployguard" },
//       "events": ["deploy_failed", "verification_failed"], "project": null }
//   ]
// }
//
// The file wins for anything it declares (health URLs, channel settings); things it doesn't
// mention are left alone. Strings in channel config may reference env vars as ${NAME}.
import { readFileSync } from 'node:fs';
import { tx } from './db.js';
import { validateChannel } from './services/alerts.js';
import { ensureProject, getOrCreateEnvironment } from './services/deployments.js';

const expandEnv = (value) =>
  typeof value === 'string' ? value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '') : value;

export function applyBootstrap(db, spec, log) {
  const summary = { projects: 0, environments: 0, channels: 0 };
  tx(db, () => {
    for (const p of spec.projects || []) {
      if (!p.slug) throw new Error('bootstrap: every project needs a slug');
      const project = ensureProject(db, { slug: p.slug, name: p.name, repoUrl: p.repo_url });
      const name = p.name || project.name;
      const repoUrl = p.repo_url ?? project.repo_url;
      db.prepare('UPDATE projects SET name = ?, repo_url = ? WHERE id = ?').run(name, repoUrl, project.id);
      summary.projects++;

      for (const e of p.environments || []) {
        if (!e.name) throw new Error(`bootstrap: environment without a name in project ${p.slug}`);
        if (e.health_url && !/^https?:\/\//.test(e.health_url)) {
          throw new Error(`bootstrap: health_url for ${p.slug}/${e.name} must be an http(s) URL`);
        }
        const env = getOrCreateEnvironment(db, project.id, e.name);
        const healthUrl = e.health_url || null;
        const position = Number.isInteger(e.position) ? e.position : env.position;
        if (healthUrl !== env.health_url) {
          db.prepare(
            `UPDATE environments SET health_url = ?, health_status = 'unknown', consecutive_failures = 0 WHERE id = ?`,
          ).run(healthUrl, env.id);
        }
        db.prepare('UPDATE environments SET position = ? WHERE id = ?').run(position, env.id);
        summary.environments++;
      }
    }

    for (const c of spec.channels || []) {
      const projectId = c.project
        ? db.prepare('SELECT id FROM projects WHERE slug = ?').get(c.project)?.id
        : null;
      if (c.project && !projectId) throw new Error(`bootstrap: channel "${c.name}" refers to unknown project "${c.project}"`);
      const config = Object.fromEntries(Object.entries(c.config || {}).map(([k, v]) => [k, expandEnv(v)]));
      const { errors, value } = validateChannel({ ...c, config, project_id: projectId });
      if (errors.length) throw new Error(`bootstrap: channel "${c.name}": ${errors.join('; ')}`);
      const enabled = c.enabled === false ? 0 : 1;
      const existing = db.prepare('SELECT id FROM alert_channels WHERE name = ?').get(value.name);
      if (existing) {
        db.prepare('UPDATE alert_channels SET type = ?, config = ?, events = ?, project_id = ?, enabled = ? WHERE id = ?').run(
          value.type, JSON.stringify(value.config), JSON.stringify(value.events), projectId, enabled, existing.id,
        );
      } else {
        db.prepare('INSERT INTO alert_channels (name, type, config, events, project_id, enabled) VALUES (?, ?, ?, ?, ?, ?)').run(
          value.name, value.type, JSON.stringify(value.config), JSON.stringify(value.events), projectId, enabled,
        );
      }
      summary.channels++;
    }
  });
  log?.info(summary, 'bootstrap applied');
  return summary;
}

export function loadBootstrapFile(db, path, log) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`bootstrap: cannot read ${path}: ${err.message}`);
  }
  return applyBootstrap(db, spec, log);
}

// Kubernetes rewrites mounted ConfigMaps in place (~1 min after a change); re-apply when the content changes.
export function watchBootstrapFile(db, path, log, intervalMs = 30_000) {
  let last = readFileSync(path, 'utf8');
  const timer = setInterval(() => {
    let current;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      return; // mid-swap of the ConfigMap symlink; try again next tick
    }
    if (current === last) return;
    last = current;
    try {
      applyBootstrap(db, JSON.parse(current), log);
    } catch (err) {
      log.error({ err: err.message }, 'bootstrap reload failed — keeping previous settings');
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
