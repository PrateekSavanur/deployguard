// DeployGuard dashboard — dependency-free SPA with hash routing.

// ── Utilities ────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Raw(s);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Tagged template: interpolations are escaped unless wrapped in raw(); arrays are joined.
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    const render = (x) => (x instanceof Raw ? x.s : x === false || x == null ? '' : esc(x));
    out += (Array.isArray(v) ? v.map(render).join('') : render(v)) + strings[i + 1];
  });
  return raw(out);
}

class ApiError extends Error {}
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth')) {
    showLogin();
    throw new ApiError('Signed out');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
const fullTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
function dur(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const deployDuration = (d) => (d.started_at && d.finished_at ? (new Date(d.finished_at) - new Date(d.started_at)) / 1000 : null);
const label = (d) => d?.version || d?.commit_sha?.slice(0, 7) || (d ? `#${d.id}` : '—');

function copy(text, what = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast(what), () => toast('Copy failed — select and copy manually'));
}

// ── Status presentation ──────────────────────────────────────────
function statusBadge(d) {
  if (d.status === 'succeeded') {
    if (d.verification === 'unhealthy') return html`<span class="badge critical">Unhealthy</span>`;
    if (d.verification === 'verifying') return html`<span class="badge active">Verifying</span>`;
    return html`<span class="badge good">${d.verification === 'healthy' ? 'Healthy' : 'Succeeded'}</span>`;
  }
  const map = {
    failed: ['critical', 'Failed'],
    rolled_back: ['warning', 'Rolled back'],
    cancelled: ['', 'Cancelled'],
    in_progress: ['active', 'Deploying'],
    queued: ['', 'Queued'],
  };
  const [cls, text] = map[d.status] || ['', d.status];
  return html`<span class="badge ${cls}">${text}</span>`;
}
const healthLabel = (status) =>
  ({ up: ['up', 'Up'], down: ['down', 'Down'], unknown: ['', 'No check'] })[status] || ['', status];

// ── Charts ───────────────────────────────────────────────────────
const tip = $('#tooltip');
function bindTooltips(root) {
  $$('[data-tip]', root).forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      tip.innerHTML = el.dataset.tip;
      tip.hidden = false;
      const pad = 14;
      const r = tip.getBoundingClientRect();
      let x = e.clientX + pad;
      let y = e.clientY + pad;
      if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
      if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
    el.addEventListener('pointerleave', () => (tip.hidden = true));
  });
}

