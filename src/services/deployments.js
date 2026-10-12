// Deployment ingestion: normalises CI payloads, tracks the status state machine,
// links each deploy to the previous one in the same environment ("what changed"),
// detects rollbacks and kicks off post-deploy health verification.
import { now, tx } from '../db.js';

const STATUS_ALIASES = {
  queued: 'queued', pending: 'queued', waiting: 'queued',
  started: 'in_progress', start: 'in_progress', running: 'in_progress', in_progress: 'in_progress', deploying: 'in_progress',
  succeeded: 'succeeded', success: 'succeeded', successful: 'succeeded', completed: 'succeeded', deployed: 'succeeded', healthy: 'succeeded',
  failed: 'failed', failure: 'failed', error: 'failed', errored: 'failed', degraded: 'failed',
  rolled_back: 'rolled_back', rollback: 'rolled_back', reverted: 'rolled_back',
  cancelled: 'cancelled', canceled: 'cancelled', aborted: 'cancelled', skipped: 'cancelled',
};
export const TERMINAL = new Set(['succeeded', 'failed', 'rolled_back', 'cancelled']);

// Default ordering for the environment matrix (lower = earlier in the pipeline).
const ENV_POSITIONS = {
  local: 0, dev: 10, develop: 10, development: 10, test: 20, testing: 20, qa: 20, ci: 20,
  staging: 30, stage: 30, uat: 30, preprod: 40, 'pre-prod': 40, prod: 50, production: 50, live: 50,
};

export function normalizeStatus(raw) {
  if (!raw) return 'succeeded';
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_ALIASES[key] || null;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function githubRepo(repoUrl) {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/.exec(repoUrl || '');
  return m ? { owner: m[1], repo: m[2], web: `https://github.com/${m[1]}/${m[2]}` } : null;
}

// Find a project by slug, creating it if needed. A repo URL fills in a missing one but never replaces it.
export function ensureProject(db, { slug, name, repoUrl }) {
  const cleanSlug = slugify(slug);
  if (!cleanSlug) throw Object.assign(new Error('project must contain letters or numbers'), { statusCode: 400 });
  const url = repoUrl && /^https?:\/\//.test(repoUrl) ? String(repoUrl).slice(0, 500) : null;
  let project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(cleanSlug);
  if (!project) {
    db.prepare('INSERT INTO projects (name, slug, repo_url) VALUES (?, ?, ?)').run(
      String(name || slug).slice(0, 100), cleanSlug, url,
    );
    project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(cleanSlug);
  } else if (url && !project.repo_url) {
    db.prepare('UPDATE projects SET repo_url = ? WHERE id = ?').run(url, project.id);
    project.repo_url = url;
  }
  return project;
}

export function getOrCreateEnvironment(db, projectId, name) {
  const existing = db.prepare('SELECT * FROM environments WHERE project_id = ? AND name = ?').get(projectId, name);
  if (existing) return existing;
  const position = ENV_POSITIONS[name.toLowerCase()] ?? 25;
  db.prepare('INSERT INTO environments (project_id, name, position) VALUES (?, ?, ?)').run(projectId, name, position);
  return db.prepare('SELECT * FROM environments WHERE project_id = ? AND name = ?').get(projectId, name);
}

function cleanString(value, max = 500) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, max);
}

