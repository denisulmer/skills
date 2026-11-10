#!/usr/bin/env node
// A first repository profile from what the repository's files show, with no questions asked, so the PR
// skills work in a repository nobody has set up. It only writes down what can be detected: the checks the
// build files name and the merge strategy the history shows. The danger map stays at the defaults. The
// profile is marked `calibrated: false`, and the skills say so until setup-repo has calibrated it.
//
//   node draft.mjs [--repo <path>] [--out <file>]     print the draft (or write it to <file>) and what it assumed
//   node draft.mjs [--repo <path>] --save             save it as your profile in <config>/pr-profiles/<name>.md
//
// Output: JSON with `name`, `file` (when written), `checks`, `merge`, `assumed` (what was detected and from
// where) and `improve` (what a person can do to make it better). --save refuses when a profile already applies.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_PROFILES, loadProfile, parseArgs, tryGit } from './profile.mjs';

const tryJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const tryText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

// The default branch as a ref this checkout has: origin's HEAD, else main or master, remote first.
export function defaultBranch(repo) {
  const head = tryGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim();
  if (head) return head;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) if (tryGit(repo, ['rev-parse', '--verify', '--quiet', ref])) return ref;
  return tryGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() || 'HEAD';
}

// Remote URLs without scheme, user name or .git: what a profile's `remotes` entries are matched against.
function remotesOf(repo) {
  return (tryGit(repo, ['config', '--get-regexp', '^remote\\..*\\.url$']) ?? '')
    .split('\n').filter(Boolean).map((line) => line.split(' ').slice(1).join(' '))
    .map((url) => url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/\.git$/, ''));
}