// Stacked daily bars: succeeded (good) under failed (critical), 2px surface gap between segments.
function activityChart(daily) {
  const W = 760, H = 170, padL = 28, padB = 22, padT = 8;
  const max = Math.max(2, ...daily.map((d) => d.succeeded + d.failed));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const plotH = H - padB - padT;
  const slot = (W - padL) / daily.length;
  const bw = Math.max(3, Math.min(18, slot - 4));
  const y = (v) => padT + plotH - (v / top) * plotH;
  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text class="axis-label" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  let bars = '';
  daily.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const base = y(0);
    const sH = (d.succeeded / top) * plotH;
    const fH = (d.failed / top) * plotH;
    const r = Math.min(4, bw / 2);
    if (d.succeeded) bars += roundedBar(x, base - sH, bw, sH, d.failed ? 0 : r, 'var(--good)');
    if (d.failed) {
      const gap = d.succeeded ? 2 : 0;
      bars += roundedBar(x, base - sH - fH, bw, Math.max(0, fH - gap), r, 'var(--critical)');
    }
    const dayLabel = new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const tipHtml = `<strong>${dayLabel}</strong><br>${d.succeeded} succeeded · ${d.failed} failed`;
    bars += `<rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" data-tip="${esc(tipHtml)}"/>`;
    if (i % Math.ceil(daily.length / 6) === 0 || i === daily.length - 1) {
      bars += `<text class="axis-label" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${dayLabel}</text>`;
    }
  });
  const total = daily.reduce((a, d) => a + d.succeeded + d.failed, 0);
  return html`
    <div class="row" style="margin-bottom:8px">
      <div class="legend"><span><i style="background:var(--good)"></i>Succeeded</span><span><i style="background:var(--critical)"></i>Failed / rolled back / unhealthy</span></div>
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Deployments per day, ${total} in total">
      ${raw(grid)}${raw(bars)}
    </svg>`;
}
// Bar with only the top corners rounded (data-end), flat on the baseline.
function roundedBar(x, y, w, h, r, fill) {
  if (h <= 0) return '';
  r = Math.min(r, h);
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`;
}

function healthStrip(checks, slots = 60) {
  const recent = checks.slice(-slots);
  const pad = Array.from({ length: Math.max(0, slots - recent.length) }, () => '<span class="none"></span>').join('');
  const cells = recent
    .map((c) => {
      const t = `<strong>${c.ok ? 'OK' : 'Failed'}</strong> · ${esc(fullTime(c.at))}<br>${c.status_code ? `HTTP ${c.status_code}` : esc(c.error || '')} · ${c.latency_ms}ms`;
      return `<span class="${c.ok ? '' : 'fail'}" data-tip="${esc(t)}"></span>`;
    })
    .join('');
  return raw(`<div class="health-strip" role="img" aria-label="Last ${recent.length} health checks">${pad}${cells}</div>`);
}

function statTiles(m) {
  const cfr = m.changeFailureRate == null ? '—' : `${(m.changeFailureRate * 100).toFixed(m.changeFailureRate < 0.1 ? 1 : 0)}`;
  const restore = m.medianRestoreMinutes == null ? null : m.medianRestoreMinutes;
  const restoreText = restore == null ? ['—', ''] : restore < 60 ? [Math.round(restore), 'min'] : [(restore / 60).toFixed(1), 'h'];
  const lead = m.medianLeadTimeHours == null ? ['—', ''] : m.medianLeadTimeHours < 48 ? [m.medianLeadTimeHours.toFixed(1), 'h'] : [(m.medianLeadTimeHours / 24).toFixed(1), 'd'];
  const tile = (name, value, unit, hint) =>
    html`<div class="card stat"><div class="label">${name}</div><div class="value">${value}${unit ? html`<span class="unit">${unit}</span>` : ''}</div><div class="hint">${hint}</div></div>`;
  return html`<div class="grid cols-4">
    ${tile('Deploys / week', m.deploysPerWeek, '', `${m.succeeded} successful in ${m.days}d`)}
    ${tile('Change failure rate', cfr, cfr === '—' ? '' : '%', `${m.failed} of ${m.finished} deploys`)}
    ${tile('Time to restore', restoreText[0], restoreText[1], 'median, failure → healthy deploy')}
    ${tile('Lead time', lead[0], lead[1], m.medianLeadTimeHours == null ? 'send commit timestamps to enable' : 'median, commit → production')}
  </div>`;
}

// ── Shared pieces ────────────────────────────────────────────────
function deploymentsTable(rows, { showProject = true } = {}) {
  if (!rows.length) return html`<div class="card empty"><h2>No deployments yet</h2>Send one from CI — see <a href="#/docs">Connect CI</a>.</div>`;
  return html`<div class="card table-wrap"><table>
    <thead><tr>${showProject ? html`<th>Project</th>` : ''}<th>Environment</th><th>Version</th><th>Status</th><th>Deployer</th><th class="num">Duration</th><th class="num">When</th></tr></thead>
    <tbody>${rows.map(
      (d) => html`<tr class="clickable" data-href="#/deployments/${d.id}">
        ${showProject ? html`<td>${d.project_name}</td>` : ''}
        <td>${d.environment}</td>
        <td><a class="ver-cell" href="#/deployments/${d.id}">${label(d)}</a> ${d.is_rollback ? html`<span class="tag rollback">rollback</span>` : ''}
          ${d.branch ? html`<div class="sub">${d.branch}${d.commit_sha && d.version ? html` · <span class="mono">${d.commit_sha.slice(0, 7)}</span>` : ''}</div>` : ''}</td>
        <td>${statusBadge(d)}</td>
        <td>${d.deployer || html`<span class="faint">—</span>`}</td>
        <td class="num">${dur(deployDuration(d))}</td>
        <td class="num" title="${fullTime(d.created_at)}">${ago(d.created_at)}</td>
      </tr>`,
    )}</tbody></table></div>`;
}
function bindRowLinks(root) {
  $$('tr[data-href]', root).forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      location.hash = tr.dataset.href;
    }),
  );
}

function envCard(project, e, { link = true } = {}) {
  const d = e.latest;
  const [hcls, htext] = healthLabel(e.health_status);
  const running = e.current;
  const inner = html`
    <div class="env-name"><span>${e.name}</span>${e.health_url ? html`<span class="health-label"><i class="dot ${hcls}"></i>${htext}</span>` : ''}</div>
    <div class="ver" title="${label(running)}">${running ? label(running) : html`<span class="faint">nothing live</span>`}</div>
    <div class="row">${d ? statusBadge(d) : ''}${d && running && d.id !== running.id ? html`<span class="faint small">latest: ${label(d)}</span>` : ''}</div>
    <div class="when">${d ? `${ago(d.created_at)}${d.deployer ? ` by ${d.deployer}` : ''}` : 'no deployments'}</div>`;
  return link && d
    ? html`<a class="env" href="#/deployments/${d.id}">${inner}</a>`
    : html`<div class="env">${inner}</div>`;
}

function modal(content, onMount) {
  const dlg = $('#modal');
  dlg.innerHTML = String(content);
  dlg.showModal();
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  onMount?.(dlg);
  return dlg;
}

function codeBlock(code) {
  return html`<div class="code-block"><pre>${code}</pre><button class="btn small copy" type="button" data-copy="${code}">Copy</button></div>`;
}
function bindCopy(root) {
  $$('[data-copy]', root).forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));
}

// ── Views ────────────────────────────────────────────────────────
async function overviewView() {
  const data = await api('/api/overview');
  if (!data.projects.length) {
    return html`<div class="page-head"><div><h1>Welcome to DeployGuard</h1><div class="sub">Track every deploy across every environment.</div></div></div>
      <div class="card empty"><h2>Create your first project</h2><p>A project is one app or service. You'll get an API key to report deployments from CI.</p>
      <button class="btn primary" data-action="new-project">New project</button></div>`;
  }
  const problems = [
    ...data.down.map((e) => ({
      href: `#/projects/${e.project_slug}`,
      icon: '!', cls: '',
      title: html`<strong>${e.project_name} · ${e.name}</strong> is down`,
      sub: `health check failing since ${ago(e.health_changed_at)}`,
    })),
    ...data.attention.map((d) => ({
      href: `#/deployments/${d.id}`,
      icon: d.status === 'rolled_back' ? '↩' : '×',
      cls: d.status === 'rolled_back' ? 'warning' : '',
      title: html`<strong>${d.project_name} · ${d.environment}</strong> — ${label(d)} ${d.verification === 'unhealthy' ? 'failed health verification' : d.status === 'rolled_back' ? 'was rolled back' : 'failed'}`,
      sub: `${ago(d.created_at)}${d.deployer ? ` · ${d.deployer}` : ''}`,
    })),
  ];
  return html`
    <div class="page-head"><div><h1>Overview</h1><div class="sub">Last 30 days across ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}</div></div>
      <button class="btn" data-action="new-project">New project</button></div>
    <div class="card">
      ${problems.length
        ? html`<div class="alert-list">${problems.map((p) => html`<a class="alert-item" href="${p.href}"><span class="icon ${p.cls}">${p.icon}</span><div><div>${p.title}</div><div class="faint small">${p.sub}</div></div></a>`)}</div>`
        : html`<div class="all-clear"><i class="dot up"></i>All environments healthy — nothing needs attention.</div>`}
    </div>
    <div class="section">${statTiles(data.metrics)}</div>
    <div class="section"><div class="section-head"><h2>Environments</h2></div>
      <div class="matrix">${data.projects.map(
        (p) => html`<div class="card matrix-row">
          <div class="row"><a class="name" href="#/projects/${p.slug}">${p.name}</a><span class="spacer"></span><a class="small" href="#/deployments?project=${p.slug}">History →</a></div>
          ${p.environments.length
            ? html`<div class="env-strip">${p.environments.map((e) => envCard(p, e))}</div>`
            : html`<div class="faint small" style="margin-top:8px">No deployments yet — environments appear automatically on the first report.</div>`}
        </div>`,
      )}</div></div>
    <div class="section"><div class="section-head"><h2>Deploy activity</h2></div><div class="card pad">${activityChart(data.metrics.daily)}</div></div>
    <div class="section"><div class="section-head"><h2>Recent deployments</h2><a href="#/deployments">View all →</a></div>${deploymentsTable(data.recent)}</div>`;
}

