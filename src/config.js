// Central configuration — everything comes from environment variables.

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

export function loadConfig(overrides = {}) {
  const config = {
    port: int('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.DB_PATH || './deployguard.db',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

    // Dashboard auth
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    sessionTtlHours: int('SESSION_TTL_HOURS', 24 * 7),
    secureCookies: process.env.SECURE_COOKIES === 'true',

    // Health checks
    healthIntervalSeconds: int('HEALTH_INTERVAL_SECONDS', 60),
    healthTimeoutMs: int('HEALTH_TIMEOUT_MS', 5000),
    healthFailureThreshold: int('HEALTH_FAILURE_THRESHOLD', 3),
    verifyWindowSeconds: int('VERIFY_WINDOW_SECONDS', 300),
    verifyIntervalSeconds: int('VERIFY_INTERVAL_SECONDS', 15),
    healthRetentionDays: int('HEALTH_RETENTION_DAYS', 14),

    // Optional: fills in "what changed" from the GitHub compare API when CI doesn't send commits
    githubToken: process.env.GITHUB_TOKEN || '',

    // Workspace-wide key for integrations that report many projects (e.g. Argo CD Notifications).
    integrationApiKey: process.env.INTEGRATION_API_KEY || '',
    // Optional JSON file declaring projects, environments and alert channels (GitOps-style).
    bootstrapPath: process.env.BOOTSTRAP_PATH || '',

    disableScheduler: process.env.DISABLE_SCHEDULER === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
    ...overrides,
  };

  if (!config.adminPassword) {
    throw new Error('ADMIN_PASSWORD is required');
  }
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET is required and must be at least 32 characters (try: openssl rand -hex 32)');
  }
  if (config.integrationApiKey && !/^dg_[A-Za-z0-9_-]{20,}$/.test(config.integrationApiKey)) {
    throw new Error('INTEGRATION_API_KEY must look like dg_ followed by at least 20 letters, digits, _ or - (try: echo dg_$(openssl rand -hex 24))');
  }
  return config;
}
