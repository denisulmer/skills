#!/usr/bin/env node
// Score bounds a draft profile gives the last N changes merged into a branch, so a person can see whether
// its rules are right before anyone relies on them. Runs pr-risk's signals.mjs once per change.
//
//   node calibrate.mjs --profile <draft.md> [--repo <path>] [--branch origin/main] [--count 20] [--json]
//
// A merge commit on the first-parent history counts as one change (its first parent to its second);
// any other first-parent commit (squash or rebase merges) counts as itself.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNALS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pr-risk', 'scripts', 'signals.mjs');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    opts[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return opts;
}

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts.profile !== 'string') {
    console.error('usage: node calibrate.mjs --profile <draft.md> [--repo <path>] [--branch origin/main] [--count 20] [--json]');
    process.exit(2);
  }
  const repo = typeof opts.repo === 'string' ? opts.repo : '.';
  const branch = typeof opts.branch === 'string' ? opts.branch : 'HEAD';
  const count = Number(opts.count ?? 20);

  const rows = [];
  for (const line of git(repo, ['log', '--first-parent', `-${count}`, '--format=%H %P%x09%s', branch]).split('\n').filter(Boolean)) {
    const [shas, subject] = line.split('\t');
    const [sha, parent, second] = shas.split(' ');
    if (!parent) continue;
    const [base, head] = second ? [parent, second] : [parent, sha];
    const signals = JSON.parse(execFileSync(process.execPath, [SIGNALS, '--base', base, '--head', head, '--repo', repo, '--profile', opts.profile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    if (signals.empty) continue;
    const applied = (kind) => signals.hits.filter((h) => h.applies.includes(kind)).map((h) => h.id);
    rows.push({
      sha: sha.slice(0, 8),
      subject: subject.slice(0, 70),
      files: signals.totals.files,
      lines: signals.totals.added + signals.totals.deleted,
      floor: signals.bounds?.floor ?? 0,
      cap: signals.bounds?.cap ?? 100,
      adjust: signals.bounds?.adjust ?? 0,
      floorRules: applied('floor'),
      capRules: applied('cap'),
      adjustRules: applied('adjust'),
      areas: signals.areas.slice(0, 3).map((a) => a.dir),
    });
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log('| Change | Files | Lines | Floor | Cap | Adjust | Rules | Areas |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const rules = [...r.floorRules.map((id) => `≥${id}`), ...r.capRules.map((id) => `≤${id}`), ...r.adjustRules.map((id) => `±${id}`)].join(', ') || '-';
    console.log(`| \`${r.sha}\` ${r.subject.replace(/\|/g, '/')} | ${r.files} | ${r.lines} | ${r.floor} | ${r.cap} | ${r.adjust} | ${rules} | ${r.areas.join(', ')} |`);
  }
}

main();