async function projectsView() {
  const data = await api('/api/overview');
  return html`
    <div class="page-head"><div><h1>Projects</h1><div class="sub">Each project has its own API keys and environments.</div></div>
      <button class="btn primary" data-action="new-project">New project</button></div>
    ${data.projects.length
      ? html`<div class="card table-wrap"><table><thead><tr><th>Name</th><th>Environments</th><th>Repository</th><th class="num">Created</th></tr></thead><tbody>
        ${data.projects.map(
          (p) => html`<tr class="clickable" data-href="#/projects/${p.slug}"><td><a href="#/projects/${p.slug}"><strong>${p.name}</strong></a><div class="sub mono">${p.slug}</div></td>
          <td>${p.environments.map((e) => html`<span class="tag" style="margin-right:4px"><i class="dot ${healthLabel(e.health_status)[0]}"></i> ${e.name}</span>`)}</td>
          <td class="small">${p.repo_url ? html`<a href="${p.repo_url}" target="_blank" rel="noopener">${p.repo_url.replace(/^https?:\/\//, '')}</a>` : html`<span class="faint">—</span>`}</td>
          <td class="num">${ago(p.created_at)}</td></tr>`,
        )}</tbody></table></div>`
      : html`<div class="card empty"><h2>No projects yet</h2><button class="btn primary" data-action="new-project">Create one</button></div>`}`;
}

async function projectView(slug) {
  const [data, deps] = await Promise.all([
    api(`/api/projects/${encodeURIComponent(slug)}`),
    api(`/api/deployments?project=${encodeURIComponent(slug)}&limit=15`),
  ]);
  const { project, environments, keys, metrics } = data;
  const healthData = await Promise.all(
    environments.filter((e) => e.health_url).map((e) => api(`/api/environments/${e.id}/health?hours=24`).then((h) => [e.id, h])),
  );
  const healthById = Object.fromEntries(healthData);

  const envPanel = (e) => {
    const h = healthById[e.id];
    return html`<div class="card pad">
      <div class="row"><h2>${e.name}</h2>${e.health_url ? html`<span class="badge ${e.health_status === 'up' ? 'good' : e.health_status === 'down' ? 'critical' : ''}">${healthLabel(e.health_status)[1]}</span>` : ''}
        <span class="spacer"></span>
        ${e.health_url ? html`<button class="btn small" data-check="${e.id}">Check now</button>` : ''}
        <button class="btn small ghost" data-edit-env="${e.id}">Configure</button></div>
      <div class="row" style="margin-top:10px;gap:18px">
        <div><div class="faint small">Live version</div><div class="mono" style="font-weight:600">${e.current ? html`<a href="#/deployments/${e.current.id}">${label(e.current)}</a>` : '—'}</div></div>
        <div><div class="faint small">Last deploy</div><div>${e.latest ? html`${statusBadge(e.latest)} <span class="faint small">${ago(e.latest.created_at)}</span>` : '—'}</div></div>
        ${h ? html`<div><div class="faint small">Uptime 24h</div><div style="font-weight:600">${h.uptime == null ? '—' : `${(h.uptime * 100).toFixed(2)}%`}</div></div>` : ''}
        ${e.last_check ? html`<div><div class="faint small">Latency</div><div style="font-weight:600">${e.last_check.latency_ms}ms</div></div>` : ''}
      </div>
      ${e.health_url
        ? html`<div style="margin-top:12px">${healthStrip(h?.checks || [])}<div class="row faint small" style="margin-top:4px"><span>24h ago</span><span class="spacer"></span><span class="mono">${e.health_url}</span><span class="spacer"></span><span>now</span></div></div>`
        : html`<div class="faint small" style="margin-top:12px">No health check. <a href="#" data-edit-env="${e.id}">Add a health URL</a> to verify deploys and get downtime alerts.</div>`}
    </div>`;
  };

  const content = html`
    <div class="crumbs"><a href="#/projects">Projects</a> /</div>
    <div class="page-head"><div><h1>${project.name}</h1>
      <div class="sub">${project.repo_url ? html`<a href="${project.repo_url}" target="_blank" rel="noopener">${project.repo_url.replace(/^https?:\/\//, '')}</a>` : 'No repository linked'}</div></div>
      <div class="row"><a class="btn" href="#/docs?project=${project.slug}">Connect CI</a><button class="btn" data-action="edit-project">Settings</button></div></div>
    ${statTiles(metrics)}
    <div class="section"><div class="section-head"><h2>Environments</h2></div>
      ${environments.length
        ? html`<div class="grid cols-2">${environments.map(envPanel)}</div>`
        : html`<div class="card empty"><h2>Waiting for the first deployment</h2>Environments are created automatically when CI reports a deploy. <a href="#/docs?project=${project.slug}">See setup →</a></div>`}
    </div>
    <div class="section"><div class="section-head"><h2>Deploy activity</h2></div><div class="card pad">${activityChart(metrics.daily)}</div></div>
    <div class="section"><div class="section-head"><h2>Recent deployments</h2><a href="#/deployments?project=${project.slug}">View all →</a></div>${deploymentsTable(deps.deployments, { showProject: false })}</div>
    <div class="section"><div class="section-head"><h2>API keys</h2><button class="btn small" data-action="new-key">New key</button></div>
      <div class="card table-wrap"><table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
      ${keys.length
        ? keys.map((k) => html`<tr><td>${k.name}</td><td class="mono">${k.prefix}…</td><td>${ago(k.created_at)}</td><td>${k.last_used_at ? ago(k.last_used_at) : html`<span class="faint">never</span>`}</td><td class="num"><button class="btn small ghost danger" data-revoke="${k.id}">Revoke</button></td></tr>`)
        : html`<tr><td colspan="5" class="faint">No keys — CI can't report deployments until you create one.</td></tr>`}
      </tbody></table></div></div>`;
  return { content, data };
}

function bindProject(slug, data) {
  $$('[data-check]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api(`/api/environments/${b.dataset.check}/check`, { method: 'POST', body: {} });
        toast(r.ok ? `Healthy — HTTP ${r.statusCode} in ${r.latencyMs}ms` : `Failing — ${r.error || `HTTP ${r.statusCode}`}`);
        route();
      } catch (e) {
        toast(e.message);
        b.disabled = false;
      }
    }),
  );
  $$('[data-edit-env]').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      const env = data.environments.find((e) => e.id === Number(b.dataset.editEnv));
      modal(
        html`<form method="dialog" id="env-form"><h2>Configure ${env.name}</h2>
          <label>Health check URL<input name="health_url" type="url" placeholder="https://staging.example.com/healthz" value="${env.health_url || ''}"></label>
          <p class="muted small" style="margin:0">Polled continuously. After each successful deploy it's checked more often to verify the release; repeated failures mark the deploy unhealthy and alert you. Any 2xx/3xx response counts as healthy.</p>
          <label>Display order<input name="position" type="number" value="${env.position}"></label>
          <p class="error"></p>
          <div class="modal-actions"><button class="btn ghost danger" type="button" data-delete-env style="margin-right:auto">Delete environment</button><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`,
        (dlg) => {
          $('form', dlg).addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = new FormData(e.target);
            try {
              await api(`/api/environments/${env.id}`, { method: 'PATCH', body: { health_url: f.get('health_url'), position: Number(f.get('position')) } });
              dlg.close();
              toast('Environment saved');
              route();
            } catch (err) {
              $('.error', dlg).textContent = err.message;
            }
          });
          $('[data-delete-env]', dlg).addEventListener('click', async () => {
            if (!confirm(`Delete ${env.name} and all of its deployment history?`)) return;
            await api(`/api/environments/${env.id}`, { method: 'DELETE' });
            dlg.close();
            route();
          });
        },
      );
    }),
  );
  $$('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Revoke this key? Pipelines using it will start getting 401s.')) return;
      await api(`/api/keys/${b.dataset.revoke}`, { method: 'DELETE' });
      toast('Key revoked');
      route();
    }),
  );
  $('[data-action="new-key"]')?.addEventListener('click', () =>
    modal(
      html`<form id="key-form"><h2>New API key</h2><label>Name<input name="name" placeholder="github-actions" required></label><p class="error"></p>
        <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Create</button></div></form>`,
      (dlg) =>
        $('form', dlg).addEventListener('submit', async (e) => {
          e.preventDefault();
          const k = await api(`/api/projects/${slug}/keys`, { method: 'POST', body: { name: new FormData(e.target).get('name') } });
          showKey(k.key);
          route();
        }),
    ),
  );
  $('[data-action="edit-project"]')?.addEventListener('click', () => {
    const p = data.project;
    modal(
      html`<form id="proj-form"><h2>Project settings</h2>
        <label>Name<input name="name" value="${p.name}" required></label>
        <label>Repository URL<input name="repo_url" type="url" value="${p.repo_url || ''}" placeholder="https://github.com/acme/web"></label>
        <p class="muted small" style="margin:0">With a GitHub URL, DeployGuard links diffs between releases and fetches commit lists when CI doesn't send them.</p>
        <p class="error"></p>
        <div class="modal-actions"><button class="btn ghost danger" type="button" data-delete style="margin-right:auto">Delete project</button><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`,
      (dlg) => {
        $('form', dlg).addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = new FormData(e.target);
          try {
            await api(`/api/projects/${slug}`, { method: 'PATCH', body: { name: f.get('name'), repo_url: f.get('repo_url') } });
            dlg.close();
            route();
          } catch (err) {
            $('.error', dlg).textContent = err.message;
          }
        });
        $('[data-delete]', dlg).addEventListener('click', async () => {
          if (prompt(`Type "${slug}" to delete this project and all its history`) !== slug) return;
          await api(`/api/projects/${slug}`, { method: 'DELETE' });
          dlg.close();
          location.hash = '#/projects';
        });
      },
    );
  });
}

function showKey(key) {
  modal(
    html`<div class="modal-body"><h2>Your API key</h2>
      <p class="muted" style="margin:0">Copy it now — it's stored hashed and won't be shown again. Add it to your CI secrets as <code>DEPLOYGUARD_API_KEY</code>.</p>
      <div class="key-reveal">${key}</div>
      <div class="modal-actions"><button class="btn" type="button" data-copy="${key}">Copy key</button><button class="btn primary" type="button" data-close>Done</button></div></div>`,
    bindCopy,
  );
}

function newProjectModal() {
  modal(
    html`<form><h2>New project</h2>
      <label>Name<input name="name" placeholder="Checkout API" required autofocus></label>
      <label>Repository URL <span class="faint" style="font-weight:400">optional</span><input name="repo_url" type="url" placeholder="https://github.com/acme/checkout"></label>
      <p class="error"></p>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Create project</button></div></form>`,
    (dlg) =>
      $('form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const r = await api('/api/projects', { method: 'POST', body: { name: f.get('name'), repo_url: f.get('repo_url') } });
          location.hash = `#/projects/${r.project.slug}`;
          showKey(r.api_key.key);
        } catch (err) {
          $('.error', dlg).textContent = err.message;
        }
      }),
  );
}

