// Fills a database with ~30 days of realistic demo history (for demos and UI work).
//   DB_PATH=./demo.db npm run seed
//   SEED_HEALTH_URL=http://localhost:3000/health  — health URL for production envs (default shown)
import { openDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { addEvent, recordDeployment, validatePayload } from '../src/services/deployments.js';

const dbPath = process.env.DB_PATH || './deployguard.db';
const healthUrl = process.env.SEED_HEALTH_URL || 'http://localhost:3000/health';
const db = openDb(dbPath);

if (db.prepare('SELECT COUNT(*) AS n FROM projects').get().n && !process.argv.includes('--force')) {
  console.error(`${dbPath} already has projects — pass --force to add demo data anyway.`);
  process.exit(1);
}

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');

const PEOPLE = ['asha', 'ravi', 'meera', 'arjun', 'li.wei', 'sam'];
const SUBJECTS = {
  feat: ['add coupon codes at checkout', 'support UPI autopay', 'export orders as CSV', 'dark mode for dashboard', 'bulk edit products', 'webhook retries with backoff', 'saved carts for guests'],
  fix: ['handle empty cart on refresh', 'race in inventory reservation', 'timezone bug in invoices', 'null avatar crash', 'retry Razorpay webhook on 5xx', 'pagination off-by-one'],
  perf: ['cache product listing for 60s', 'index orders(created_at)', 'lazy-load hero images'],
  refactor: ['extract pricing module', 'move auth to middleware'],
  chore: ['bump deps', 'update node to 22', 'tidy eslint config'],
  docs: ['document payment states'],
};
const SCOPES = ['cart', 'checkout', 'api', 'auth', 'orders', 'ui', null];

function commitsFor(at, n) {
  return Array.from({ length: n }, () => {
    const type = pick(['feat', 'feat', 'fix', 'fix', 'fix', 'perf', 'refactor', 'chore', 'chore', 'docs']);
    const scope = pick(SCOPES);
    return {
      sha: hex(40),
      message: `${type}${scope ? `(${scope})` : ''}: ${pick(SUBJECTS[type])}`,
      author: pick(PEOPLE),
      timestamp: new Date(at - rand() * 3 * 86_400_000).toISOString(),
    };
  });
}

const projects = [
  { name: 'Storefront Web', repo: 'https://github.com/acme/storefront', rate: 1.6, failRate: 0.08 },
  { name: 'Payments API', repo: 'https://github.com/acme/payments-api', rate: 0.9, failRate: 0.14 },
  { name: 'Admin Portal', repo: null, rate: 0.9, failRate: 0.05 },
];

const DAY = 86_400_000;
const startTime = Date.now() - 30 * DAY;
// Actions are queued and replayed in time order so ids stay chronological across projects.
const actions = [];
const keys = [];
const afterReplay = [];

for (const spec of projects) {
  const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  db.prepare('INSERT INTO projects (name, slug, repo_url, created_at) VALUES (?, ?, ?, ?)').run(
    spec.name, slug, spec.repo, new Date(startTime - DAY).toISOString(),
  );
  const project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
  const { key } = createApiKey(db, project.id, 'github-actions');

  let major = 1, minor = Math.floor(rand() * 5), patch = 0;
  const shipped = { staging: [], production: [] };

  for (let day = 0; day < 30; day++) {
    const count = Math.floor(spec.rate * (0.4 + rand() * 1.4));
    for (let i = 0; i < count; i++) {
      const at = startTime + day * DAY + (9 + rand() * 9) * 3600_000;
      if (rand() < 0.3) minor++, (patch = 0);
      else patch++;
      const version = `v${major}.${minor}.${patch}`;
      const sha = hex(40);
      const commits = commitsFor(at, 1 + Math.floor(rand() * 6));

      // dev → staging → production, each a little later
      const envs = ['dev', 'staging', ...(rand() < 0.7 ? ['production'] : [])];
      let t = at;
      for (const environment of envs) {
        t += (10 + rand() * 120) * 60_000;
        if (t > Date.now()) break;
        const failed = rand() < spec.failRate * (environment === 'production' ? 1.2 : 1);
        const unhealthy = !failed && environment === 'production' && rand() < 0.05;
        const durationS = 60 + rand() * 400;
        const status = failed ? (rand() < 0.3 ? 'rolled_back' : 'failed') : 'succeeded';
        const { data } = validatePayload({
          environment, version, commit_sha: sha, branch: 'main', status, deployer: pick(PEOPLE),
          source: 'github-actions', external_id: `${slug}-${environment}-${version}`,
          ci_url: `https://github.com/acme/${slug}/actions/runs/${Math.floor(rand() * 1e9)}`,
          message: failed ? pick(['Migration 0042 timed out', 'Readiness probe failed: HTTP 503', 'Image pull backoff', 'Smoke test checkout_flow failed']) : null,
          commits,
          health_url: environment === 'production' ? healthUrl : undefined,
        });
        const tt = t;
        actions.push({ t: tt, run: () => {
          const { deployment } = recordDeployment(db, project, data);
          const started = new Date(tt).toISOString();
          const finished = new Date(tt + durationS * 1000).toISOString();
          db.prepare(
            `UPDATE deployments SET created_at = ?, started_at = ?, finished_at = ?, updated_at = ?,
               verification = CASE WHEN verification = 'verifying' THEN ? ELSE verification END,
               verify_until = CASE WHEN verification = 'verifying' THEN ? ELSE verify_until END
             WHERE id = ?`,
          ).run(started, started, finished, finished, unhealthy ? 'unhealthy' : 'healthy', finished, deployment.id);
          db.prepare('UPDATE deployment_events SET at = ? WHERE deployment_id = ?').run(finished, deployment.id);
          if (deployment.verification === 'verifying') {
            addEvent(db, deployment.id, unhealthy ? 'verification_failed' : 'verification_passed', unhealthy ? '3 consecutive failed checks — HTTP 502' : 'Healthy for 300s after deploy');
            db.prepare('UPDATE deployment_events SET at = ? WHERE deployment_id = ? AND at > ?').run(
              new Date(tt + durationS * 1000 + 300_000).toISOString(), deployment.id, finished,
            );
          }
        } });
        if (!failed) shipped[environment]?.push({ version, sha });

        // Production failures are usually followed by a rollback to the last good version.
        if ((failed || unhealthy) && environment === 'production' && shipped.production.length > 1) {
          const good = shipped.production.at(-2);
          t += (8 + rand() * 30) * 60_000;
          const { data: rb } = validatePayload({
            environment, version: good.version, commit_sha: good.sha, status: 'succeeded', deployer: pick(PEOPLE),
            source: 'github-actions', rollback: true, message: `Rollback after ${version}`,
          });
          const rt = t;
          actions.push({ t: rt, run: () => {
            const { deployment: r } = recordDeployment(db, project, rb);
            const s = new Date(rt).toISOString();
            const f = new Date(rt + 90_000).toISOString();
            db.prepare(`UPDATE deployments SET created_at = ?, started_at = ?, finished_at = ?, verification = 'healthy', verify_until = ? WHERE id = ?`).run(s, s, f, f, r.id);
            db.prepare('UPDATE deployment_events SET at = ? WHERE deployment_id = ?').run(f, r.id);
          } });
        }
        if (failed) break; // a failed stage stops promotion
      }
    }
  }

  // Synthetic 24h health history for production (live checks take over once the server runs).
  afterReplay.push(() => {
    const prod = db.prepare(`SELECT * FROM environments WHERE project_id = ? AND name = 'production'`).get(project.id);
    if (prod) {
      const ins = db.prepare('INSERT INTO health_checks (environment_id, ok, status_code, latency_ms, error, at) VALUES (?, ?, ?, ?, ?, ?)');
      const outageAt = Math.floor(rand() * 80);
      for (let i = 96; i > 0; i--) {
        const down = spec.failRate > 0.1 && i > outageAt && i < outageAt + 3;
        ins.run(prod.id, down ? 0 : 1, down ? 503 : 200, Math.round(40 + rand() * 120), null, new Date(Date.now() - i * 15 * 60_000).toISOString());
      }
      db.prepare(`UPDATE environments SET health_status = 'up', health_changed_at = ? WHERE id = ?`).run(new Date().toISOString(), prod.id);
    }
  });
  keys.push(`${spec.name.padEnd(16)} key: ${key}`);
}

actions.sort((a, b) => a.t - b.t).forEach((a) => a.run());
afterReplay.forEach((fn) => fn());
console.log(keys.join('\n'));

const n = db.prepare('SELECT COUNT(*) AS n FROM deployments').get().n;
console.log(`\nSeeded ${n} deployments into ${dbPath}`);
