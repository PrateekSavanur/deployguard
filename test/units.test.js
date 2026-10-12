import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommit } from '../src/services/summary.js';
import { githubRepo, normalizeStatus } from '../src/services/deployments.js';

test('classifyCommit handles conventional commits', () => {
  assert.deepEqual(classifyCommit('feat(api): add search'), { category: 'feat', scope: 'api', subject: 'add search' });
  assert.equal(classifyCommit('fix!: remove v1').category, 'breaking');
  assert.equal(classifyCommit('chore: deps\n\nBREAKING CHANGE: node 22').category, 'breaking');
  assert.equal(classifyCommit('Update README').category, 'other');
  assert.equal(classifyCommit('Merge pull request #1 from x').category, 'merge');
  assert.equal(classifyCommit('ci: cache npm').category, 'chore');
});

test('normalizeStatus maps CI vocabularies', () => {
  assert.equal(normalizeStatus('success'), 'succeeded');
  assert.equal(normalizeStatus('In Progress'), 'in_progress');
  assert.equal(normalizeStatus('failure'), 'failed');
  assert.equal(normalizeStatus('canceled'), 'cancelled');
  assert.equal(normalizeStatus(undefined), 'succeeded');
  assert.equal(normalizeStatus('banana'), null);
});

test('githubRepo parses URLs', () => {
  assert.equal(githubRepo('https://github.com/acme/web.git').web, 'https://github.com/acme/web');
  assert.equal(githubRepo('git@github.com:acme/web.git').repo, 'web');
  assert.equal(githubRepo('https://gitlab.com/acme/web'), null);
});
