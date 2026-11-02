// Defects that escaped review: later fix, hotfix and revert commits on the default branch whose changed lines
// were written by a PR babysit-pr reviewed. Blame proposes; a person confirms. A line that traces back to a
// PR does not prove the review missed something (the fix may change behaviour on purpose), so every
// candidate goes to the user before it counts.
//
// A reviewed PR's commits: its merge commit and, for a merge commit with two parents, every commit it brought
// in; for a squash merge, the one commit; for a rebase or fast-forward merge of n commits (`commits` on the
// PR record), the n first-parent commits ending at it. The merge commit comes from the PR record
// (`mergeCommit`, written by merge-pr) or, for older records, from the subjects on the target's first-parent
// history ("Merged PR 123", "Merge pull request #123", "(#123)", "!123").
//
// A fix: a commit whose subject, after a host's merge prefix ("Merged PR 456: ", "Merge pull request #456
// from …"), starts with fix / fixed / fixes (conventional `fix(scope):` included), hotfix, bugfix or revert.
// A fix that came in as a merge commit is compared with its first parent as one change, and the commits it
// brought in are not scanned again.
//
// Every scanned fix leaves a trace (the PRs its lines led to), so a later scan skips a fix only once every
// one of those PRs has a verdict, and the report counts undecided candidates from the traces.

import { execFileSync } from 'node:child_process';

const MERGE_PREFIX = /^(Merged PR \d+:\s*|Merge pull request #\d+ from \S+\s*|Merge branch '[^']*'( into \S+)?\s*)/i;
const FIX_SUBJECT = /^(fix(e[sd])?|hotfix|bugfix|revert)\b/i;
const REVERTS = /This reverts commit ([0-9a-f]{7,40})/i;

export const isFix = (subject) => FIX_SUBJECT.test(subject.replace(MERGE_PREFIX, ''));

export function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parentsOf = (repo, sha) => (git(repo, ['rev-list', '--parents', '-n', '1', sha]) ?? '').split(' ').slice(1);
export const prKey = (r) => r.prUrl ?? String(r.pr);

// The target's first-parent history, oldest first, read once per scan: [{ sha, subject }].
export function firstParentLog(repo, branch) {
  return (git(repo, ['log', '--first-parent', '--reverse', '--format=%H%x1f%s', branch]) ?? '')
    .split('\n').filter(Boolean).map((l) => { const [sha, subject] = l.split('\x1f'); return { sha, subject }; });
}

// The PR's merge commit: from its record, else the oldest first-parent commit whose subject (not body) names
// the PR, skipping reverts, which carry the same number.
export function findMergeCommit(repo, history, pr) {
  if (pr.mergeCommit && git(repo, ['cat-file', '-t', pr.mergeCommit]) === 'commit') return git(repo, ['rev-parse', pr.mergeCommit]);
  const id = escapeRe(String(pr.pr));
  for (const pattern of [`^Merged PR ${id}\\b`, `^Merge pull request #${id}\\b`, `\\(#${id}\\)`, `!${id}\\b`]) {
    const re = new RegExp(pattern, 'i');
    const hit = history.find((c) => re.test(c.subject) && !/^Revert\b/i.test(c.subject));
    if (hit) return hit.sha;
  }
  return null;
}

export function prCommits(repo, merge, count = 1) {
  const parents = parentsOf(repo, merge);
  if (parents.length >= 2) return [merge, ...(git(repo, ['rev-list', `${parents[0]}..${parents[1]}`]) ?? '').split('\n').filter(Boolean)];
  if (count > 1) return (git(repo, ['rev-list', '--first-parent', '-n', String(count), merge]) ?? '').split('\n').filter(Boolean);
  return [merge];
}

// Old-side line ranges a commit removed or rewrote, grouped by file, against its first parent. Names come
// from -z output (no quoting); the patch is read once, split at its "diff --git" headers, which follow the
// same order as the names; inside a file only hunk headers are read, so a removed line starting with "--"
// can never pass for a file header.
export function changedRanges(repo, fix) {
  const parts = (git(repo, ['diff', '--name-status', '-z', '-M', `${fix}^`, fix]) ?? '').split('\0').filter((p) => p !== '');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) { files.push({ old: parts[i++] }); i++; }
    else if (status === 'A') { files.push({ old: null }); i++; }
    else files.push({ old: parts[i++] });
  }
  const byFile = new Map();
  let index = -1;
  for (const line of (git(repo, ['diff', '-U0', '--no-color', '-M', `${fix}^`, fix]) ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) { index++; continue; }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+/);
    const file = files[index]?.old;
    if (!hunk || !file) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) byFile.set(file, [...(byFile.get(file) ?? []), { start: Number(hunk[1]), count }]);
  }
  return byFile;
}

// One blame per file, with every range of the fix in it.
function blame(repo, fix, file, ranges) {
  const out = git(repo, ['blame', '--porcelain', ...ranges.flatMap((r) => ['-L', `${r.start},+${r.count}`]), `${fix}^`, '--', file]) ?? '';
  // Porcelain prints "<sha> <orig> <final> [<group size>]" before each line's content.
  return out.split('\n').filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l)).map((l) => l.slice(0, 40));
}

