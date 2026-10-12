# DeployGuard

Deployment monitoring for small teams. Know what's running where, what changed, and when a release broke something, without a DevOps engineer on staff.

- **Deployment history.** Every deploy across every project and environment, with status, version, commit, deployer, duration and CI link.
- **Environment matrix.** One screen showing the live version per environment (dev → staging → production) and whether it's healthy.
- **What changed.** Each deploy links to the previous successful one in that environment. Commits are grouped into a **release summary** (features, fixes, breaking changes…) that you can copy as Markdown for Slack or a client update. For GitHub repos you get diff links, and commit lists are fetched automatically when CI doesn't send them.
- **Health checks.** Environments with a health URL are polled continuously, which drives downtime and recovery alerts. After every successful deploy the URL is watched closely for 5 minutes. Repeated failures mark the release **unhealthy** and count it as a failed change.
- **Rollback detection.** Re-deploying a version that an older release shipped is flagged automatically.
- **Alerts.** Slack, Discord, Telegram, or a signed JSON webhook (Homelert-compatible), per project and per event type, with a delivery log.
- **Delivery metrics.** DORA-style deploy frequency, change failure rate, time to restore, and lead time.
- **Pipeline gate.** CI can poll a deploy's verification result and fail the job when the release is unhealthy.

Integration is a single HTTP call from any CI/CD system (GitHub Actions, GitLab, Jenkins, Argo CD, a shell script…).

## Quick start

```bash
cp .env.example .env            # set ADMIN_PASSWORD and SESSION_SECRET (openssl rand -hex 32)
docker compose up -d            # → http://localhost:3000
```