function nameOf(repo, remotes) {
  const parts = (remotes[0] ?? '').split(/[/:]/).filter((p) => p && p !== '_git' && p !== 'v3').map((p) => decodeURIComponent(p));
  const picked = parts.length >= 3 ? [parts[1], parts.at(-1)] : parts.slice(-2);
  const common = tryGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  const fallback = basename(common ? dirname(common) : repo);
  return (picked.length ? [...new Set(picked)].join('-') : fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repository';
}

// Checks the build files name. `fast` is what an agent runs for the files it touched; `full` is the suite.
export function detectChecks(repo) {
  const has = (file) => existsSync(join(repo, file));
  const checks = [];
  const assumed = [];
  const root = readdirSync(repo);

  if (has('package.json')) {
    const scripts = tryJson(join(repo, 'package.json'))?.scripts ?? {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const run = (script) => (pm === 'npm' ? `npm run ${script} --silent` : `${pm} run ${script}`);
    const match = ['**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}', '**/package.json'];
    for (const script of ['lint', 'typecheck', 'type-check', 'check-types']) if (scripts[script]) checks.push({ id: script, match, run: run(script), level: 'fast' });
    const unit = ['test:unit', 'test:fast', 'unit'].find((script) => scripts[script]);
    if (unit) checks.push({ id: 'unit-tests', match, run: run(unit), level: 'fast' });
    if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ id: 'tests', match, run: pm === 'npm' ? 'npm test --silent' : `${pm} test`, level: unit ? 'full' : 'fast' });
    assumed.push(`package.json scripts (${pm}): ${Object.keys(scripts).filter((s) => checks.some((c) => c.run.includes(s))).join(', ') || 'none usable as a check'}`);
  }
  const solution = root.find((f) => /\.slnx?$/.test(f));
  if (solution) {
    const match = ['**/*.{cs,csproj,props,targets,razor,cshtml}'];
    checks.push({ id: 'dotnet-build', match, run: `dotnet build "${solution}" --nologo -v q`, level: 'fast' });
    checks.push({ id: 'dotnet-test', match, run: `dotnet test "${solution}" --nologo`, level: 'full' });
    assumed.push(`${solution}: build as the fast check, the whole test run as the full one`);
  }
  if (has('go.mod')) {
    checks.push({ id: 'go-vet', match: ['**/*.go', 'go.mod'], run: 'go vet ./...', level: 'fast' });
    checks.push({ id: 'go-test', match: ['**/*.go', 'go.mod'], run: 'go test ./...', level: 'full' });
    assumed.push('go.mod: go vet as the fast check, go test as the full one');
  }
  if (has('Cargo.toml')) {
    checks.push({ id: 'cargo-check', match: ['**/*.rs', '**/Cargo.toml'], run: 'cargo check --quiet', level: 'fast' });
    checks.push({ id: 'cargo-test', match: ['**/*.rs', '**/Cargo.toml'], run: 'cargo test --quiet', level: 'full' });
    assumed.push('Cargo.toml: cargo check as the fast check, cargo test as the full one');
  }
  const pyproject = tryText(join(repo, 'pyproject.toml'));
  if (pyproject || has('requirements.txt') || has('setup.py')) {
    if (/\[tool\.ruff/.test(pyproject) || has('ruff.toml')) checks.push({ id: 'ruff', match: ['**/*.py'], run: 'ruff check {files}', level: 'fast' });
    if (/pytest/.test(pyproject) || has('pytest.ini') || has('tests')) checks.push({ id: 'pytest', match: ['**/*.py'], run: 'pytest -q', level: 'full' });
    assumed.push(`Python project: ${checks.filter((c) => ['ruff', 'pytest'].includes(c.id)).map((c) => c.id).join(', ') || 'no linter or test runner configured'}`);
  }
  return { checks, assumed };
}

// The strategy the default branch's history shows: merge commits, one commit per PR, or a linear history.
export function detectMerge(repo, branch) {
  const entries = (tryGit(repo, ['log', '--first-parent', '-60', '--format=%P%x1f%s', branch]) ?? '').split('\n').filter(Boolean).map((line) => line.split('\x1f'));
  if (entries.length < 5) return { strategy: 'merge', why: `too little history on ${branch} to tell; merge commits assumed` };
  const merges = entries.filter(([parents]) => parents.trim().split(/\s+/).length > 1).length;
  const perPr = entries.filter(([parents, subject]) => parents.trim().split(/\s+/).length === 1 && /\(#\d+\)\s*$|^Merged PR \d+|\(!\d+\)\s*$/.test(subject)).length;
  if (merges / entries.length >= 0.3) return { strategy: 'merge', why: `${merges} of the last ${entries.length} commits on ${branch} are merge commits` };
  if (perPr / entries.length >= 0.3) return { strategy: 'squash', why: `${perPr} of the last ${entries.length} commits on ${branch} are one commit per PR` };
  return { strategy: 'rebase', why: `the last ${entries.length} commits on ${branch} are a linear history without PR subjects` };
}

export function draft(repo, today = new Date().toISOString().slice(0, 10)) {
  const remotes = remotesOf(repo);
  const name = nameOf(repo, remotes);
  const branch = defaultBranch(repo);
  const { checks, assumed } = detectChecks(repo);
  const merge = detectMerge(repo, branch);
  const common = tryGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  const where = remotes.length
    ? ['remotes:', ...remotes.map((r) => `  - ${r}`)]
    : ['paths:', `  - ${(common ? dirname(common) : repo).replace(/\\/g, '/')}`];
  const text = [
    '---',
    `name: ${name}`,
    `calibrated: false        # drafted automatically on ${today}; the setup-repo skill calibrates and completes it`,
    ...where,
    '---',
    '',
    `# ${name}`,
    '',
    `Drafted automatically on ${today} from the repository's files, with no questions asked. It holds only what`,
    'could be detected. Run the setup-repo skill to add what is dangerous here and to calibrate it against',
    'recent merges.',
    '',
    '## Danger map',
    '',
    'Nothing beyond the defaults yet (documentation, tests, dependencies, CI, infrastructure, migrations,',
    'authentication).',
    '',
    '```json rules',
    '[]',
    '```',
    '',
    '## Judgment notes',
    '',
    "None yet: this repository's one-way doors and costly two-way doors belong here.",
    '',
    '## Checks',
    '',
    ...(checks.length
      ? ['Detected from the build files; a fast check that failed on a clean branch was dropped.', '', '```json checks', JSON.stringify(checks, null, 2), '```']
      : ['None detected: no build file names a command. Agents use the repository\'s own guides.']),
    '',
    '## Conventions a fix must keep',
    '',
    'None recorded.',
    '',
    '## Merge',
    '',
    `Strategy: \`${merge.strategy}\` (${merge.why}). Delete the source branch after the merge.`,
    '',
  ].join('\n');
  const improve = [
    'Run the setup-repo skill: it adds what is dangerous in this repository and calibrates the profile against your last 20 merges.',
    ...(checks.length ? [] : ['Add a ```json checks block with the commands a fix must pass.']),
  ];
  return { name, text, checks: checks.map((c) => `${c.id} (${c.level})`), merge, assumed: [...assumed, `merge: ${merge.strategy}, ${merge.why}`, 'danger map: the defaults only'], improve };
}

// Run as a command, also through a junction or symlink (personal skills): compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const opts = parseArgs(process.argv.slice(2));
  const repo = typeof opts.repo === 'string' ? opts.repo : '.';
  try {
    if (!tryGit(repo, ['rev-parse', '--git-dir'])) throw new Error(`${repo} is not a git repository`);
    const { text, ...result } = draft(repo);
    let file = typeof opts.out === 'string' ? opts.out : null;
    if (opts.save) {
      const existing = loadProfile(repo, defaultBranch(repo));
      if (existing) throw new Error(`a profile already applies (${existing.name}, ${existing.file}); edit it or run the setup-repo skill`);
      mkdirSync(USER_PROFILES, { recursive: true });
      file = join(USER_PROFILES, `${result.name}.md`);
    }
    if (file) writeFileSync(file, text);
    console.log(JSON.stringify({ ...result, file, ...(file ? {} : { text }) }, null, 2));
  } catch (error) {
    console.error(`draft: ${error.message}`);
    process.exit(1);
  }
}
