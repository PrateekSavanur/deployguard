// Health checks.
//  - Every environment with a health_url is polled continuously (HEALTH_INTERVAL_SECONDS).
//    N consecutive failures flip it to "down" (alert), the next success flips it back (alert).
//  - After a successful deploy the environment is polled faster (VERIFY_INTERVAL_SECONDS) for
//    VERIFY_WINDOW_SECONDS. N consecutive failures in that window mark the deploy "unhealthy".
import { now } from '../db.js';
import { addEvent, getDeployment } from './deployments.js';

export async function probe(url, timeoutMs) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'DeployGuard-HealthCheck' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    const latency = Math.round(performance.now() - started);
    return { ok: res.status >= 200 && res.status < 400, statusCode: res.status, latencyMs: latency, error: null };
  } catch (err) {
    const latency = Math.round(performance.now() - started);
    const cause = err.cause?.errors?.[0] ?? err.cause; // undici wraps multi-address failures in AggregateError
    const error = err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : cause?.code || cause?.message || err.message;
    return { ok: false, statusCode: null, latencyMs: latency, error: String(error).slice(0, 300) };
  }
}

export function createHealthService(db, config, notify, log, probeFn = probe) {
  const lastChecked = new Map(); // environment_id → epoch ms
  const inFlight = new Set();
  let timer = null;
  let lastPrune = 0;

  function verifyingDeployment(envId) {
    return db
      .prepare(`SELECT * FROM deployments WHERE environment_id = ? AND verification = 'verifying' ORDER BY id DESC LIMIT 1`)
      .get(envId);
  }

  async function checkEnvironment(env) {
    if (inFlight.has(env.id)) return;
    inFlight.add(env.id);
    try {
      lastChecked.set(env.id, Date.now());
      const verifying = verifyingDeployment(env.id);
      if (verifying && !verifying.verify_until) {
        const until = new Date(Date.now() + config.verifyWindowSeconds * 1000).toISOString();
        db.prepare('UPDATE deployments SET verify_until = ? WHERE id = ?').run(until, verifying.id);
        addEvent(db, verifying.id, 'verification_started', `Watching ${env.health_url} for ${config.verifyWindowSeconds}s`);
        verifying.verify_until = until;
      }

      const result = await probeFn(env.health_url, config.healthTimeoutMs);
      db.prepare(
        'INSERT INTO health_checks (environment_id, deployment_id, ok, status_code, latency_ms, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(env.id, verifying?.id ?? null, result.ok ? 1 : 0, result.statusCode, result.latencyMs, result.error, now());

      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(env.project_id);
      const fresh = db.prepare('SELECT * FROM environments WHERE id = ?').get(env.id);
      const failures = result.ok ? 0 : fresh.consecutive_failures + 1;
      let status = fresh.health_status;
      const detail = result.ok ? null : `Health check ${fresh.health_url}: ${result.error || `HTTP ${result.statusCode}`}`;

      if (result.ok && status !== 'up') {
        if (status === 'down') notify('env_recovered', { project, environment: fresh, detail: `Healthy again (HTTP ${result.statusCode}, ${result.latencyMs}ms)` });
        status = 'up';
      } else if (!result.ok && failures >= config.healthFailureThreshold && status !== 'down') {
        status = 'down';
        // During verification the deploy-level alert is more useful than a generic "env down".
        if (!verifying) notify('env_down', { project, environment: fresh, detail });
      }
      db.prepare(
        `UPDATE environments SET consecutive_failures = ?, health_status = ?,
           health_changed_at = CASE WHEN health_status <> ? THEN ? ELSE health_changed_at END
         WHERE id = ?`,
      ).run(failures, status, status, now(), env.id);

      if (verifying) {
        const verifyFailures = result.ok ? 0 : verifying.verify_failures + 1;
        if (verifyFailures >= config.healthFailureThreshold) {
          db.prepare(`UPDATE deployments SET verification = 'unhealthy', verify_failures = ? WHERE id = ?`).run(verifyFailures, verifying.id);
          addEvent(db, verifying.id, 'verification_failed', `${verifyFailures} consecutive failed checks — ${detail}`);
          notify('verification_failed', { deployment: getDeployment(db, verifying.id), detail });
        } else if (Date.now() >= new Date(verifying.verify_until).getTime()) {
          if (result.ok) {
            db.prepare(`UPDATE deployments SET verification = 'healthy', verify_failures = 0 WHERE id = ?`).run(verifying.id);
            addEvent(db, verifying.id, 'verification_passed', `Healthy for ${config.verifyWindowSeconds}s after deploy`);
          } else {
            // Window elapsed on a failing check: keep watching until it passes or hits the threshold.
            db.prepare('UPDATE deployments SET verify_failures = ? WHERE id = ?').run(verifyFailures, verifying.id);
          }
        } else {
          db.prepare('UPDATE deployments SET verify_failures = ? WHERE id = ?').run(verifyFailures, verifying.id);
        }
      }
      return result;
    } finally {
      inFlight.delete(env.id);
    }
  }

  async function tick() {
    // Deploys stuck "verifying" in an environment that lost its health URL can never resolve.
    db.prepare(
      `UPDATE deployments SET verification = 'none'
        WHERE verification = 'verifying'
          AND environment_id IN (SELECT id FROM environments WHERE health_url IS NULL OR health_url = '')`,
    ).run();

    const envs = db.prepare(`SELECT * FROM environments WHERE health_url IS NOT NULL AND health_url <> ''`).all();
    const t = Date.now();
    const due = envs.filter((env) => {
      const interval = verifyingDeployment(env.id) ? config.verifyIntervalSeconds : config.healthIntervalSeconds;
      return t - (lastChecked.get(env.id) || 0) >= interval * 1000;
    });
    await Promise.allSettled(due.map(checkEnvironment));

    if (t - lastPrune > 3600_000) {
      lastPrune = t;
      const cutoff = new Date(t - config.healthRetentionDays * 86_400_000).toISOString();
      db.prepare('DELETE FROM health_checks WHERE at < ?').run(cutoff);
    }
  }

  return {
    checkEnvironment,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((err) => log.error({ err }, 'health tick failed')), 5000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
