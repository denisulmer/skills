// Defects that escaped review: later fix, hotfix and revert commits on the default branch whose changed lines
// were written by a PR babysit-pr reviewed. Blame proposes; a person confirms. A line that traces back to a
// PR does not prove the review missed something (the fix may change behaviour on purpose), so every
// candidate goes to the user before it counts.
//
// A reviewed PR's commits: its merge commit and, for a merge commit with two parents, every commit it brought
// in; for a squash merge, the one commit; for a rebase or fast-forward merge of n commits (`commits` on the
// PR record), the n first-parent commits ending at it. The merge commit comes from the PR record
// (`mergeCommit`, written by merge-pr) or, for older records, from the target's history by the hosts' merge
// subjects ("Merged PR 123", "Merge pull request #123", "(#123)", "!123").
//
// A fix: a commit whose subject, after a host's merge prefix ("Merged PR 456: ", "Merge pull request #456
// from …"), starts with fix, hotfix, bugfix or revert. A fix that came in as a merge commit is compared with
// its first parent as one change, and the commits it brought in are not scanned again.

import { execFileSync } from 'node:child_process';

const MERGE_PREFIX = /^(Merged PR \d+:\s*|Merge pull request #\d+ from \S+\s*|Merge branch '[^']*'( into \S+)?\s*)/i;
const FIX_SUBJECT = /^(fix|hotfix|bugfix)(\([^)]*\))?!?:|^(hotfix|bugfix)\b|^revert\b|^Revert "/i;
const REVERTS = /This reverts commit ([0-9a-f]{7,40})/i;

export const isFix = (subject) => FIX_SUBJECT.test(subject.replace(MERGE_PREFIX, ''));

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parentsOf = (repo, sha) => (git(repo, ['rev-list', '--parents', '-n', '1', sha]) ?? '').split(' ').slice(1);

export function findMergeCommit(repo, branch, pr) {
  if (pr.mergeCommit && git(repo, ['cat-file', '-t', pr.mergeCommit]) === 'commit') return git(repo, ['rev-parse', pr.mergeCommit]);
  const id = escapeRe(String(pr.pr));
  const patterns = [`Merged PR ${id}\\b`, `Merge pull request #${id}\\b`, `\\(#${id}\\)`, `!${id}\\b`];
  // The oldest match that is not a revert: a later `Revert "… (#123)"` carries the same number.
  for (const pattern of patterns) {
    const matches = (git(repo, ['log', '--first-parent', '-E', '-i', `--grep=${pattern}`, '--format=%H%x1f%s', branch]) ?? '')
      .split('\n').filter(Boolean).map((l) => l.split('\x1f')).filter(([, subject]) => !/^Revert\b/i.test(subject));
    if (matches.length) return matches.at(-1)[0];
  }
  return null;
}

export function prCommits(repo, merge, count = 1) {
  const parents = parentsOf(repo, merge);
  if (parents.length >= 2) return [merge, ...(git(repo, ['rev-list', `${parents[0]}..${parents[1]}`]) ?? '').split('\n').filter(Boolean)];
  if (count > 1) return (git(repo, ['rev-list', '--first-parent', '-n', String(count), merge]) ?? '').split('\n').filter(Boolean);
  return [merge];
}

// Old-side line ranges a commit removed or rewrote, per file, against its first parent. File names come
// from -z output (no quoting, no tab after names with spaces); only hunk headers are read from each diff, so
// a removed line that starts with "--" can never pass for a file header.
export function changedRanges(repo, fix) {
  const raw = git(repo, ['diff', '--name-status', '-z', '-M', `${fix}^`, fix]) ?? '';
  const parts = raw.split('\0').filter((p) => p !== '');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) files.push({ old: parts[i++], now: parts[i++] });
    else if (status === 'A') i++;
    else { const path = parts[i++]; files.push({ old: path, now: status === 'D' ? null : path }); }
  }
  const ranges = [];
  for (const { old, now } of files) {
    const paths = now && now !== old ? [old, now] : [old];
    for (const line of (git(repo, ['diff', '-U0', '--no-color', '-M', `${fix}^`, fix, '--', ...paths]) ?? '').split('\n')) {
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+/);
      if (!hunk) continue;
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) ranges.push({ file: old, start: Number(hunk[1]), count });
    }
  }
  return ranges;
}

