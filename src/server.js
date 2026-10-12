import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadBootstrapFile, watchBootstrapFile } from './bootstrap.js';
import { loginLimiter, sessionAuth } from './auth.js';
import { createNotifier } from './services/alerts.js';
import { createHealthService } from './services/health.js';
import ingestRoutes from './routes/ingest.js';
import apiRoutes from './routes/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp(config, { probe, logger } = {}) {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  const db = openDb(config.dbPath);
  if (config.bootstrapPath) loadBootstrapFile(db, config.bootstrapPath, app.log);
  const notify = createNotifier(db, config, app.log);
  const health = createHealthService(db, config, notify, app.log, probe);
  const auth = sessionAuth(config);
  const allowLogin = loginLimiter();

  app.decorate('db', db);
  app.decorate('health', health);

  app.get('/health', async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok' };
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!allowLogin(request.ip)) return reply.code(429).send({ error: 'too many attempts, try again later' });
    if (!auth.checkPassword(request.body?.password)) return reply.code(401).send({ error: 'wrong password' });
    auth.issue(reply);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    auth.clear(reply);
    return { ok: true };
  });
  app.get('/api/auth/me', async (request) => ({ signedIn: auth.isValid(request) }));

  await app.register(ingestRoutes, { prefix: '/api/v1', db, config, notify });
  await app.register(apiRoutes, { prefix: '/api', db, config, health, auth });
  await app.register(fastifyStatic, { root: join(__dirname, '..', 'public') });

  const stopWatch = config.bootstrapPath && !config.disableScheduler ? watchBootstrapFile(db, config.bootstrapPath, app.log) : null;

  app.addHook('onClose', async () => {
    stopWatch?.();
    health.stop();
    db.close();
  });

  if (!config.disableScheduler) health.start();
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }
  const app = await buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      app.log.info({ signal }, 'shutting down');
      await app.close();
      process.exit(0);
    });
  }
  await app.listen({ port: config.port, host: config.host });
}
