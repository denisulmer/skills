// A repository nobody set up: draft.mjs writes a profile from its files, the skills find it, and it is
// marked as not calibrated. And pr-host says what was wrong without burying it under its help.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTS, sandbox } from './helpers.mjs';

test('a repository without a profile gets a draft: detected checks, the merge strategy, marked uncalibrated', (t) => {
  const s = sandbox(t);
  s.commit('package.json', JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', build: 'x' } }), 'chore: package');
  assert.equal(s.node(SCRIPTS.signals, '--which-profile', '--base', 'main', '--repo', s.repo), null);

  const saved = s.node(SCRIPTS.draft, '--repo', s.repo, '--save');
  assert.deepEqual(saved.checks, ['lint (fast)', 'tests (fast)']);
  assert.equal(saved.merge.strategy, 'merge', 'too little history: merge commits assumed');
  assert.match(saved.assumed.join('\n'), /package\.json scripts \(npm\): lint, test/);
  assert.match(saved.improve[0], /setup-repo skill/);
  const text = readFileSync(saved.file, 'utf8');
  assert.match(text, /^calibrated: false/m);
  assert.match(text, /^paths:\n {2}- .+repo$/m, 'a repository without a remote is found by its path');

  const found = s.node(SCRIPTS.signals, '--which-profile', '--base', 'main', '--repo', s.repo);
  assert.deepEqual([found.name, found.source, found.calibrated], [saved.name, 'user', false]);
  // The detected fast checks run for a change that touches their files.
  s.git('checkout', '-q', '-b', 'change');
  s.commit('index.js', 'export default 1;\n', 'feat: code');
  const run = s.node(SCRIPTS.checks, 'run', '--base', 'main', '--repo', s.repo);
  assert.equal(run.status, 'passed');
  assert.deepEqual(run.results.map((r) => r.id), ['lint', 'tests']);
  // A second draft does not overwrite a profile that applies.
  assert.throws(() => s.node(SCRIPTS.draft, '--repo', s.repo, '--save'), /a profile already applies/);
});

test('a profile without the flag counts as calibrated', (t) => {
  const s = sandbox(t);
  s.commit('.claude/pr-profile.md', '---\nname: team\n---\n\n```json rules\n[]\n```\n', 'chore: profile');
  assert.equal(s.node(SCRIPTS.signals, '--which-profile', '--base', 'main', '--repo', s.repo).calibrated, true);
});

test('pr-host: a wrong call says what was wrong in its first line and does not print the whole help', (t) => {
  const s = sandbox(t);
  let message = '';
  try { execFileSync(process.execPath, [SCRIPTS.prHost, 'show', 'not-a-pr'], { cwd: s.repo, env: s.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { message = error.stderr; }
  assert.match(message, /^not a pull-request id or URL: not-a-pr\n\(run "pr-host help" for the commands\)\s*$/);
  assert.deepEqual(s.node(SCRIPTS.prHost, 'context').limits, { description: null }, 'context names the description limit before a body is written');
});