async function deploymentsView(params) {
  const overview = await api('/api/overview');
  const q = new URLSearchParams(params);
  q.set('limit', '50');
  const data = await api(`/api/deployments?${q}`);
  const project = overview.projects.find((p) => p.slug === params.get('project'));
  const envNames = [...new Set((project ? [project] : overview.projects).flatMap((p) => p.environments.map((e) => e.name)))];
  const sel = (name, options, current) =>
    html`<select name="${name}" aria-label="${name}">${options.map(([v, t]) => html`<option value="${v}" ${v === (current || '') ? raw('selected') : ''}>${t}</option>`)}</select>`;
  return html`
    <div class="page-head"><div><h1>Deployments</h1><div class="sub">Every reported deploy, newest first.</div></div></div>
    <form class="filters" id="filters">
      ${sel('project', [['', 'All projects'], ...overview.projects.map((p) => [p.slug, p.name])], params.get('project'))}
      ${sel('environment', [['', 'All environments'], ...envNames.map((n) => [n, n])], params.get('environment'))}
      ${sel('status', [['', 'Any status'], ['problem', 'Problems only'], ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['rolled_back', 'Rolled back'], ['in_progress', 'In progress'], ['cancelled', 'Cancelled']], params.get('status'))}
      <input type="search" name="q" placeholder="Search version, SHA, branch, deployer" value="${params.get('q') || ''}">
    </form>
    <div id="dep-table">${deploymentsTable(data.deployments)}</div>
    ${data.has_more ? html`<div class="row" style="justify-content:center;margin-top:14px"><button class="btn" id="more" data-before="${data.deployments.at(-1).id}">Load more</button></div>` : ''}`;
}
function bindDeployments(params) {
  const form = $('#filters');
  const apply = () => {
    const f = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) f.set(k, v);
    location.hash = `#/deployments${f.size ? `?${f}` : ''}`;
  };
  $$('select', form).forEach((s) => s.addEventListener('change', apply));
  let t;
  $('input', form).addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(apply, 350);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    apply();
  });
  $('#more')?.addEventListener('click', async function more() {
    const btn = $('#more');
    const q = new URLSearchParams(params);
    q.set('before', btn.dataset.before);
    q.set('limit', '50');
    const data = await api(`/api/deployments?${q}`);
    const tmp = document.createElement('div');
    tmp.innerHTML = String(deploymentsTable(data.deployments));
    $$('tbody tr', tmp).forEach((tr) => $('#dep-table tbody').append(tr));
    bindRowLinks($('#dep-table'));
    if (data.has_more) btn.dataset.before = data.deployments.at(-1).id;
    else btn.remove();
  });
}

