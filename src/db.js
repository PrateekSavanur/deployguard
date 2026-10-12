// SQLite storage using Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    repo_url    TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE api_keys (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    hash          TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at  TEXT
  );

  CREATE TABLE environments (
    id                INTEGER PRIMARY KEY,
    project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    position          INTEGER NOT NULL DEFAULT 0,
    health_url        TEXT,
    health_status     TEXT NOT NULL DEFAULT 'unknown',   -- unknown | up | down
    health_changed_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (project_id, name)
  );

  CREATE TABLE deployments (
    id              INTEGER PRIMARY KEY,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id  INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    external_id     TEXT,
    version         TEXT,
    commit_sha      TEXT,
    branch          TEXT,
    deployer        TEXT,
    source          TEXT NOT NULL DEFAULT 'api',
    ci_url          TEXT,
    message         TEXT,
    status          TEXT NOT NULL,                       -- queued | in_progress | succeeded | failed | rolled_back | cancelled
    verification    TEXT NOT NULL DEFAULT 'none',        -- none | verifying | healthy | unhealthy
    verify_until    TEXT,
    verify_failures INTEGER NOT NULL DEFAULT 0,
    is_rollback     INTEGER NOT NULL DEFAULT 0,
    previous_deployment_id INTEGER REFERENCES deployments(id) ON DELETE SET NULL,
    compare_url     TEXT,
    metadata        TEXT,
    started_at      TEXT,
    finished_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX deployments_external ON deployments(environment_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX deployments_env_time ON deployments(environment_id, created_at DESC);
  CREATE INDEX deployments_project_time ON deployments(project_id, created_at DESC);

  CREATE TABLE deployment_commits (
    id            INTEGER PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    sha           TEXT NOT NULL,
    message       TEXT NOT NULL,
    author        TEXT,
    url           TEXT,
    committed_at  TEXT
  );
  CREATE INDEX deployment_commits_deploy ON deployment_commits(deployment_id);

  CREATE TABLE deployment_events (
    id            INTEGER PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    message       TEXT,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX deployment_events_deploy ON deployment_events(deployment_id);

  CREATE TABLE health_checks (
    id              INTEGER PRIMARY KEY,
    environment_id  INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    deployment_id   INTEGER REFERENCES deployments(id) ON DELETE SET NULL,
    ok              INTEGER NOT NULL,
    status_code     INTEGER,
    latency_ms      INTEGER,
    error           TEXT,
    at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX health_checks_env_time ON health_checks(environment_id, at DESC);

  CREATE TABLE alert_channels (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,                -- slack | discord | telegram | webhook
    config      TEXT NOT NULL,                -- JSON
    events      TEXT NOT NULL,                -- JSON array of event kinds
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = all projects
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE alert_log (
    id            INTEGER PRIMARY KEY,
    channel_id    INTEGER REFERENCES alert_channels(id) ON DELETE SET NULL,
    project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    deployment_id INTEGER REFERENCES deployments(id) ON DELETE SET NULL,
    environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    delivered     INTEGER NOT NULL,
    error         TEXT,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX alert_log_time ON alert_log(at DESC);
  `,
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => new Date().toISOString();
