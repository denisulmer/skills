#!/usr/bin/env node
// The checks a change has to pass, picked from the profile's ```json checks block by the files it touches,
// and run one after another with their exit codes and output tails as JSON. Agents run `fast` checks only;
// `full` is the CI suite (run locally only where there is no CI), `smoke` a live check for critical changes.
//
//   node checks.mjs list --base <ref> [--head HEAD] [--repo <path>] [--level fast] [--all] [--target <ref>] [--profile <file>]
//   node checks.mjs run  --base <ref> [--head HEAD] [--repo <path>] [--level fast] [--all] [--target <ref>] [--profile <file>]
//                        [--only <id,id>] [--logs <dir>] [--tail <lines>]
//
// --base: the change is merge-base(base, head)..head (the PR's target for the whole PR, an earlier head for
// only what changed since). --target: the ref the repository profile is read from (default --base).
// --all: every check of the level, whatever the change touches (to try a new profile).
// Exit code: 0 passed or nothing to run, 1 a check failed, 2 usage, 3 the profile has no checks block
// (fall back to its Checks section).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles, fileMatcher, loadProfile, parseArgs, tryGit } from './profile.mjs';

const LEVELS = ['fast', 'full', 'smoke'];
const DEFAULT_TIMEOUT_MINUTES = { fast: 20, full: 90, smoke: 30 };

// Git for Windows' bash, not the WSL launcher that `bash` can resolve to on Windows; null when missing.
function gitBash() {
  const execPath = tryGit('.', ['--exec-path'])?.trim();
  if (!execPath) return null;
  for (const up of [['..', '..', '..'], ['..', '..']]) {
    const bash = resolve(execPath, ...up, 'bin', 'bash.exe');
    if (existsSync(bash)) return bash;
  }
  return null;
}

// The shell a check runs in, and how its {files} are quoted there. Default: Git Bash on Windows (cmd.exe
// when there is none), /bin/sh elsewhere; `shell` asks for bash, sh, cmd or pwsh.
export function shellFor(check, platform = process.platform, findBash = gitBash) {
  const name = check.shell ?? 'default';
  if (name === 'cmd' || (platform === 'win32' && ['default', 'bash', 'sh'].includes(name) && !findBash())) return { shell: 'cmd.exe', kind: 'cmd' };
  if (name === 'pwsh') return { shell: 'pwsh', kind: 'pwsh' };
  if (platform === 'win32') return { shell: findBash(), kind: 'posix' };
  if (name === 'bash') return { shell: 'bash', kind: 'posix' };
  return { shell: '/bin/sh', kind: 'posix' };
}