export function scanEscapes({ repo, branch, since, records, limit = 300 }) {
  const reviewed = records.filter((r) => r.kind === 'pr' && r.outcome === 'merged');
  const decided = new Set(records.filter((r) => r.kind === 'escape').map((r) => `${prKey(r)}|${r.fix}`));
  const traced = new Map(records.filter((r) => r.kind === 'escape-trace').map((r) => [r.fix, r.prs ?? []]));
  const settledFix = (sha) => traced.has(sha) && traced.get(sha).every((k) => decided.has(`${k}|${sha}`));
  const history = firstParentLog(repo, branch);
  const owner = new Map(); // commit -> PR record
  const unresolved = [];
  let oldest = null;
  for (const pr of reviewed) {
    const merge = findMergeCommit(repo, history, pr);
    if (!merge) { unresolved.push(prKey(pr)); continue; }
    for (const sha of prCommits(repo, merge, pr.commits ?? 1)) owner.set(sha, { ...pr, mergeCommit: merge });
    const time = Number(git(repo, ['show', '-s', '--format=%ct', merge]));
    if (Number.isFinite(time) && (!oldest || time < oldest.time)) oldest = { sha: merge, time };
  }
  const empty = { reviewed: reviewed.length, unresolved, scanned: 0, truncated: 0, candidates: [], traces: [] };
  if (!oldest || !history.length) return empty;

  // Oldest first: the fixes closest to the reviewed PRs are the likeliest escapes.
  const log = git(repo, ['log', '--reverse', '--format=%H%x1f%P%x1f%s%x1f%b%x1f%cI%x1e', ...(since ? [`--since=${since}`] : []), `${oldest.sha}..${branch}`]) ?? '';
  const all = log.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => {
    const [sha, parents, subject, body, date] = e.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), subject, body: body ?? '', date };
  });
  const insideFixMerges = new Set();
  for (const c of all) {
    if (c.parents.length >= 2 && isFix(c.subject)) for (const sha of prCommits(repo, c.sha).slice(1)) insideFixMerges.add(sha);
  }
  const pending = all.filter((c) => isFix(c.subject) && !insideFixMerges.has(c.sha) && !settledFix(c.sha));
  const fixes = pending.slice(0, limit);

  const candidates = [];
  const traces = [];
  for (const fix of fixes) {
    const fixOwner = owner.get(fix.sha);
    const found = new Map(); // prKey -> { pr, extra }
    const reverted = fix.body.match(REVERTS)?.[1];
    const revertedPr = reverted && owner.get(git(repo, ['rev-parse', reverted]) ?? '');
    if (revertedPr) {
      found.set(prKey(revertedPr), { pr: revertedPr, extra: { kind: 'revert', lines: null, share: 1 } });
    } else {
      const byFile = changedRanges(repo, fix.sha);
      const total = [...byFile.values()].flat().reduce((n, r) => n + r.count, 0);
      const counts = new Map();
      for (const [file, ranges] of byFile) {
        for (const sha of blame(repo, fix.sha, file, ranges)) {
          const pr = owner.get(sha);
          if (!pr) continue;
          const entry = counts.get(prKey(pr)) ?? { pr, lines: 0, files: new Set() };
          entry.lines++;
          entry.files.add(file);
          counts.set(prKey(pr), entry);
        }
      }
      for (const [k, { pr, lines, files }] of counts) found.set(k, { pr, extra: { kind: 'fix', lines, share: Math.round((100 * lines) / total) / 100, files: [...files].slice(0, 5) } });
    }
    // A PR fixing its own lines before it merged is not an escape.
    if (fixOwner) found.delete(prKey(fixOwner));
    traces.push({ fix: fix.sha, prs: [...found.keys()] });
    for (const [k, { pr, extra }] of found) {
      if (decided.has(`${k}|${fix.sha}`)) continue;
      candidates.push({ pr: pr.pr, prUrl: pr.prUrl ?? null, tier: pr.tier, mergeCommit: pr.mergeCommit, fix: fix.sha, subject: fix.subject, date: fix.date, ...extra });
    }
  }
  candidates.sort((a, b) => b.share - a.share || (a.date ?? '').localeCompare(b.date ?? ''));
  return { reviewed: reviewed.length, unresolved, scanned: fixes.length, truncated: pending.length - fixes.length, candidates, traces };
}

// Undecided candidates, live: traced (fix, PR) pairs without a verdict.
export function undecided(records) {
  const decided = new Set(records.filter((r) => r.kind === 'escape').map((r) => `${prKey(r)}|${r.fix}`));
  return records.filter((r) => r.kind === 'escape-trace').reduce((n, t) => n + (t.prs ?? []).filter((k) => !decided.has(`${k}|${t.fix}`)).length, 0);
}