const EVENT_TEXT = {
  created: 'Deployment reported', queued: 'Queued', in_progress: 'Deploy started', succeeded: 'Deploy succeeded',
  failed: 'Deploy failed', rolled_back: 'Rolled back', cancelled: 'Cancelled', rollback_detected: 'Detected as a rollback',
  verification_started: 'Health verification started', verification_passed: 'Health verification passed',
  verification_failed: 'Health verification failed', verification_superseded: 'Verification stopped', commits_enriched: 'Commits loaded',
};
const EVENT_CLASS = {
  succeeded: 'good', verification_passed: 'good', failed: 'critical', verification_failed: 'critical',
  rolled_back: 'warning', rollback_detected: 'warning', in_progress: 'active', verification_started: 'active',
};

async function deploymentView(id) {
  const data = await api(`/api/deployments/${id}`);
  const { deployment: d, commits, events, checks, previous, summary, alerts } = data;
  const verifyBox =
    d.verification === 'unhealthy'
      ? html`<div class="callout critical"><span class="badge critical">Unhealthy</span>Health checks failed after this deploy. Consider rolling back to ${previous ? html`<a href="#/deployments/${previous.id}" class="mono">${label(previous)}</a>` : 'the previous release'}.</div>`
      : d.verification === 'verifying'
        ? html`<div class="callout"><span class="badge active">Verifying</span>Watching health checks for this release${d.verify_until ? ` until ${new Date(d.verify_until).toLocaleTimeString()}` : ''}.</div>`
        : d.verification === 'healthy'
          ? html`<div class="callout good"><span class="badge good">Healthy</span>Passed post-deploy health verification.</div>`
          : '';
  const fact = (k, v) => html`<div><dt>${k}</dt><dd>${v || html`<span class="faint">—</span>`}</dd></div>`;
  return html`
    <div class="crumbs"><a href="#/projects/${d.project_slug}">${d.project_name}</a> / <a href="#/deployments?project=${d.project_slug}&environment=${d.environment}">${d.environment}</a> /</div>
    <div class="page-head"><div>
        <div class="row"><h1 class="mono">${label(d)}</h1>${statusBadge(d)}${d.is_rollback ? html`<span class="tag rollback">rollback</span>` : ''}</div>
        <div class="sub">${summary.headline} to <strong>${d.environment}</strong> · ${fullTime(d.created_at)}</div></div>
      <div class="row">
        ${previous ? html`<a class="btn small" href="#/deployments/${previous.id}">← Previous</a>` : ''}
        ${data.next_id ? html`<a class="btn small" href="#/deployments/${data.next_id}">Next →</a>` : ''}
      </div></div>
    ${verifyBox}
    <div class="card section" style="margin-top:${verifyBox ? 16 : 0}px"><dl class="facts" style="margin:0">
      ${fact('Environment', d.environment)}
      ${fact('Previous release', previous ? html`<a class="mono" href="#/deployments/${previous.id}">${label(previous)}</a>` : null)}
      ${fact('Commit', d.commit_sha ? html`<span class="mono">${d.commit_sha.slice(0, 12)}</span>` : null)}
      ${fact('Branch', d.branch)}
      ${fact('Deployer', d.deployer)}
      ${fact('Duration', deployDuration(d) == null ? null : dur(deployDuration(d)))}
      ${fact('Source', d.source)}
      ${fact('CI run', d.ci_url ? html`<a href="${d.ci_url}" target="_blank" rel="noopener">Open ↗</a>` : null)}
    </dl></div>
    ${d.message ? html`<div class="card pad section"><h3>Message</h3><p style="margin:6px 0 0;white-space:pre-wrap">${d.message}</p></div>` : ''}

    <div class="section"><div class="section-head"><h2>Release summary</h2>
      <div class="row">${d.compare_url ? html`<a class="btn small" href="${d.compare_url}" target="_blank" rel="noopener">Full diff ↗</a>` : ''}<button class="btn small" data-copy="${summary.markdown}">Copy as Markdown</button></div></div>
      <div class="card pad">
        ${commits.length
          ? html`<div class="muted">${summary.changeCount} change${summary.changeCount === 1 ? '' : 's'} since ${previous ? html`<span class="mono">${label(previous)}</span>` : 'the start'} from ${summary.contributors.length} contributor${summary.contributors.length === 1 ? '' : 's'}${summary.contributors.length ? `: ${summary.contributors.join(', ')}` : ''}.</div>
            ${summary.groups.map(
              (g) => html`<div class="summary-group"><h4>${g.emoji} ${g.title}</h4><ul>${g.items.map(
                (it) => html`<li>${it.scope ? html`<strong>${it.scope}:</strong> ` : ''}${it.subject} <span class="meta">${it.url ? html`<a class="mono" href="${it.url}" target="_blank" rel="noopener">${it.sha.slice(0, 7)}</a>` : html`<span class="mono">${it.sha.slice(0, 7)}</span>`}${it.author ? ` · ${it.author}` : ''}</span></li>`,
              )}</ul></div>`,
            )}`
          : html`<div class="muted">${previous ? 'No commit details were reported for this release. Send a commits array from CI, or link a GitHub repository to fill this in automatically.' : 'First tracked deployment to this environment.'}</div>`}
      </div></div>

    ${checks.length
      ? html`<div class="section"><div class="section-head"><h2>Post-deploy health checks</h2><span class="faint small">${checks.filter((c) => c.ok).length}/${checks.length} passed</span></div>
        <div class="card pad">${healthStrip(checks, Math.max(20, checks.length))}</div></div>`
      : ''}

    <div class="grid cols-2 section">
      <div><div class="section-head"><h2>Timeline</h2></div><div class="card"><ol class="timeline">${events.map(
        (e) => html`<li class="${EVENT_CLASS[e.kind] || ''}"><span class="tl-dot"></span><div>${EVENT_TEXT[e.kind] || e.kind}${e.message ? html`<div class="faint small">${e.message}</div>` : ''}</div><span class="faint small" title="${fullTime(e.at)}">${new Date(e.at).toLocaleTimeString()}</span></li>`,
      )}</ol></div></div>
      <div><div class="section-head"><h2>Alerts sent</h2></div><div class="card">${alerts.length
        ? html`<ol class="timeline">${alerts.map((a) => html`<li class="${a.delivered ? 'good' : 'critical'}"><span class="tl-dot"></span><div>${a.title}<div class="faint small">${a.delivered ? 'Delivered' : `Not delivered: ${a.error}`}</div></div><span class="faint small">${new Date(a.at).toLocaleTimeString()}</span></li>`)}</ol>`
        : html`<div class="empty small">No alerts for this deployment.</div>`}</div></div>
    </div>

    ${commits.length
      ? html`<div class="section"><div class="section-head"><h2>Commits (${commits.length})</h2></div><div class="card">${commits.map(
          (c) => html`<div class="commit">${c.url ? html`<a class="sha" href="${c.url}" target="_blank" rel="noopener">${c.sha.slice(0, 7)}</a>` : html`<span class="sha">${c.sha.slice(0, 7)}</span>`}<span class="msg" title="${c.message}">${c.message.split('\n')[0]}</span><span class="faint small">${c.author || ''}</span></div>`,
        )}</div></div>`
      : ''}
    ${d.metadata ? html`<div class="section"><div class="section-head"><h2>Metadata</h2></div><pre>${JSON.stringify(d.metadata, null, 2)}</pre></div>` : ''}`;
}