// File names come from the change, which anyone pushing to the branch controls: quote them so the shell
// reads them as data. POSIX and PowerShell single quotes expand nothing; cmd has no safe quoting for
// % or ", so such a name is refused.
export function quote(file, kind) {
  if (kind === 'posix') return `'${file.replace(/'/g, `'\\''`)}'`;
  if (kind === 'pwsh') return `'${file.replace(/'/g, "''")}'`;
  if (/["%^&|<>]/.test(file)) throw new Error(`cannot pass ${JSON.stringify(file)} to cmd.exe safely; give the check a POSIX shell`);
  return `"${file}"`;
}

// Paths in {files} are relative to the directory the check runs in.
const relativeTo = (cwd, file) => (!cwd || cwd === '.' ? file : posix.relative(cwd.replace(/\\/g, '/').replace(/\/+$/, ''), file));

// --all runs every check of the level; each still gets only files its globs match: the changed ones, or
// when none changed, up to 20 tracked ones as a sample, so a trial run exercises {files}.
export function selectChecks(checks, files, { level = 'fast', all = false, tracked = [] } = {}) {
  const live = files.filter((f) => f.status !== 'D').map((f) => f.path);
  if (!all && files.length === 0) return [];
  return checks
    .filter((check) => (check.level ?? 'fast') === level)
    .map((check) => {
      const matches = fileMatcher(check, { emptyMatchesAll: true });
      let matched = live.filter(matches);
      if (all && matched.length === 0 && check.run.includes('{files}')) matched = tracked.filter(matches).slice(0, 20);
      return { check, matched };
    })
    .filter(({ check, matched }) => all || matched.length > 0 || !(check.match || check.regex || check.test));
}

function plan(opts) {
  if (typeof opts.base !== 'string') throw Object.assign(new Error('missing --base'), { usage: true });
  const level = typeof opts.level === 'string' ? opts.level : 'fast';
  if (!LEVELS.includes(level)) throw Object.assign(new Error(`--level must be one of ${LEVELS.join(', ')}`), { usage: true });
  const repo = typeof opts.repo === 'string' ? opts.repo : '.';
  const head = typeof opts.head === 'string' ? opts.head : 'HEAD';
  const target = typeof opts.target === 'string' ? opts.target : opts.base;
  const profile = loadProfile(repo, target, opts.profile);
  const base = { repo, base: opts.base, head, level, profile: profile ? { name: profile.name, source: profile.source } : null };
  if (!profile?.checks) return { ...base, status: 'none', reason: profile ? 'the profile has no ```json checks block' : 'no profile applies', selected: [] };
  const { files } = changedFiles(repo, opts.base, head);
  const tracked = opts.all ? (tryGit(repo, ['ls-files']) ?? '').split('\n').filter(Boolean) : [];
  let selected = selectChecks(profile.checks, files, { level, all: !!opts.all, tracked });
  if (typeof opts.only === 'string') {
    const only = new Set(opts.only.split(','));
    selected = selected.filter(({ check }) => only.has(check.id));
  }
  return { ...base, changedFiles: files.length, selected };
}

function list(opts) {
  const p = plan(opts);
  return { ...p, selected: p.selected.map(({ check, matched }) => ({ id: check.id, run: check.run, cwd: check.cwd ?? '.', matchedFiles: matched.length, examples: matched.slice(0, 5) })) };
}

function run(opts) {
  const p = plan(opts);
  if (p.status === 'none') return p;
  const tailLines = Number(opts.tail ?? 40);
  if (typeof opts.logs === 'string') mkdirSync(opts.logs, { recursive: true });
  const results = [];
  for (const { check, matched } of p.selected) {
    const { shell, kind } = shellFor(check);
    let command;
    try {
      command = check.run.replaceAll('{files}', matched.map((f) => quote(relativeTo(check.cwd, f), kind)).join(' '));
    } catch (error) {
      results.push({ id: check.id, command: check.run, cwd: check.cwd ?? '.', status: 'failed', exit: null, seconds: 0, tail: '', error: error.message });
      continue;
    }
    const cwd = resolve(p.repo, check.cwd ?? '.');
    const started = Date.now();
    const out = spawnSync(command, {
      cwd,
      shell,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: (check.timeout ?? DEFAULT_TIMEOUT_MINUTES[p.level]) * 60000,
      env: { ...process.env, CI: process.env.CI ?? '1' },
    });
    const output = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    if (typeof opts.logs === 'string') writeFileSync(join(opts.logs, `${check.id}.log`), `$ ${command}\n\n${output}`);
    const timedOut = out.error?.code === 'ETIMEDOUT' || out.signal === 'SIGTERM';
    results.push({
      id: check.id,
      command,
      cwd: check.cwd ?? '.',
      status: out.status === 0 ? 'passed' : timedOut ? 'timeout' : 'failed',
      exit: out.status,
      seconds: Math.round((Date.now() - started) / 1000),
      tail: output.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-tailLines).join('\n'),
      ...(out.error && !timedOut ? { error: out.error.message } : {}),
    });
  }
  const failed = results.filter((r) => r.status !== 'passed');
  return {
    ...p,
    headSha: tryGit(p.repo, ['rev-parse', p.head])?.trim() ?? null,
    status: results.length === 0 ? 'nothing-to-run' : failed.length ? 'failed' : 'passed',
    selected: undefined,
    results,
  };
}

const COMMANDS = { list, run };

// Run as a command, also through a junction or symlink (personal skills): compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (!COMMANDS[command]) {
    console.error('usage: checks.mjs list|run --base <ref> [--head HEAD] [--repo <path>] [--level fast|full|smoke] [--all] (see the header)');
    process.exit(2);
  }
  try {
    const out = COMMANDS[command](opts);
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.status === 'none' ? 3 : out.status === 'failed' ? 1 : 0);
  } catch (error) {
    console.error(`checks: ${error.message}`);
    process.exit(error.usage ? 2 : 1);
  }
}