function cleanTime(value) {
  if (!value) return null;
  const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function validatePayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { errors: ['body must be a JSON object'] };
  const environment = cleanString(body.environment ?? body.env, 60);
  if (!environment) errors.push('environment is required');
  const status = normalizeStatus(body.status);
  if (!status) errors.push(`unknown status "${body.status}"`);
  // Follow-up status updates may carry only external_id; new deploys are checked in recordDeployment.
  if (!body.version && !body.commit_sha && !body.sha && !(body.external_id ?? body.run_id)) {
    errors.push('version or commit_sha is required');
  }
  if (body.commits !== undefined && !Array.isArray(body.commits)) errors.push('commits must be an array');
  if (body.health_url && !/^https?:\/\//.test(body.health_url)) errors.push('health_url must be an http(s) URL');
  if (errors.length) return { errors };

  return {
    data: {
      environment,
      status,
      externalId: cleanString(body.external_id ?? body.run_id, 200),
      version: cleanString(body.version, 120),
      commitSha: cleanString(body.commit_sha ?? body.sha, 64),
      branch: cleanString(body.branch ?? body.ref, 200),
      deployer: cleanString(body.deployer ?? body.actor ?? body.author, 120),
      source: cleanString(body.source, 40) || 'api',
      ciUrl: cleanString(body.ci_url ?? body.url, 1000),
      message: cleanString(body.message ?? body.description, 2000),
      rollback: body.rollback === true || body.is_rollback === true,
      healthUrl: cleanString(body.health_url, 1000),
      startedAt: cleanTime(body.started_at),
      finishedAt: cleanTime(body.finished_at),
      metadata: body.metadata && typeof body.metadata === 'object' ? JSON.stringify(body.metadata).slice(0, 10_000) : null,
      commits: (body.commits || []).slice(0, 500).map((c) => ({
        sha: cleanString(c.sha ?? c.id, 64) || 'unknown',
        message: cleanString(c.message, 5000) || '(no message)',
        author: cleanString(c.author?.name ?? c.author?.username ?? c.author, 120),
        url: cleanString(c.url, 1000),
        committedAt: cleanTime(c.timestamp ?? c.committed_at ?? c.date),
      })),
    },
  };
}

function insertCommits(db, deploymentId, commits) {
  db.prepare('DELETE FROM deployment_commits WHERE deployment_id = ?').run(deploymentId);
  const stmt = db.prepare(
    'INSERT INTO deployment_commits (deployment_id, sha, message, author, url, committed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const c of commits) stmt.run(deploymentId, c.sha, c.message, c.author, c.url, c.committedAt);
}

export function addEvent(db, deploymentId, kind, message = null) {
  db.prepare('INSERT INTO deployment_events (deployment_id, kind, message, at) VALUES (?, ?, ?, ?)').run(
    deploymentId,
    kind,
    message,
    now(),
  );
}

export function getDeployment(db, id) {
  return db
    .prepare(
      `SELECT d.*, e.name AS environment, p.name AS project_name, p.slug AS project_slug, p.repo_url
         FROM deployments d
         JOIN environments e ON e.id = d.environment_id
         JOIN projects p ON p.id = d.project_id
        WHERE d.id = ?`,
    )
    .get(id);
}

// The last successful deploy in this environment created before `beforeId`.
function previousSuccessful(db, environmentId, beforeId) {
  return db
    .prepare(
      `SELECT * FROM deployments
        WHERE environment_id = ? AND status = 'succeeded' AND id < ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(environmentId, beforeId);
}

// A deploy is a rollback if it ships a version/sha that an *older* successful deploy shipped,
// i.e. not the immediately previous one.
function looksLikeRollback(db, environmentId, deploymentId, previous, version, sha) {
  if (!previous) return false;
  const sameAsPrevious = (version && version === previous.version) || (sha && sha === previous.commit_sha);
  if (sameAsPrevious) return false;
  const older = db
    .prepare(
      `SELECT 1 FROM deployments
        WHERE environment_id = ? AND status = 'succeeded' AND id < ? AND id <> ?
          AND ((? IS NOT NULL AND version = ?) OR (? IS NOT NULL AND commit_sha = ?))
        LIMIT 1`,
    )
    .get(environmentId, deploymentId, previous.id, version, version, sha, sha);
  return Boolean(older);
}

/**
 * Create or update a deployment from a validated payload.
 * Returns { deployment, created, transitioned, needsCommitEnrichment }.
 */
export function recordDeployment(db, project, data) {
  return tx(db, () => {
    const env = getOrCreateEnvironment(db, project.id, data.environment);
    if (data.healthUrl && data.healthUrl !== env.health_url) {
      db.prepare('UPDATE environments SET health_url = ? WHERE id = ?').run(data.healthUrl, env.id);
    }

    const t = now();
    let existing = data.externalId
      ? db.prepare('SELECT * FROM deployments WHERE environment_id = ? AND external_id = ?').get(env.id, data.externalId)
      : null;

    let created = false;
    let id;
    if (!existing) {
      if (!data.version && !data.commitSha) {
        throw Object.assign(new Error(`no deployment with external_id "${data.externalId}"; version or commit_sha is required`), {
          statusCode: 400,
        });
      }
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO deployments
             (project_id, environment_id, external_id, version, commit_sha, branch, deployer, source, ci_url, message,
              status, metadata, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id, env.id, data.externalId, data.version, data.commitSha, data.branch, data.deployer, data.source,
          data.ciUrl, data.message, data.status, data.metadata, data.startedAt || t, t, t,
        );
      id = Number(lastInsertRowid);
      created = true;
      addEvent(db, id, 'created', `Reported by ${data.source}`);
    } else {
      id = existing.id;
      // Only fill fields the new payload actually carries; never wipe earlier data.
      db.prepare(
        `UPDATE deployments SET
           version = COALESCE(?, version), commit_sha = COALESCE(?, commit_sha), branch = COALESCE(?, branch),
           deployer = COALESCE(?, deployer), ci_url = COALESCE(?, ci_url), message = COALESCE(?, message),
           metadata = COALESCE(?, metadata), started_at = COALESCE(?, started_at), updated_at = ?
         WHERE id = ?`,
      ).run(data.version, data.commitSha, data.branch, data.deployer, data.ciUrl, data.message, data.metadata, data.startedAt, t, id);
    }

    const before = existing?.status ?? null;
    let status = data.status;
    // Out-of-order webhooks: never move a finished deploy back to queued/in_progress.
    if (before && TERMINAL.has(before) && !TERMINAL.has(status)) status = before;
    const transitioned = created || status !== before;

    let deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id);

    if (created) {
      const previous = previousSuccessful(db, env.id, id);
      const rollback =
        data.rollback || looksLikeRollback(db, env.id, id, previous, deployment.version, deployment.commit_sha);
      const repo = githubRepo(project.repo_url);
      const compareUrl =
        repo && previous?.commit_sha && deployment.commit_sha && previous.commit_sha !== deployment.commit_sha
          ? `${repo.web}/compare/${previous.commit_sha}...${deployment.commit_sha}`
          : null;
      db.prepare('UPDATE deployments SET previous_deployment_id = ?, is_rollback = ?, compare_url = ? WHERE id = ?').run(
        previous?.id ?? null,
        rollback ? 1 : 0,
        compareUrl,
        id,
      );
      if (rollback && !data.rollback) {
        addEvent(db, id, 'rollback_detected', `Version matches an older release than ${previous.version || previous.commit_sha?.slice(0, 7)}`);
      }
    }

    if (data.commits.length) insertCommits(db, id, data.commits);

    if (transitioned && !created) addEvent(db, id, status, data.message);
    if (created && status !== 'queued') addEvent(db, id, status, data.message);

    if (transitioned && TERMINAL.has(status)) {
      const finishedAt = data.finishedAt || t;
      const freshEnv = db.prepare('SELECT * FROM environments WHERE id = ?').get(env.id);
      let verification = 'none';
      let verifyUntil = null;
      if (status === 'succeeded' && freshEnv.health_url) {
        verification = 'verifying';
        verifyUntil = null; // set by the health service, which knows the window
      }
      db.prepare('UPDATE deployments SET status = ?, finished_at = ?, verification = ?, verify_until = ? WHERE id = ?').run(
        status, finishedAt, verification, verifyUntil, id,
      );
      if (status === 'succeeded') {
        // A newer successful deploy supersedes any still-verifying older one in this environment.
        const superseded = db
          .prepare(`SELECT id FROM deployments WHERE environment_id = ? AND verification = 'verifying' AND id <> ?`)
          .all(env.id, id);
        for (const s of superseded) {
          db.prepare(`UPDATE deployments SET verification = 'none' WHERE id = ?`).run(s.id);
          addEvent(db, s.id, 'verification_superseded', `Superseded by deployment #${id}`);
        }
      }
    } else if (transitioned) {
      db.prepare('UPDATE deployments SET status = ? WHERE id = ?').run(status, id);
    }

    deployment = getDeployment(db, id);
    const hasCommits = db.prepare('SELECT COUNT(*) AS n FROM deployment_commits WHERE deployment_id = ?').get(id).n > 0;
    const previous = deployment.previous_deployment_id
      ? db.prepare('SELECT commit_sha FROM deployments WHERE id = ?').get(deployment.previous_deployment_id)
      : null;
    const needsCommitEnrichment =
      !hasCommits && Boolean(githubRepo(project.repo_url)) && Boolean(previous?.commit_sha) && Boolean(deployment.commit_sha) &&
      previous.commit_sha !== deployment.commit_sha;

    return { deployment, created, transitioned, previousStatus: before, needsCommitEnrichment, previousSha: previous?.commit_sha };
  });
}

// Fill in commits from GitHub's compare API when CI didn't send them.
export async function enrichCommitsFromGitHub(db, deployment, previousSha, token, log) {
  const repo = githubRepo(deployment.repo_url);
  if (!repo) return;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'DeployGuard' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/compare/${previousSha}...${deployment.commit_sha}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      log?.warn({ status: res.status, deployment: deployment.id }, 'GitHub compare failed');
      return;
    }
    const body = await res.json();
    const commits = (body.commits || []).slice(-250).map((c) => ({
      sha: c.sha,
      message: c.commit?.message || '(no message)',
      author: c.author?.login || c.commit?.author?.name || null,
      url: c.html_url,
      committedAt: c.commit?.author?.date || null,
    }));
    if (commits.length) {
      insertCommits(db, deployment.id, commits);
      addEvent(db, deployment.id, 'commits_enriched', `${commits.length} commits loaded from GitHub`);
    }
  } catch (err) {
    log?.warn({ err: err.message, deployment: deployment.id }, 'GitHub compare error');
  }
}
