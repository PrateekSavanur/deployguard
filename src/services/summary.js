// Release summaries: groups commits by Conventional Commit type and renders Markdown
// suitable for pasting into Slack, a changelog or a client update.

const CATEGORIES = [
  { key: 'breaking', title: 'Breaking changes', emoji: '💥' },
  { key: 'feat', title: 'Features', emoji: '✨' },
  { key: 'fix', title: 'Bug fixes', emoji: '🐛' },
  { key: 'perf', title: 'Performance', emoji: '⚡' },
  { key: 'security', title: 'Security', emoji: '🔒' },
  { key: 'refactor', title: 'Refactoring', emoji: '♻️' },
  { key: 'docs', title: 'Documentation', emoji: '📝' },
  { key: 'chore', title: 'Maintenance', emoji: '🔧' },
  { key: 'other', title: 'Other changes', emoji: '•' },
];

const TYPE_MAP = {
  feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix', perf: 'perf',
  security: 'security', sec: 'security', refactor: 'refactor', docs: 'docs', doc: 'docs',
  chore: 'chore', build: 'chore', ci: 'chore', test: 'chore', tests: 'chore', style: 'chore', deps: 'chore',
};

export function classifyCommit(message) {
  const [subject, ...rest] = String(message).split('\n');
  const body = rest.join('\n');
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (m) {
    const type = TYPE_MAP[m[1].toLowerCase()] || 'other';
    const breaking = Boolean(m[3]) || /BREAKING[ -]CHANGE/.test(body);
    return { category: breaking ? 'breaking' : type, scope: m[2] || null, subject: m[4] };
  }
  if (/^merge (pull request|branch)/i.test(subject)) return { category: 'merge', scope: null, subject };
  if (/^revert/i.test(subject)) return { category: 'fix', scope: null, subject };
  return { category: /BREAKING[ -]CHANGE/.test(body) ? 'breaking' : 'other', scope: null, subject };
}

function duration(start, end) {
  if (!start || !end) return null;
  const s = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function buildSummary(deployment, commits, previous) {
  const groups = Object.fromEntries(CATEGORIES.map((c) => [c.key, []]));
  const contributors = new Set();
  let merges = 0;
  for (const c of commits) {
    const info = classifyCommit(c.message);
    if (c.author) contributors.add(c.author);
    if (info.category === 'merge') {
      merges++;
      continue;
    }
    groups[info.category].push({ ...info, sha: c.sha, author: c.author, url: c.url });
  }

  const label = deployment.version || deployment.commit_sha?.slice(0, 7) || `#${deployment.id}`;
  const prevLabel = previous ? previous.version || previous.commit_sha?.slice(0, 7) : null;
  const statusWord = {
    succeeded: deployment.verification === 'unhealthy' ? 'deployed but failed health verification' : 'deployed',
    failed: 'failed to deploy',
    rolled_back: 'was rolled back',
    cancelled: 'was cancelled',
    in_progress: 'is deploying',
    queued: 'is queued',
  }[deployment.status];

  const lines = [];
  lines.push(`## ${deployment.project_name} ${label} → ${deployment.environment}`);
  lines.push('');
  const facts = [`**${label}** ${statusWord}`];
  if (deployment.is_rollback) facts.push('(rollback)');
  if (prevLabel) facts.push(`— previous: ${prevLabel}`);
  lines.push(facts.join(' '));
  const meta = [];
  if (deployment.deployer) meta.push(`Deployed by ${deployment.deployer}`);
  const d = duration(deployment.started_at, deployment.finished_at);
  if (d) meta.push(`took ${d}`);
  if (deployment.branch) meta.push(`from \`${deployment.branch}\``);
  if (meta.length) lines.push(meta.join(', '));
  lines.push('');

  const changeCount = commits.length - merges;
  if (!commits.length) {
    lines.push(previous ? '_No commit details were reported for this release._' : '_First tracked deployment to this environment._');
  } else {
    lines.push(`${changeCount} change${changeCount === 1 ? '' : 's'} from ${contributors.size} contributor${contributors.size === 1 ? '' : 's'}.`);
    for (const cat of CATEGORIES) {
      const items = groups[cat.key];
      if (!items.length) continue;
      lines.push('');
      lines.push(`### ${cat.emoji} ${cat.title}`);
      for (const it of items) {
        const scope = it.scope ? `**${it.scope}:** ` : '';
        const sha = it.url ? `[${it.sha.slice(0, 7)}](${it.url})` : it.sha.slice(0, 7);
        lines.push(`- ${scope}${it.subject} (${sha}${it.author ? `, ${it.author}` : ''})`);
      }
    }
  }
  if (deployment.compare_url) {
    lines.push('');
    lines.push(`[Full diff](${deployment.compare_url})`);
  }

  return {
    headline: `${label} ${statusWord}`,
    changeCount,
    contributors: [...contributors],
    groups: CATEGORIES.filter((c) => groups[c.key].length).map((c) => ({ ...c, items: groups[c.key] })),
    breaking: groups.breaking.length > 0,
    markdown: lines.join('\n'),
  };
}