function blame(repo, fix, { file, start, count }) {
  const out = git(repo, ['blame', '--porcelain', '-L', `${start},+${count}`, `${fix}^`, '--', file]) ?? '';
  // Porcelain prints "<sha> <orig> <final> [<group size>]" before each line's content.
  return out.split('\n').filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l)).map((l) => l.slice(0, 40));
}

export function scanEscapes({ repo, branch, since, records, limit = 300 }) {
  const reviewed = records.filter((r) => r.kind === 'pr' && r.outcome === 'merged');
  const escapeRecords = records.filter((r) => r.kind === 'escape');
  const decided = new Set(escapeRecords.map((r) => `${r.prUrl ?? r.pr}|${r.fix}`));
  const decidedFixes = new Set(escapeRecords.map((r) => r.fix));
  const owner = new Map(); // commit -> PR record
  const unresolved = [];
  let oldest = null;
  for (const pr of reviewed) {
    const merge = findMergeCommit(repo, branch, pr);
    if (!merge) { unresolved.push(pr.prUrl ?? pr.pr); continue; }
    for (const sha of prCommits(repo, merge, pr.commits ?? 1)) owner.set(sha, { ...pr, mergeCommit: merge });
    const time = Number(git(repo, ['show', '-s', '--format=%ct', merge]));
    if (Number.isFinite(time) && (!oldest || time < oldest.time)) oldest = { sha: merge, time };
  }
  if (!oldest) return { reviewed: reviewed.length, unresolved, scanned: 0, truncated: 0, candidates: [] };

  // Oldest first: the fixes closest to the reviewed PRs are the likeliest escapes.
  const log = git(repo, ['log', '--reverse', '--format=%H%x1f%P%x1f%s%x1f%b%x1f%cI%x1e', ...(since ? [`--since=${since}`] : []), `${oldest.sha}..${branch}`]) ?? '';
  const all = log.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => {
    const [sha, parents, subject, body, date] = e.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), subject, body: body ?? '', date };
  });
  // A fix merged as a merge commit is one change; the commits it brought in are not scanned on their own.
  const insideFixMerges = new Set();
  for (const c of all) {
    if (c.parents.length >= 2 && isFix(c.subject)) {
      for (const sha of (git(repo, ['rev-list', `${c.parents[0]}..${c.parents[1]}`]) ?? '').split('\n').filter(Boolean)) insideFixMerges.add(sha);
    }
  }
  const pending = all.filter((c) => isFix(c.subject) && !insideFixMerges.has(c.sha) && !decidedFixes.has(c.sha));
  const fixes = pending.slice(0, limit);

  const candidates = [];
  const key = (pr) => pr.prUrl ?? pr.pr;
  for (const fix of fixes) {
    const fixOwner = owner.get(fix.sha);
    const add = (pr, extra) => {
      if (fixOwner && key(fixOwner) === key(pr)) return; // a PR fixing its own lines before it merged
      if (decided.has(`${key(pr)}|${fix.sha}`)) return;
      candidates.push({ pr: pr.pr, prUrl: pr.prUrl ?? null, tier: pr.tier, mergeCommit: pr.mergeCommit, fix: fix.sha, subject: fix.subject, date: fix.date, ...extra });
    };
    const reverted = fix.body.match(REVERTS)?.[1];
    if (reverted) {
      const full = git(repo, ['rev-parse', reverted]);
      const pr = full && owner.get(full);
      if (pr) { add(pr, { kind: 'revert', lines: null, share: 1 }); continue; }
    }
    const ranges = changedRanges(repo, fix.sha);
    const total = ranges.reduce((n, r) => n + r.count, 0);
    if (!total) continue;
    const byPr = new Map();
    for (const range of ranges) {
      for (const sha of blame(repo, fix.sha, range)) {
        const pr = owner.get(sha);
        if (!pr) continue;
        const entry = byPr.get(key(pr)) ?? { pr, lines: 0, files: new Set() };
        entry.lines++;
        entry.files.add(range.file);
        byPr.set(key(pr), entry);
      }
    }
    for (const { pr, lines, files } of byPr.values()) add(pr, { kind: 'fix', lines, share: Math.round((100 * lines) / total) / 100, files: [...files].slice(0, 5) });
  }
  candidates.sort((a, b) => b.share - a.share || (a.date ?? '').localeCompare(b.date ?? ''));
  return { reviewed: reviewed.length, unresolved, scanned: fixes.length, truncated: pending.length - fixes.length, candidates };
}
