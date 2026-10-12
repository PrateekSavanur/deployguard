// Two auth paths:
//  - Project API keys (Bearer dg_...) for CI/CD ingestion. Only a SHA-256 hash is stored.
//  - An HMAC-signed session cookie for the dashboard (single admin password).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { now } from './db.js';

const COOKIE = 'dg_session';

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export function createApiKey(db, projectId, name) {
  const key = `dg_${randomBytes(24).toString('base64url')}`;
  const prefix = key.slice(0, 10);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO api_keys (project_id, name, prefix, hash) VALUES (?, ?, ?, ?)')
    .run(projectId, name, prefix, hashKey(key));
  return { id: Number(lastInsertRowid), key, prefix, name };
}

// Returns a project for project keys, { workspace: true } for the integration key, or null.
export function resolveApiKey(db, header, integrationKey = '') {
  const match = /^Bearer\s+(dg_[A-Za-z0-9_-]+)$/.exec(header || '');
  if (!match) return null;
  if (integrationKey && safeEqual(hashKey(match[1]), hashKey(integrationKey))) return { workspace: true };
  const row = db
    .prepare(
      `SELECT k.id AS key_id, p.* FROM api_keys k JOIN projects p ON p.id = k.project_id WHERE k.hash = ?`,
    )
    .get(hashKey(match[1]));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.key_id);
  const { key_id, ...project } = row;
  return project;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sessionAuth(config) {
  const sign = (payload) => createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

  function issue(reply) {
    const expires = Date.now() + config.sessionTtlHours * 3600_000;
    const payload = `admin.${expires}`;
    const value = `${payload}.${sign(payload)}`;
    const attrs = [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${config.sessionTtlHours * 3600}`,
    ];
    if (config.secureCookies) attrs.push('Secure');
    reply.header('Set-Cookie', attrs.join('; '));
  }

  function clear(reply) {
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function isValid(request) {
    const cookies = Object.fromEntries(
      (request.headers.cookie || '').split(';').map((c) => {
        const i = c.indexOf('=');
        return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
      }),
    );
    const value = cookies[COOKIE];
    if (!value) return false;
    const lastDot = value.lastIndexOf('.');
    const payload = value.slice(0, lastDot);
    const signature = value.slice(lastDot + 1);
    if (!safeEqual(signature, sign(payload))) return false;
    const expires = Number(payload.split('.')[1]);
    return Number.isFinite(expires) && expires > Date.now();
  }

  const checkPassword = (password) =>
    typeof password === 'string' && safeEqual(hashKey(password), hashKey(config.adminPassword));

  return { issue, clear, isValid, checkPassword };
}

// Naive in-memory limiter for the login endpoint: 10 attempts / 15 min per IP.
export function loginLimiter() {
  const attempts = new Map();
  const WINDOW = 15 * 60_000;
  return (ip) => {
    const t = Date.now();
    const list = (attempts.get(ip) || []).filter((ts) => t - ts < WINDOW);
    list.push(t);
    attempts.set(ip, list);
    return list.length <= 10;
  };
}
