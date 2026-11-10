// A throwaway plain-git repository with pr-host's `local` reviews, and the skills' scripts run against it.
// Nothing leaves the temp directory: the metrics ledger and user profiles go to <work>/cfg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = {
  babysit: join(ROOT, 'skills/babysit-pr/scripts/babysit.mjs'),
  prHost: join(ROOT, 'skills/pr-host/scripts/pr-host.mjs'),
  measure: join(ROOT, 'skills/measure-prs/scripts/measure.mjs'),
  signals: join(ROOT, 'skills/score-pr/scripts/signals.mjs'),
  checks: join(ROOT, 'skills/setup-repo/scripts/checks.mjs'),
  draft: join(ROOT, 'skills/setup-repo/scripts/draft.mjs'),
};

export function sandbox(t) {
  const work = mkdtempSync(join(tmpdir(), 'skills-test-'));
  t?.after(() => rmSync(work, { recursive: true, force: true }));
  const repo = join(work, 'repo');
  const scratch = join(work, 'scratch');
  mkdirSync(repo);
  mkdirSync(scratch);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(work, 'cfg'), GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  for (const name of ['PR_HOST_PLATFORM', 'PR_HOST_DRY_RUN', 'ADO_PR_DRY_RUN']) delete env[name];
  const sh = (cmd, args, cwd = repo) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...args) => sh('git', args);
  // A script's JSON output; a failure throws with the script's own message.
  const node = (script, ...args) => {
    let out;
    try { out = sh(process.execPath, [script, ...args]); } catch (error) { throw Object.assign(new Error(`${args.join(' ')}\n${error.stderr || error.message}`), { stdout: error.stdout }); }
    try { return JSON.parse(out); } catch { return out; }
  };
  const write = (name, data) => { const file = join(scratch, name); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); return file; };
  const commit = (file, text, message) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text); git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  // The repository's own identity, so nothing depends on the machine's git configuration.
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  commit('a.txt', 'one\n', 'init');
  return { work, repo, scratch, env, sh, git, node, write, commit };
}
