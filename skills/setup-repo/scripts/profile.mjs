// Repository profiles, shared by score-pr's signals.mjs, checks.mjs and babysit-pr's babysit.mjs: where the
// profile comes from, how its blocks parse, and which files a change touches. The format is described in
// ../references/profile-format.md.
//
// Profiles, first match wins: an explicit file; ~/.claude/pr-profiles/*.md whose `remotes` matches a remote
// URL or whose `paths` names the main checkout (so every worktree of a repo finds the same one); the
// repository's own .claude/pr-profile.md as committed on the base ref, never the head, so a change cannot
// loosen the rules it is scored or checked by.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const USER_PROFILES = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'pr-profiles');
export const REPO_PROFILE = '.claude/pr-profile.md';

export const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|[^/]*Tests?\/|Tests?\.cs$/i;

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    opts[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return opts;
}

export function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function tryGit(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Minimal glob: ** spans directories, * and ? stay inside one segment, {a,b} alternates.
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      out += `(?:${glob.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// A file matcher from match / exclude globs, a regex, or `test: true` (test files only). An entry with
// neither match nor regex nor test matches nothing, or every file with emptyMatchesAll (checks).
export function fileMatcher(entry, { emptyMatchesAll = false } = {}) {
  const include = (entry.match ?? []).map(globToRegExp);
  const exclude = (entry.exclude ?? []).map(globToRegExp);
  const regex = entry.regex ? new RegExp(entry.regex, entry.regexFlags ?? 'i') : null;
  const everything = emptyMatchesAll && !include.length && !regex && !entry.test;
  return (file) => {
    if (exclude.some((re) => re.test(file))) return false;
    if (entry.test) return TEST_FILE.test(file);
    return everything || include.some((re) => re.test(file)) || (regex ? regex.test(file) : false);
  };
}

const listField = (text, field) =>
  [...(text.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, 'm'))?.[1] ?? '').matchAll(/-\s+(.+)/g)].map((m) => m[1].trim());

const samePath = (a, b) => {
  const norm = (p) => resolve(p.replace(/^~(?=$|[/\\])/, homedir())).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

// A fenced ```json <name> block, or null when the profile has none.
export function jsonBlock(text, name, file) {
  const json = text.replace(/\r\n/g, '\n').match(new RegExp('```json ' + name + '\\s*\\n([\\s\\S]*?)```'))?.[1];
  if (json === undefined) return null;
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${file}: the \`\`\`json ${name} block is not valid JSON (${error.message})`);
  }
}

// The text of one `## <heading>` section, without the heading, or '' when it is missing.
export function section(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\b`, 'i').test(line));
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

export function parseProfile(text, source, file) {
  const rules = jsonBlock(text, 'rules', file);
  if (!rules) throw new Error(`${file} has no \`\`\`json rules block`);
  return { name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? file, source, file, text, rules, checks: jsonBlock(text, 'checks', file) };
}

export function loadProfile(repo, base, profileOpt) {
  if (profileOpt === 'none') return null;
  if (typeof profileOpt === 'string') return parseProfile(readFileSync(profileOpt, 'utf8'), 'explicit', profileOpt);

  // Every remote's URL without user names, and the main checkout (the parent of the shared git directory,
  // the same from every worktree).
  const remotes = (tryGit(repo, ['config', '--get-regexp', '^remote\\..*\\.url$']) ?? '')
    .split('\n').filter(Boolean).map((line) => line.split(' ').slice(1).join(' ').replace(/\/\/[^@/]+@/, '//'));
  const commonDir = tryGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim();
  const mainCheckout = commonDir ? dirname(commonDir) : null;

  let files = [];
  try {
    files = readdirSync(USER_PROFILES).filter((f) => f.endsWith('.md')).map((f) => join(USER_PROFILES, f));
  } catch {
    // No user profiles.
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const byRemote = listField(text, 'remotes').some((r) => remotes.some((url) => url.includes(r)));
    const byPath = mainCheckout && listField(text, 'paths').some((p) => samePath(p, mainCheckout));
    if (byRemote || byPath) return parseProfile(text, 'user', file);
  }

  const committed = base ? tryGit(repo, ['show', `${base}:${REPO_PROFILE}`]) : null;
  return committed === null ? null : parseProfile(committed, 'repo', `${base}:${REPO_PROFILE}`);
}

// Files a change touches between the merge base of base and head, and head: path (renames keep the new
// path), added and deleted lines, binary, and git's status letter.
export function changedFiles(repo, base, head) {
  const mergeBase = git(repo, ['merge-base', base, head]).trim();
  const range = [mergeBase, head];
  const files = new Map();
  for (const line of git(repo, ['diff', '--numstat', '-M', ...range]).split('\n').filter(Boolean)) {
    const [added, deleted, ...pathParts] = line.split('\t');
    // Renames print as "dir/{old => new}/file" or "old => new"; keep the new path.
    const path = pathParts.at(-1).replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
    files.set(path, { path, added: added === '-' ? 0 : Number(added), deleted: deleted === '-' ? 0 : Number(deleted), binary: added === '-', status: 'M' });
  }
  for (const line of git(repo, ['diff', '--name-status', '-M', ...range]).split('\n').filter(Boolean)) {
    const [status, ...paths] = line.split('\t');
    const entry = files.get(paths.at(-1));
    if (entry) entry.status = status[0];
  }
  return { mergeBase, range, files: [...files.values()] };
}