async function alertsView() {
  const [ch, log, overview] = await Promise.all([api('/api/channels'), api('/api/alerts?limit=100'), api('/api/overview')]);
  const projName = (id) => overview.projects.find((p) => p.id === id)?.name || 'All projects';
  return html`
    <div class="page-head"><div><h1>Alerts</h1><div class="sub">Where DeployGuard sends failure, rollback and downtime notifications.</div></div>
      <button class="btn primary" data-action="new-channel">Add channel</button></div>
    ${ch.channels.length
      ? html`<div class="card table-wrap"><table><thead><tr><th>Channel</th><th>Scope</th><th>Events</th><th>Status</th><th></th></tr></thead><tbody>
        ${ch.channels.map(
          (c) => html`<tr><td><strong>${c.name}</strong><div class="sub">${c.type} · <span class="mono">${c.config.webhook_url || c.config.url || (c.config.chat_id ? `chat ${c.config.chat_id}` : '')}</span></div></td>
            <td>${projName(c.project_id)}</td>
            <td class="small">${c.events.map((e) => ch.kinds[e]?.label || e).join(', ')}</td>
            <td><span class="badge ${c.enabled ? 'good' : ''}">${c.enabled ? 'On' : 'Paused'}</span></td>
            <td class="num"><div class="row" style="justify-content:flex-end"><button class="btn small" data-test="${c.id}">Send test</button><button class="btn small ghost" data-toggle="${c.id}" data-enabled="${c.enabled}">${c.enabled ? 'Pause' : 'Resume'}</button><button class="btn small ghost danger" data-del="${c.id}">Delete</button></div></td></tr>`,
        )}</tbody></table></div>`
      : html`<div class="card empty"><h2>No alert channels</h2><p>Add Slack, Discord, Telegram or a webhook (e.g. Homelert) so failed deploys reach you.</p><button class="btn primary" data-action="new-channel">Add channel</button></div>`}
    <div class="section"><div class="section-head"><h2>Delivery log</h2></div>
      ${log.length
        ? html`<div class="card table-wrap"><table><thead><tr><th>Alert</th><th>Channel</th><th>Result</th><th class="num">When</th></tr></thead><tbody>
          ${log.map((a) => html`<tr ${a.deployment_id ? raw(`class="clickable" data-href="#/deployments/${a.deployment_id}"`) : ''}><td>${a.title}</td><td>${a.channel_name || html`<span class="faint">—</span>`}</td>
            <td>${a.delivered ? html`<span class="badge good">Delivered</span>` : html`<span class="badge ${a.channel_id ? 'critical' : ''}">${a.channel_id ? 'Failed' : 'No channel'}</span><div class="sub">${a.channel_id ? a.error : 'No channel subscribed to this event'}</div>`}</td>
            <td class="num" title="${fullTime(a.at)}">${ago(a.at)}</td></tr>`)}
          </tbody></table></div>`
        : html`<div class="card empty small">Nothing sent yet.</div>`}</div>`;
}
function bindAlerts() {
  $$('[data-test]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/channels/${b.dataset.test}/test`, { method: 'POST', body: {} });
        toast('Test alert delivered');
      } catch (e) {
        toast(`Test failed: ${e.message}`);
      }
      b.disabled = false;
    }),
  );
  $$('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/api/channels/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: b.dataset.enabled !== 'true' } });
      route();
    }),
  );
  $$('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Delete this channel?')) return;
      await api(`/api/channels/${b.dataset.del}`, { method: 'DELETE' });
      route();
    }),
  );
  $$('[data-action="new-channel"]').forEach((b) => b.addEventListener('click', newChannelModal));
}