Or without Docker (Node ≥ 22.13; SQLite is built into Node, so there's no native build step):

```bash
npm install
ADMIN_PASSWORD=dev SESSION_SECRET=$(openssl rand -hex 32) npm run dev
```

**Demo data.** `DB_PATH=./demo.db npm run seed` creates three projects with 30 days of history, including failures, rollbacks and an unhealthy release. It's handy for showing the product to someone.

## Report a deployment

Sign in, create a project, and copy its API key. Then add this to your pipeline:

```bash
curl -X POST https://deployguard.example.com/api/v1/deployments \
  -H "Authorization: Bearer $DEPLOYGUARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"environment":"production","version":"v1.4.2","commit_sha":"'"$(git rev-parse HEAD)"'","status":"succeeded"}'
```

- `environment` plus either `version` or `commit_sha` are required. Environments are created on first use.
- `status`: `started`, `succeeded`, `failed`, `rolled_back` or `cancelled`. Common aliases such as `success`, `failure` and `running` are accepted, and the default is `succeeded`.
- Send `external_id` (e.g. the CI run ID) with both the "started" and the "finished" call so they update one deployment. A late "started" never re-opens a finished deploy.
- Optional: `branch`, `deployer`, `ci_url`, `message`, `health_url`, `rollback`, `commits[]` (`sha`, `message`, `author`, `timestamp`) and `metadata`.
- `GET /api/v1/deployments/:id` returns `verification` (`verifying` → `healthy` | `unhealthy`), so a pipeline can gate on it.

The dashboard's **Connect CI** page has copy-paste snippets for GitHub Actions, curl, Argo CD Notifications and the verification gate.

## Configuration

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | — | **Required.** Dashboard password |
| `SESSION_SECRET` | — | **Required.** ≥ 32 chars, signs session cookies |
| `PUBLIC_URL` | — | Base URL used in alert links |
| `SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `DB_PATH` | `./deployguard.db` | SQLite file |
| `GITHUB_TOKEN` | — | For commit lists from private GitHub repos |
| `INTEGRATION_API_KEY` | — | Workspace-wide key: may report for any `project` (auto-created). Used by Argo CD Notifications |
| `BOOTSTRAP_PATH` | — | JSON file of projects, environments/health URLs and alert channels, applied at start and on change |
| `HEALTH_INTERVAL_SECONDS` | `60` | Continuous health check interval |
| `HEALTH_FAILURE_THRESHOLD` | `3` | Consecutive failures → down / unhealthy |
| `VERIFY_WINDOW_SECONDS` | `300` | How long to watch after a deploy |
| `VERIFY_INTERVAL_SECONDS` | `15` | Check interval during that window |
| `HEALTH_TIMEOUT_MS` | `5000` | Per-check timeout |
| `HEALTH_RETENTION_DAYS` | `14` | Health check history kept |

## Running in the homelab (k3s + ArgoCD)

Deployed exactly like Homelert: this repo's `kubernetes/` folder is synced by ArgoCD
(`k8s/apps/deployguard.yml` in Homelab-Infra), CI pins the image tag, and secrets come from Ansible.

```
git push ─▶ GitHub Actions: test → build prateeksavanur/deployguard:<sha> → pin tag in kubernetes/
                                                                              │
Argo CD syncs any app ──(Argo CD Notifications webhook, integration key)──▶ DeployGuard
                                                                              │ verifies health in-cluster
                         failed / rolled back / unhealthy / down ──▶ Homelert ──▶ Telegram
```

- **Every Argo CD sync becomes a deployment.** Argo CD Notifications (enabled in Homelab-Infra's
  `argocd-values.yaml.j2`) posts sync start/finish with the Application name as `project`, the
  synced Git revision, who triggered it, and the Argo CD link. Commits between revisions are
  fetched from GitHub, so each sync gets a release summary.
- **`kubernetes/configmap.yaml` declares the homelab apps.** It sets display names, repos and
  in-cluster health URLs (Jellyfin, portfolio, Homelert, and the public site for the Cloudflare
  tunnel), plus the Homelert alert channel. It's re-applied when the ConfigMap changes. Apps not
  listed are still tracked from their first sync.
- **Secrets.** `roles/deployguard` in Homelab-Infra creates `deployguard-secrets` (`ADMIN_PASSWORD`,
  `SESSION_SECRET`, `INTEGRATION_API_KEY`, optional `GITHUB_TOKEN`) and `argocd-notifications-secret`
  from `group_vars/k3s_cluster.yml`. Run `ansible-playbook playbooks/05-argocd.yml`.
- **Alerts.** Problem events go to Homelert's `/webhook/deployguard`. Homelert's `DeployGuard` rule
  forwards them to Telegram, so its 02:00–06:00 silence window applies.
- **Storage.** SQLite on a 1 Gi `local-path` PVC, `replicas: 1` with the `Recreate` strategy. Don't scale it.

Repo secrets needed: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

## API

| | Path | Auth |
|---|---|---|
| `POST` | `/api/v1/deployments` | project API key |
| `GET` | `/api/v1/deployments/:id` | project API key |
| `GET` | `/api/overview`, `/api/deployments`, `/api/deployments/:id` | session |
| `GET/POST/PATCH/DELETE` | `/api/projects[/:slug]`, `/api/projects/:slug/keys`, `/api/keys/:id` | session |
| `PATCH/DELETE` | `/api/environments/:id`; `POST …/check`; `GET …/health` | session |
| `GET/POST/PATCH/DELETE` | `/api/channels[/:id]`; `POST /api/channels/:id/test`; `GET /api/alerts` | session |
| `GET` | `/health` | none |

## Project layout

```
src/
├── server.js              # Fastify app + boot
├── config.js              # env config
├── db.js                  # node:sqlite schema & migrations
├── auth.js                # API keys (hashed), integration key, signed session cookie
├── bootstrap.js           # declarative projects/health URLs/channels (ConfigMap)
├── routes/ingest.js       # CI-facing /api/v1
├── routes/api.js          # dashboard API
└── services/
    ├── deployments.js     # ingestion state machine, rollback detection, GitHub commit enrichment
    ├── health.js          # continuous checks + post-deploy verification
    ├── alerts.js          # Slack / Discord / Telegram / webhook
    ├── summary.js         # release summaries from conventional commits
    └── metrics.js         # DORA metrics
public/                    # dashboard (vanilla JS, no build step)
scripts/seed.js            # demo data
kubernetes/                # k3s manifests (ArgoCD)
test/                      # node:test — npm test
```

## Roadmap toward a paid product

The current build is single-workspace with one admin password. That's right for a homelab or one team. Before selling it to agencies:

1. **Multi-tenancy.** Organisations, users with email login or GitHub OAuth, and roles. Every table already hangs off `projects`, so this mostly means adding `org_id` and scoping queries.
2. **Postgres.** Swap `db.js` for Postgres for hosted, multi-instance deployments.
3. **Billing.** Razorpay subscriptions (₹999 / ₹2,999 tiers gated on projects, environments and history retention).
4. **Native integrations.** GitHub App (`deployment_status` / `workflow_run` webhooks with no CI changes), GitLab, Vercel and Netlify deploy hooks.
5. **Client-facing release notes.** Public, shareable changelog pages generated from release summaries, which is a strong selling point for agencies.
