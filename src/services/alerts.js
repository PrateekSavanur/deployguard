// Alert fan-out to Slack, Discord, Telegram or any JSON webhook (e.g. Homelert).
import { createHmac } from 'node:crypto';

export const ALERT_KINDS = {
  deploy_failed: { label: 'Deployment failed', severity: 'critical', emoji: '❌' },
  deploy_rolled_back: { label: 'Deployment rolled back', severity: 'warning', emoji: '↩️' },
  verification_failed: { label: 'Post-deploy health check failed', severity: 'critical', emoji: '🩺' },
  env_down: { label: 'Environment down', severity: 'critical', emoji: '🔴' },
  env_recovered: { label: 'Environment recovered', severity: 'info', emoji: '🟢' },
  rollback: { label: 'Rollback deployed', severity: 'warning', emoji: '⏪' },
  deploy_succeeded: { label: 'Deployment succeeded', severity: 'info', emoji: '✅' },
  deploy_started: { label: 'Deployment started', severity: 'info', emoji: '🚀' },
};
export const DEFAULT_EVENTS = ['deploy_failed', 'deploy_rolled_back', 'verification_failed', 'env_down', 'env_recovered', 'rollback'];

export const CHANNEL_TYPES = {
  slack: { required: ['webhook_url'] },
  discord: { required: ['webhook_url'] },
  telegram: { required: ['bot_token', 'chat_id'] },
  webhook: { required: ['url'] }, // optional: secret (adds X-DeployGuard-Signature)
};

export function validateChannel(body) {
  const errors = [];
  const type = body?.type;
  if (!CHANNEL_TYPES[type]) errors.push(`type must be one of ${Object.keys(CHANNEL_TYPES).join(', ')}`);
  if (!body?.name) errors.push('name is required');
  const config = body?.config || {};
  for (const field of CHANNEL_TYPES[type]?.required || []) {
    if (!config[field]) errors.push(`config.${field} is required`);
  }
  for (const field of ['webhook_url', 'url']) {
    if (config[field] && !/^https?:\/\//.test(config[field])) errors.push(`config.${field} must be an http(s) URL`);
  }
  const events = Array.isArray(body?.events) && body.events.length ? body.events : DEFAULT_EVENTS;
  const unknown = events.filter((e) => !ALERT_KINDS[e]);
  if (unknown.length) errors.push(`unknown events: ${unknown.join(', ')}`);
  return { errors, value: { name: String(body?.name || '').slice(0, 100), type, config, events, projectId: body?.project_id || null } };
}

// Hide secrets when returning channels to the browser.
function redactValue(key, value) {
  if (!value) return value;
  if (/url/.test(key)) {
    try {
      return `${new URL(value).origin}/…`;
    } catch {
      return '••••••';
    }
  }
  return /token|secret/.test(key) ? '••••••' : value;
}

export function redactChannel(row) {
  const config = Object.fromEntries(Object.entries(JSON.parse(row.config)).map(([k, v]) => [k, redactValue(k, v)]));
  return { ...row, config, events: JSON.parse(row.events), enabled: Boolean(row.enabled) };
}

function buildMessage(kind, ctx, publicUrl) {
  const meta = ALERT_KINDS[kind];
  const d = ctx.deployment;
  const project = ctx.project?.name || d?.project_name;
  const env = ctx.environment?.name || d?.environment;
  const version = d ? d.version || d.commit_sha?.slice(0, 7) : null;
  const title = `${meta.emoji} ${meta.label}: ${project} → ${env}`;
  const lines = [];
  if (version) lines.push(`Version: ${version}`);
  if (d?.deployer) lines.push(`Deployer: ${d.deployer}`);
  if (d?.branch) lines.push(`Branch: ${d.branch}`);
  if (ctx.detail) lines.push(ctx.detail);
  if (d?.ci_url) lines.push(`CI run: ${d.ci_url}`);
  const link = publicUrl && d ? `${publicUrl}/#/deployments/${d.id}` : publicUrl && ctx.project ? `${publicUrl}/#/projects/${ctx.project.slug}` : null;
  if (link) lines.push(`Details: ${link}`);
  return { title, text: lines.join('\n'), severity: meta.severity, link };
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'DeployGuard', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function sendToChannel(type, config, kind, msg, ctx) {
  switch (type) {
    case 'slack':
      return post(config.webhook_url, { text: `*${msg.title}*\n${msg.text}` });
    case 'discord':
      return post(config.webhook_url, { content: `**${msg.title}**\n${msg.text}`.slice(0, 2000) });
    case 'telegram':
      return post(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
        chat_id: config.chat_id,
        text: `${msg.title}\n${msg.text}`,
        disable_web_page_preview: true,
      });
    case 'webhook': {
      // Shape is Homelert-compatible: {title, body, severity} plus structured fields.
      const payload = {
        source: 'deployguard',
        event: kind,
        title: msg.title,
        body: msg.text,
        severity: msg.severity,
        url: msg.link,
        project: ctx.project?.slug || ctx.deployment?.project_slug || null,
        environment: ctx.environment?.name || ctx.deployment?.environment || null,
        deployment: ctx.deployment
          ? {
              id: ctx.deployment.id,
              version: ctx.deployment.version,
              commit_sha: ctx.deployment.commit_sha,
              status: ctx.deployment.status,
              verification: ctx.deployment.verification,
            }
          : null,
        at: new Date().toISOString(),
      };
      const headers = {};
      if (config.secret) {
        headers['X-DeployGuard-Signature'] =
          'sha256=' + createHmac('sha256', config.secret).update(JSON.stringify(payload)).digest('hex');
      }
      return post(config.url, payload, headers);
    }
    default:
      throw new Error(`unknown channel type ${type}`);
  }
}

export function createNotifier(db, config, log) {
  async function notify(kind, ctx) {
    const projectId = ctx.project?.id ?? ctx.deployment?.project_id ?? null;
    const channels = db
      .prepare('SELECT * FROM alert_channels WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?)')
      .all(projectId)
      .filter((c) => JSON.parse(c.events).includes(kind));
    const msg = buildMessage(kind, ctx, config.publicUrl);
    const logStmt = db.prepare(
      `INSERT INTO alert_log (channel_id, project_id, deployment_id, environment_id, kind, title, delivered, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const envId = ctx.environment?.id ?? ctx.deployment?.environment_id ?? null;
    const deployId = ctx.deployment?.id ?? null;
    if (!channels.length) {
      // Record unrouted problems so they're visible in the log; routine info events are just dropped.
      if (ALERT_KINDS[kind].severity === 'info') return;
      logStmt.run(null, projectId, deployId, envId, kind, msg.title, 0, 'no channel subscribed');
      return;
    }
    await Promise.all(
      channels.map(async (ch) => {
        try {
          await sendToChannel(ch.type, JSON.parse(ch.config), kind, msg, ctx);
          logStmt.run(ch.id, projectId, deployId, envId, kind, msg.title, 1, null);
        } catch (err) {
          log.warn({ channel: ch.name, err: err.message }, 'alert delivery failed');
          logStmt.run(ch.id, projectId, deployId, envId, kind, msg.title, 0, err.message.slice(0, 500));
        }
      }),
    );
  }

  // Fire-and-forget wrapper: alerting must never break ingestion or health checks.
  return (kind, ctx) => {
    notify(kind, ctx).catch((err) => log.error({ err }, 'notify crashed'));
  };
}

export { buildMessage };
