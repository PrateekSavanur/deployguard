// DORA-style delivery metrics, computed from deployment history.
//  - Deployment frequency: successful deploys per day/week
//  - Change failure rate: share of finished deploys that failed, were rolled back or failed verification
//  - Time to restore: from a failure until the next healthy deploy in the same environment
//  - Lead time: commit authored → deploy finished (only when commit timestamps are known)

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const isFailure = (d) =>
  d.status === 'failed' || d.status === 'rolled_back' || (d.status === 'succeeded' && d.verification === 'unhealthy');

export function computeMetrics(db, { projectId = null, environmentId = null, days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const where = ['d.created_at >= ?'];
  const params = [since];
  if (projectId) {
    where.push('d.project_id = ?');
    params.push(projectId);
  }
  if (environmentId) {
    where.push('d.environment_id = ?');
    params.push(environmentId);
  }
  const rows = db
    .prepare(
      `SELECT d.id, d.environment_id, d.status, d.verification, d.created_at, d.started_at, d.finished_at
         FROM deployments d WHERE ${where.join(' AND ')} ORDER BY d.id`,
    )
    .all(...params);

  const finished = rows.filter((d) => d.status !== 'queued' && d.status !== 'in_progress' && d.status !== 'cancelled');
  const failures = finished.filter(isFailure);
  const successes = finished.filter((d) => !isFailure(d));

  // Time to restore, per environment: first failure in a streak → next non-failure.
  const restoreMinutes = [];
  const byEnv = Map.groupBy(finished, (d) => d.environment_id);
  for (const list of byEnv.values()) {
    let failedAt = null;
    for (const d of list) {
      if (isFailure(d)) failedAt ??= d.finished_at || d.created_at;
      else if (failedAt) {
        restoreMinutes.push((new Date(d.finished_at || d.created_at) - new Date(failedAt)) / 60_000);
        failedAt = null;
      }
    }
  }

  const durations = finished
    .filter((d) => d.started_at && d.finished_at)
    .map((d) => (new Date(d.finished_at) - new Date(d.started_at)) / 1000)
    .filter((s) => s >= 0);

  const leadTimes = db
    .prepare(
      `SELECT (julianday(d.finished_at) - julianday(MIN(c.committed_at))) * 24 AS hours
         FROM deployments d JOIN deployment_commits c ON c.deployment_id = d.id
        WHERE ${where.join(' AND ')} AND d.status = 'succeeded' AND c.committed_at IS NOT NULL AND d.finished_at IS NOT NULL
        GROUP BY d.id`,
    )
    .all(...params)
    .map((r) => r.hours)
    .filter((h) => h >= 0);

  // Daily buckets for the activity chart.
  const daily = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const bucket = { day, succeeded: 0, failed: 0 };
    index.set(day, bucket);
    daily.push(bucket);
  }
  for (const d of finished) {
    const bucket = index.get(d.created_at.slice(0, 10));
    if (bucket) bucket[isFailure(d) ? 'failed' : 'succeeded']++;
  }

  return {
    days,
    total: rows.length,
    finished: finished.length,
    succeeded: successes.length,
    failed: failures.length,
    deploysPerWeek: Number(((successes.length / days) * 7).toFixed(1)),
    changeFailureRate: finished.length ? Number((failures.length / finished.length).toFixed(3)) : null,
    medianRestoreMinutes: median(restoreMinutes),
    medianDurationSeconds: median(durations),
    medianLeadTimeHours: median(leadTimes),
    daily,
  };
}
