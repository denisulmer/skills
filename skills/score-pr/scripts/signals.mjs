#!/usr/bin/env node
// Mechanical risk signals for a change: what it touches, how big it is, and which score floors,
// caps and adjustments the matched rules impose. The judgment (door, blast radius) stays with the
// model; this script only reports facts that can be counted.
//
//   node signals.mjs --base <ref> --head <ref> [--repo <path>] [--profile <file>|none]
//   node signals.mjs --which-profile --base <ref> [--repo <path>]   the profile that applies, with its text
//   node signals.mjs --planned <file> --base <ref> [--repo <path>]  a forecast for files a plan expects to
//                                                                   touch (one path per line, `+ ` new, `- ` deleted; no line counts,
//                                                                   no destructive-statement scan)
//
// Profiles, first match wins: --profile <file>; ~/.claude/pr-profiles/*.md whose `remotes` matches a remote
// URL or whose `paths` names the main checkout (so every worktree of a repo finds the same one); the
// repository's own .claude/pr-profile.md as committed on --base, never the head, so a change cannot
// loosen the rules it is scored by.
//
// Rule semantics: a floor applies when ANY non-test file matches (one risky file is enough);
// a cap or an adjustment applies only when EVERY changed file matches (a discount must not
// cover a change that also reaches somewhere else).

import { readFileSync } from 'node:fs';
import { changedFiles, fileMatcher, git, loadProfile, parseArgs, TEST_FILE } from '../../setup-repo/scripts/profile.mjs';

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

function compileRule(rule, source) {
  return { ...rule, source, matches: fileMatcher(rule) };
}

// A plan has no diff yet: one path per line, `+ ` before a new file and `- ` before one to delete (else
// modified), with no line counts. Windows separators and a leading ./ are normalized, so rules match.
function readPlanned(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const status = line.startsWith('+ ') ? 'A' : line.startsWith('- ') ? 'D' : 'M';
    const path = (status === 'M' ? line : line.slice(2)).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    return { path, added: 0, deleted: 0, binary: false, status };
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = typeof opts.repo === 'string' ? opts.repo : '.';
  if (opts['which-profile']) {
    const profile = loadProfile(repo, typeof opts.base === 'string' ? opts.base : null, opts.profile);
    console.log(JSON.stringify(profile ? { name: profile.name, source: profile.source, file: profile.file, calibrated: profile.calibrated, text: profile.text } : null, null, 2));
    return;
  }
  const planned = typeof opts.planned === 'string';
  if (typeof opts.base !== 'string' || (typeof opts.head !== 'string' && !planned)) {
    console.error('usage: node signals.mjs --base <ref> --head <ref> [--repo <path>] [--profile <file>|none]\n       node signals.mjs --planned <file> --base <ref> [--repo <path>]\n       node signals.mjs --which-profile --base <ref> [--repo <path>]');
    process.exit(2);
  }
  const { mergeBase, range, files } = planned
    ? { mergeBase: null, range: null, files: readPlanned(opts.planned) }
    : changedFiles(repo, opts.base, opts.head);
  const changed = files;
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
  for (const file of planned ? [] : changed.filter((f) => migrationRule.matches(f.path) && f.status !== 'D')) {
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
    head: planned ? null : opts.head,
    ...(planned ? { planned: true } : {}),
    mergeBase,
    profile: profile ? { name: profile.name, source: profile.source, file: profile.file, calibrated: profile.calibrated } : null,
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
