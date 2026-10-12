// CI/CD-facing API, authenticated with a project API key (Authorization: Bearer dg_...).
import { resolveApiKey } from '../auth.js';
import {
  enrichCommitsFromGitHub, ensureProject, getDeployment, recordDeployment, validatePayload,
} from '../services/deployments.js';

export default async function ingestRoutes(app, { db, config, notify }) {
  app.addHook('onRequest', async (request, reply) => {
    const scope = resolveApiKey(db, request.headers.authorization, config.integrationApiKey);
    if (!scope) return reply.code(401).send({ error: 'invalid or missing API key (Authorization: Bearer dg_...)' });
    request.project = scope.workspace ? null : scope;
    request.workspace = Boolean(scope.workspace);
  });

  const present = (d) => ({
    id: d.id,
    project: d.project_slug,
    environment: d.environment,
    version: d.version,
    commit_sha: d.commit_sha,
    status: d.status,
    verification: d.verification,
    is_rollback: Boolean(d.is_rollback),
    started_at: d.started_at,
    finished_at: d.finished_at,
    url: config.publicUrl ? `${config.publicUrl}/#/deployments/${d.id}` : null,
  });

  app.post('/deployments', async (request, reply) => {
    const { errors, data } = validatePayload(request.body);
    if (errors) return reply.code(400).send({ error: 'invalid payload', details: errors });

    // The integration key reports for any project, named in the payload and created on first use.
    let project = request.project;
    if (request.workspace) {
      const slug = request.body.project;
      if (!slug || typeof slug !== 'string') {
        return reply.code(400).send({ error: 'invalid payload', details: ['project is required when using the integration key'] });
      }
      project = ensureProject(db, { slug, name: request.body.project_name, repoUrl: request.body.repo_url });
    }

    const result = recordDeployment(db, project, data);
    const d = result.deployment;

    if (result.needsCommitEnrichment) {
      enrichCommitsFromGitHub(db, d, result.previousSha, config.githubToken, request.log);
    }
    if (result.transitioned) {
      const kind = {
        in_progress: 'deploy_started',
        succeeded: d.is_rollback ? 'rollback' : 'deploy_succeeded',
        failed: 'deploy_failed',
        rolled_back: 'deploy_rolled_back',
      }[d.status];
      if (kind) notify(kind, { deployment: d, detail: data.message });
    }

    return reply.code(result.created ? 201 : 200).send(present(d));
  });

  // Lets a pipeline gate on post-deploy verification:
  //   poll until verification is "healthy" (pass) or "unhealthy" (fail the job).
  app.get('/deployments/:id', async (request, reply) => {
    const d = getDeployment(db, Number(request.params.id));
    if (!d || (!request.workspace && d.project_id !== request.project.id)) return reply.code(404).send({ error: 'not found' });
    return present(d);
  });
}
