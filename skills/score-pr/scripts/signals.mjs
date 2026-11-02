#!/usr/bin/env node
// Mechanical risk signals for a change: what it touches, how big it is, and which score floors,
// caps and adjustments the matched rules impose. The judgment (door, blast radius) stays with the
// model; this script only reports facts that can be counted.
//
//   node signals.mjs --base <ref> --head <ref> [--repo <path>] [--profile <file>|none]
//   node signals.mjs --which-profile --base <ref> [--repo <path>]   the profile that applies, with its text
//
// Profiles, first match wins: --profile <file>; ~/.claude/pr-profiles/*.md whose `remotes` matches a remote
// URL or whose `paths` names the main checkout (so every worktree of a repo finds the same one); the
// repository's own .claude/pr-profile.md as committed on --base, never the head, so a change cannot
// loosen the rules it is scored by.
//
// Rule semantics: a floor applies when ANY non-test file matches (one risky file is enough);
// a cap or an adjustment applies only when EVERY changed file matches (a discount must not
// cover a change that also reaches somewhere else).

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const USER_PROFILES = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'pr-profiles');
const REPO_PROFILE = '.claude/pr-profile.md';

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|[^/]*Tests?\/|Tests?\.cs$/i;

// Defaults that hold in most repositories. A profile adds rules, and replaces a default by reusing its id.
const DEFAULT_RULES = [
  { id: 'docs-only', match: ['**/*.md', 'docs/**', '**/*.txt', '**/*.adoc'], cap: 10, reason: 'documentation only' },
  { id: 'tests-only', test: true, cap: 20, reason: 'tests only' },
  { id: 'dependencies', match: ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.csproj', '**/Directory.Packages.props', '**/Directory.Build.props', '**/global.json', '**/requirements*.txt', '**/pyproject.toml', '**/go.mod', '**/Cargo.toml'], floor: 25, reason: 'dependency or build manifest' },
  { id: 'ci', match: ['.github/**', 'ci/**', '.azure-pipelines/**', '**/azure-pipelines*.yml', '**/Dockerfile*', '**/*.dockerfile'], floor: 30, reason: 'CI or container build' },
  { id: 'infra', match: ['infra/**', '**/*.tf', '**/k8s/**', '**/helm/**', '**/kubernetes*.y*ml', '**/*.bicep'], floor: 45, reason: 'deployment or infrastructure definition' },
  { id: 'migration', match: ['**/Migrations/*.cs', '**/migrations/**', '**/*.sql'], exclude: ['**/*.Designer.cs', '**/*ModelSnapshot.cs'], floor: 45, reason: 'database schema or data migration' },
  // Matches the word at a path or camel-case boundary, so "AuthOptions.cs" and "auth/" hit but "tokens.css" and "author.ts" do not.
  { id: 'auth', regex: '(^|[/._-])([Aa]uth(entication|orization|orize)?|[Ss]ecurity|[Aa]pi-?[Kk]eys?|[Ss]essions?|[Ll]ogin|[Pp]asswords?|[Cc]redentials?|[Ss]ecrets?)(?=[/._A-Z-]|$)|[a-z](Auth(entication|orization|orize)?|Security|ApiKeys?|Sessions?|Login|Passwords?|Credentials?|Secrets?)(?=[/._A-Z-]|$)', regexFlags: '', exclude: ['**/*.md'], floor: 50, reason: 'authentication, authorization or secrets' },
];

// Added lines that make a migration destructive: data or structure that a rollback cannot bring back.
const DESTRUCTIVE = [
  /migrationBuilder\.(DropTable|DropColumn|DropIndex|DropForeignKey|DropPrimaryKey|DropSchema|DropSequence|RenameColumn|RenameTable)\b/,
  /migrationBuilder\.AlterColumn\b/,
  /\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|VIEW|PROCEDURE)|TRUNCATE\s+TABLE|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DROP)\b/i,
  /\bUPDATE\s+\S+\s+SET\b/i,
];
const DESTRUCTIVE_FLOOR = 75;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    opts[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return opts;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Minimal glob: ** spans directories, * and ? stay inside one segment, {a,b} alternates.
function globToRegExp(glob) {
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

function compileRule(rule, source) {
  const include = (rule.match ?? []).map(globToRegExp);
  const exclude = (rule.exclude ?? []).map(globToRegExp);
  const regex = rule.regex ? new RegExp(rule.regex, rule.regexFlags ?? 'i') : null;
  const matches = (file) => {
    if (exclude.some((re) => re.test(file))) return false;
    if (rule.test) return TEST_FILE.test(file);
    return include.some((re) => re.test(file)) || (regex ? regex.test(file) : false);
  };
  return { ...rule, source, matches };
}

const listField = (text, field) =>
  [...(text.match(new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, 'm'))?.[1] ?? '').matchAll(/-\s+(.+)/g)].map((m) => m[1].trim());

const samePath = (a, b) => {
  const norm = (p) => resolve(p.replace(/^~(?=$|[/\\])/, homedir())).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

function parseProfile(text, source, file) {
  const json = text.match(/```json rules\s*\n([\s\S]*?)```/)?.[1];
  if (!json) throw new Error(`${file} has no \`\`\`json rules block`);
  return { name: text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? file, source, file, text, rules: JSON.parse(json) };
}

function loadProfile(repo, base, profileOpt) {
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = typeof opts.repo === 'string' ? opts.repo : '.';
  if (opts['which-profile']) {
    const profile = loadProfile(repo, typeof opts.base === 'string' ? opts.base : null, opts.profile);
    console.log(JSON.stringify(profile ? { name: profile.name, source: profile.source, file: profile.file, text: profile.text } : null, null, 2));
    return;
  }
  if (typeof opts.base !== 'string' || typeof opts.head !== 'string') {
    console.error('usage: node signals.mjs --base <ref> --head <ref> [--repo <path>] [--profile <file>|none]\n       node signals.mjs --which-profile --base <ref> [--repo <path>]');
    process.exit(2);
  }
  const mergeBase = git(repo, ['merge-base', opts.base, opts.head]).trim();
  const range = [mergeBase, opts.head];

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
  const changed = [...files.values()];
  if (changed.length === 0) {
    console.log(JSON.stringify({ base: opts.base, head: opts.head, mergeBase, empty: true }, null, 2));
    return;
  }

  const profile = loadProfile(repo, opts.base, opts.profile);
  // A profile rule with the same id as a default replaces that default.
  const profileRules = profile?.rules ?? [];
  const rules = [
    ...DEFAULT_RULES.filter((r) => !profileRules.some((p) => p.id === r.id)).map((r) => compileRule(r, 'default')),
    ...profileRules.map((r) => compileRule(r, profile.name)),
  ];

  const hits = [];
  for (const rule of rules) {
    const matched = changed.filter((f) => rule.matches(f.path));
    if (matched.length === 0) continue;
    const nonTest = matched.filter((f) => rule.test || rule.includeTests || !TEST_FILE.test(f.path));
    const all = matched.length === changed.length;
    const applies = [];
    if (rule.floor !== undefined && nonTest.length > 0) applies.push('floor');
    if (rule.cap !== undefined && all) applies.push('cap');
    if (rule.adjust !== undefined && all) applies.push('adjust');
    hits.push({
      id: rule.id,
      source: rule.source,
      reason: rule.reason,
      floor: rule.floor ?? null,
      cap: rule.cap ?? null,
      adjust: rule.adjust ?? null,
      applies,
      matchedFiles: matched.length,
      examples: matched.slice(0, 8).map((f) => f.path),
    });
  }

  // Destructive statements in added lines of migration-like files.
  const migrationRule = rules.find((r) => r.id === 'migration');
  const destructive = [];
  for (const file of changed.filter((f) => migrationRule.matches(f.path) && f.status !== 'D')) {
    const diff = git(repo, ['diff', '-U0', ...range, '--', file.path]);
    let lineNo = 0;
    for (const line of diff.split('\n')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) {
        lineNo = Number(hunk[1]);
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        if (DESTRUCTIVE.some((re) => re.test(line))) destructive.push({ file: file.path, line: lineNo, text: line.slice(1).trim().slice(0, 160) });
        lineNo++;
      }
    }
  }
  if (destructive.length > 0) {
    hits.push({ id: 'destructive-migration', source: 'default', reason: 'migration drops, renames, alters or rewrites existing data', floor: DESTRUCTIVE_FLOOR, cap: null, adjust: null, applies: ['floor'], matchedFiles: new Set(destructive.map((d) => d.file)).size, examples: destructive.slice(0, 8).map((d) => `${d.file}:${d.line}  ${d.text}`) });
  }

  const floors = hits.filter((h) => h.applies.includes('floor'));
  const caps = hits.filter((h) => h.applies.includes('cap'));
  const adjusts = hits.filter((h) => h.applies.includes('adjust'));
  const floor = floors.reduce((max, h) => Math.max(max, h.floor), 0);
  const cap = caps.reduce((min, h) => Math.min(min, h.cap), 100);
  const topDirs = new Map();
  for (const f of changed) {
    const dir = f.path.split('/').slice(0, 3).join('/');
    topDirs.set(dir, (topDirs.get(dir) ?? 0) + 1);
  }

  console.log(JSON.stringify({
    base: opts.base,
    head: opts.head,
    mergeBase,
    profile: profile ? { name: profile.name, source: profile.source, file: profile.file } : null,
    totals: {
      files: changed.length,
      added: changed.reduce((n, f) => n + f.added, 0),
      deleted: changed.reduce((n, f) => n + f.deleted, 0),
      binaryFiles: changed.filter((f) => f.binary).length,
      newFiles: changed.filter((f) => f.status === 'A').length,
      deletedFiles: changed.filter((f) => f.status === 'D').length,
      renamedFiles: changed.filter((f) => f.status === 'R').length,
      testFiles: changed.filter((f) => TEST_FILE.test(f.path)).length,
    },
    areas: [...topDirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([dir, count]) => ({ dir, files: count })),
    hits,
    destructive,
    bounds: {
      floor,
      floorReasons: floors.filter((h) => h.floor === floor).map((h) => h.reason),
      cap,
      capReasons: caps.filter((h) => h.cap === cap).map((h) => h.reason),
      adjust: adjusts.reduce((sum, h) => sum + h.adjust, 0),
      adjustReasons: adjusts.map((h) => `${h.adjust > 0 ? '+' : ''}${h.adjust} ${h.reason}`),
    },
  }, null, 2));
}

main();