async function newChannelModal() {
  const [{ kinds }, overview] = await Promise.all([api('/api/channels'), api('/api/overview')]);
  const defaults = ['deploy_failed', 'deploy_rolled_back', 'verification_failed', 'env_down', 'env_recovered', 'rollback'];
  const fields = {
    slack: [['webhook_url', 'Incoming webhook URL', 'https://hooks.slack.com/services/…']],
    discord: [['webhook_url', 'Webhook URL', 'https://discord.com/api/webhooks/…']],
    telegram: [['bot_token', 'Bot token', '123456:ABC…'], ['chat_id', 'Chat ID', '-1001234567890']],
    webhook: [['url', 'URL', 'http://homelert.homelab.svc:3000/webhook/deployguard'], ['secret', 'Signing secret (optional)', 'adds X-DeployGuard-Signature']],
  };
  const renderFields = (type) =>
    fields[type].map(([k, l, ph]) => html`<label>${l}<input name="cfg_${k}" placeholder="${ph}" ${k === 'secret' ? '' : raw('required')}></label>`).join('');
  modal(
    html`<form><h2>Add alert channel</h2>
      <div class="grid cols-2"><label>Name<input name="name" placeholder="#deploys" required></label>
      <label>Type<select name="type"><option value="slack">Slack</option><option value="discord">Discord</option><option value="telegram">Telegram</option><option value="webhook">Webhook / Homelert</option></select></label></div>
      <div id="cfg-fields" style="display:flex;flex-direction:column;gap:14px">${raw(renderFields('slack'))}</div>
      <label>Projects<select name="project_id"><option value="">All projects</option>${overview.projects.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
      <fieldset style="border:0;padding:0;margin:0"><legend class="muted small" style="font-weight:550;margin-bottom:6px">Notify on</legend><div class="checks">
        ${Object.entries(kinds).map(([k, v]) => html`<label><input type="checkbox" name="events" value="${k}" ${defaults.includes(k) ? raw('checked') : ''}>${v.label}</label>`)}
      </div></fieldset>
      <p class="error"></p>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary">Add channel</button></div></form>`,
    (dlg) => {
      const form = $('form', dlg);
      form.type.addEventListener('change', () => ($('#cfg-fields', dlg).innerHTML = renderFields(form.type.value)));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(form);
        const config = {};
        for (const [k, v] of f) if (k.startsWith('cfg_') && v) config[k.slice(4)] = v;
        try {
          await api('/api/channels', {
            method: 'POST',
            body: { name: f.get('name'), type: f.get('type'), config, events: f.getAll('events'), project_id: Number(f.get('project_id')) || null },
          });
          dlg.close();
          toast('Channel added — try "Send test"');
          route();
        } catch (err) {
          $('.error', dlg).textContent = err.message;
        }
      });
    },
  );
}

async function docsView(params) {
  const overview = await api('/api/overview');
  const slug = params.get('project');
  const base = location.origin;
  const snippets = {
    curl: `# Report a deploy (all fields except environment + version/commit_sha are optional)
curl -X POST ${base}/api/v1/deployments \\
  -H "Authorization: Bearer $DEPLOYGUARD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "environment": "production",
    "version": "v1.4.2",
    "commit_sha": "'"$(git rev-parse HEAD)"'",
    "branch": "main",
    "status": "succeeded",
    "deployer": "'"$USER"'",
    "health_url": "https://app.example.com/healthz"
  }'`,
    github: `# .github/workflows/deploy.yml (excerpt)
env:
  DG_URL: ${base}/api/v1/deployments
  DG_ENV: production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 50 }

      - name: DeployGuard — started
        run: |
          curl -fsS -X POST "$DG_URL" \\
            -H "Authorization: Bearer \${{ secrets.DEPLOYGUARD_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            -d '{"environment":"'"$DG_ENV"'","version":"\${{ github.sha }}","commit_sha":"\${{ github.sha }}",
                 "branch":"\${{ github.ref_name }}","deployer":"\${{ github.actor }}","status":"started",
                 "external_id":"\${{ github.run_id }}-\${{ github.run_attempt }}","source":"github-actions",
                 "ci_url":"\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"}'

      # ... your existing deploy steps ...

      - name: DeployGuard — finished
        if: always()
        run: |
          STATUS=\${{ job.status == 'success' && 'succeeded' || job.status == 'cancelled' && 'cancelled' || 'failed' }}
          curl -fsS -X POST "$DG_URL" \\
            -H "Authorization: Bearer \${{ secrets.DEPLOYGUARD_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            -d '{"environment":"'"$DG_ENV"'","status":"'"$STATUS"'",
                 "external_id":"\${{ github.run_id }}-\${{ github.run_attempt }}"}'`,
    gate: `# Optional: fail the pipeline if the release doesn't pass health verification
ID=$(curl -fsS -X POST "$DG_URL" -H "Authorization: Bearer $DEPLOYGUARD_API_KEY" \\
       -H "Content-Type: application/json" -d "$PAYLOAD" | jq -r .id)
for i in $(seq 1 40); do
  V=$(curl -fsS "${base}/api/v1/deployments/$ID" -H "Authorization: Bearer $DEPLOYGUARD_API_KEY" | jq -r .verification)
  case "$V" in
    healthy|none) echo "release verified"; exit 0 ;;
    unhealthy)    echo "release failed health verification"; exit 1 ;;
  esac
  sleep 15
done
echo "verification timed out"; exit 1`,
    argocd: `# Argo CD Notifications (Helm values) — every Application sync becomes a deployment.
# Uses the workspace INTEGRATION_API_KEY, so one webhook covers all apps: "project" is the app name.
notifications:
  enabled: true
  secret:
    create: false          # argocd-notifications-secret holds deployguard-integration-key
  notifiers:
    service.webhook.deployguard: |
      url: ${base}/api/v1/deployments
      headers:
        - name: Authorization
          value: Bearer $deployguard-integration-key
        - name: Content-Type
          value: application/json
  subscriptions:
    - recipients: [deployguard]
      triggers: [on-deployguard-sync-running, on-deployguard-sync-finished]
  templates:
    template.deployguard-sync: |
      webhook:
        deployguard:
          method: POST
          body: |
            {"project": "{{.app.metadata.name}}", "environment": "homelab",
             "commit_sha": "{{.app.status.sync.revision}}", "repo_url": "{{.app.spec.source.repoURL}}",
             "status": "{{if eq .app.status.operationState.phase "Running"}}started{{else if eq .app.status.operationState.phase "Succeeded"}}succeeded{{else}}failed{{end}}",
             "external_id": "{{.app.metadata.name}}@{{.app.status.operationState.startedAt}}",
             "source": "argocd", "ci_url": "{{.context.argocdUrl}}/applications/{{.app.metadata.name}}"}
  triggers:
    trigger.on-deployguard-sync-running: |
      - when: app.status.operationState != nil and app.status.operationState.phase in ['Running']
        oncePer: app.status.operationState.startedAt
        send: [deployguard-sync]
    trigger.on-deployguard-sync-finished: |
      - when: app.status.operationState != nil and app.status.operationState.phase in ['Succeeded', 'Error', 'Failed']
        oncePer: app.status.operationState.startedAt
        send: [deployguard-sync]`,
  };
  const payload = `{
  "environment": "production",        // required — created automatically on first use
  "version": "v1.4.2",                 // version OR commit_sha required
  "commit_sha": "9f2c1e7…",
  "status": "succeeded",               // started | succeeded | failed | rolled_back | cancelled (aliases accepted)
  "external_id": "ci-run-8812",        // send twice (start + finish) with the same id to update one deploy
  "branch": "main",
  "deployer": "asha",
  "ci_url": "https://ci.example.com/run/8812",
  "message": "Release notes or failure reason",
  "rollback": false,                   // optional — rollbacks to older versions are also auto-detected
  "health_url": "https://app.example.com/healthz",  // enables post-deploy verification
  "commits": [                         // optional — powers the release summary
    { "sha": "9f2c1e7…", "message": "feat(cart): coupons", "author": "asha", "timestamp": "2026-10-12T09:30:00Z" }
  ],
  "metadata": { "image": "ghcr.io/acme/app:9f2c1e7" }
}`;
  return html`<div class="prose">
    <div class="page-head"><div><h1>Connect CI</h1><div class="sub">One HTTP call per deploy. Works with any CI/CD system.</div></div></div>
    <div class="card pad">
      <div class="row"><strong>1.</strong> Create a project and copy its API key
        ${overview.projects.length ? html`<span class="faint">— you have ${overview.projects.length}: ${overview.projects.map((p, i) => html`${i ? ', ' : ''}<a href="#/projects/${p.slug}">${p.name}</a>`)}</span>` : html`<button class="btn small primary" data-action="new-project">New project</button>`}</div>
      <div class="row" style="margin-top:8px"><strong>2.</strong> Store it as a CI secret named <code>DEPLOYGUARD_API_KEY</code></div>
      <div class="row" style="margin-top:8px"><strong>3.</strong> Add a step that reports the deploy (below)${slug ? html` <span class="faint">for <strong>${slug}</strong></span>` : ''}</div>
    </div>
    <h2>Report a deployment</h2>
    <div class="tabs" role="tablist">${[['github', 'GitHub Actions'], ['curl', 'curl / any CI'], ['argocd', 'Argo CD'], ['gate', 'Verification gate']].map(
      ([k, t], i) => html`<button type="button" role="tab" data-tab="${k}" class="${i === 0 ? 'on' : ''}">${t}</button>`,
    )}</div>
    ${Object.entries(snippets).map(([k, code]) => html`<div data-pane="${k}" ${k === 'github' ? '' : raw('hidden')}>${codeBlock(code)}</div>`)}
    <h2>Payload reference</h2>
    <pre>${payload}</pre>
    <h2>What DeployGuard does with it</h2>
    <p><strong>History & what changed.</strong> Each deploy is linked to the previous successful one in the same environment. Commits you send (or that are fetched from GitHub for linked repos) are grouped into a release summary you can paste into Slack or a client update.</p>
    <p><strong>Health verification.</strong> When an environment has a health URL, a successful deploy is watched closely for a few minutes. Repeated failures mark it <em>unhealthy</em>, count it toward change-failure rate and send an alert.</p>
    <p><strong>Rollbacks.</strong> Re-deploying a version that an older release shipped is flagged as a rollback automatically.</p>
  </div>`;
}
function bindDocs() {
  $$('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      $$('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    }),
  );
}

// ── Router ───────────────────────────────────────────────────────
let refreshTimer;
async function route() {
  clearTimeout(refreshTimer);
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);
  const section = parts[0] || 'overview';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section || (section === 'projects' && a.dataset.nav === 'projects')));

  try {
    let content;
    let bind = () => {};
    if (section === 'overview') {
      content = await overviewView();
      document.title = 'Overview · DeployGuard';
    } else if (section === 'projects' && parts[1]) {
      const slug = decodeURIComponent(parts[1]);
      const result = await projectView(slug);
      const { data } = result;
      content = result.content;
      bind = () => bindProject(slug, data);
      document.title = `${data.project.name} · DeployGuard`;
    } else if (section === 'projects') {
      content = await projectsView();
      document.title = 'Projects · DeployGuard';
    } else if (section === 'deployments' && parts[1]) {
      content = await deploymentView(Number(parts[1]));
      document.title = `Deployment #${parts[1]} · DeployGuard`;
    } else if (section === 'deployments') {
      content = await deploymentsView(params);
      bind = () => bindDeployments(params);
      document.title = 'Deployments · DeployGuard';
    } else if (section === 'alerts') {
      content = await alertsView();
      bind = bindAlerts;
      document.title = 'Alerts · DeployGuard';
    } else if (section === 'docs') {
      content = await docsView(params);
      bind = bindDocs;
      document.title = 'Connect CI · DeployGuard';
    } else {
      content = html`<div class="card empty"><h2>Not found</h2><a href="#/">Back to overview</a></div>`;
    }
    const keepScroll = route.lastHash === location.hash;
    const y = scrollY;
    view.innerHTML = String(content);
    if (keepScroll) scrollTo(0, y);
    else scrollTo(0, 0);
    route.lastHash = location.hash;
    bind();
    bindRowLinks(view);
    bindTooltips(view);
    bindCopy(view);
    $$('[data-action="new-project"]', view).forEach((b) => b.addEventListener('click', newProjectModal));
    // Live-ish: refresh dashboards every 20s while the tab is visible and no dialog is open.
    if (['overview', 'projects', 'deployments'].includes(section)) {
      refreshTimer = setTimeout(function tick() {
        if (document.visibilityState === 'visible' && !$('#modal').open && !view.contains(document.activeElement)) route();
        else refreshTimer = setTimeout(tick, 20_000);
      }, 20_000);
    }
  } catch (err) {
    if (err instanceof ApiError && err.message === 'Signed out') return;
    view.innerHTML = String(html`<div class="card empty"><h2>Something went wrong</h2><p>${err.message}</p><a href="#/">Back to overview</a></div>`);
  }
}

// ── Auth & boot ──────────────────────────────────────────────────
function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  $('#login input').focus();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = new FormData(e.target).get('password');
  try {
    await api('/api/auth/login', { method: 'POST', body: { password } });
    $('#login').hidden = true;
    $('#shell').hidden = false;
    e.target.reset();
    route();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} });
  showLogin();
});

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('dg-theme')); } catch {}
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('dg-theme', next); } catch {}
});

window.addEventListener('hashchange', route);
const me = await api('/api/auth/me');
if (me.signedIn) {
  $('#shell').hidden = false;
  route();
} else {
  showLogin();
}
