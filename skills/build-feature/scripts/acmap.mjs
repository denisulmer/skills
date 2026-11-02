#!/usr/bin/env node
// The acceptance-criteria map of a change: for every AC in the spec, the commits that name it and the tests
// that carry its id, and which testable ACs have neither. A mechanical check: it proves an AC is covered by
// name, not that the test is good; the review judges that.
//
//   node acmap.mjs --spec <docs/specs/…md> --base <ref> [--head HEAD] [--repo <path>]
//
// ACs are spec lines of the form `- **AC3:** <statement> · *verified by* <test | manual: … | adr: …>`
// (spec-feature/references/spec-format.md). A commit names an AC with the trailer
// `Refs: spec <slug> AC3` (that trailer line, with this spec's slug); a test carries the id in its name or
// description (`AC3`, `TestAC3_…`, `test_ac3`: any case, no digit touching it). An AC whose statement is struck through (`~~…~~`) was dropped.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_FILE, git, parseArgs } from '../../setup-repo/scripts/profile.mjs';

// Test files in the languages TEST_FILE (shared with the danger map) does not cover: Go, Python, Ruby, and
// Rust, whose tests live inline in any .rs file. Prose never counts: TEST_FILE also matches docs under specs/.
const MORE_TESTS = /(^|\/)test_[^/]*\.py$|_test\.(py|go)$|_spec\.rb$|\.rs$/i;
const PROSE = /\.(md|mdx|txt|adoc|rst)$/i;
export const isTestFile = (file) => !PROSE.test(file) && (TEST_FILE.test(file) || MORE_TESTS.test(file));

const AC_LINE = /^\s*[-*]\s*\*\*(AC\d+):\*\*\s*(.+?)\s*$/;
const VERIFIED = /\s*·\s*\*verified by\*\s*(.+)$/i;

export function parseSpec(text) {
  const front = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  // A value ends at a ` #` comment; an empty field reads as null.
  const field = (name) => front.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'))?.[1]?.replace(/\s+#.*$|^#.*$/, '').trim() || null;
  const acs = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(AC_LINE);
    if (!m) continue;
    const verified = m[2].match(VERIFIED);
    const by = verified?.[1]?.trim() ?? 'test';
    const statement = m[2].replace(VERIFIED, '').trim();
    const dropped = statement.startsWith('~~');
    acs.push({ id: m[1], statement, verifiedBy: by, testable: !dropped && /^test\b/i.test(by), dropped });
  }
  return { title: field('title'), status: field('status'), slug: field('slug'), branch: field('branch'), acs };
}

// The slug from the front matter, else from the file name (<YYYY-MM-DD>-<slug>.md).
const slugOf = (parsed, spec) => parsed.slug ?? basename(spec, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function acMap({ spec, base, head = 'HEAD', repo = '.' }) {
  const parsed = parseSpec(readFileSync(resolve(repo, spec), 'utf8'));
  const slug = slugOf(parsed, spec);
  const mergeBase = git(repo, ['merge-base', base, head]).trim();
  const commits = git(repo, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${mergeBase}..${head}`])
    .split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => { const [sha, subject, body] = e.split('\x1f'); return { sha, subject, body: body ?? '' }; });

  // Added lines in test files, with their new line numbers.
  const added = [];
  let file = null;
  let lineNo = 0;
  for (const line of git(repo, ['diff', '-U0', '--no-color', mergeBase, head]).split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (file && isTestFile(file)) added.push({ file, line: lineNo, text: line.slice(1) });
      lineNo++;
    }
  }

  // One entry per id: the first definition (an amendment edits it in place, never repeats it).
  const unique = parsed.acs.filter((ac, i) => parsed.acs.findIndex((x) => x.id === ac.id) === i);
  const acs = unique.map((ac) => {
    // In test names the id sits inside identifiers (TestAC1_Refused, test_ac1): any case, not next to a digit.
    const inTest = new RegExp(`(?<![0-9])${ac.id}(?![0-9])`, 'i');
    // Only the trailer line counts: an amendment's body may mention an AC it does not build.
    const trailer = new RegExp(`^Refs:\\s*spec\\s+${escape(slug)}\\b.*\\b${ac.id}\\b`, 'im');
    return {
      ...ac,
      commits: commits.filter((c) => trailer.test(c.body)).map((c) => `${c.sha.slice(0, 7)} ${c.subject}`),
      tests: added.filter((a) => inTest.test(a.text)).map((a) => `${a.file}:${a.line}`),
    };
  });
  return {
    spec,
    slug,
    title: parsed.title,
    status: parsed.status,
    acs,
    missingTests: acs.filter((ac) => ac.testable && ac.tests.length === 0).map((ac) => ac.id),
    missingCommits: acs.filter((ac) => !ac.dropped && ac.commits.length === 0).map((ac) => ac.id),
    dropped: acs.filter((ac) => ac.dropped).map((ac) => ac.id),
    untestable: acs.filter((ac) => !ac.testable && !ac.dropped).map((ac) => `${ac.id}: ${ac.verifiedBy}`),
  };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts.spec !== 'string' || typeof opts.base !== 'string') {
    console.error('usage: node acmap.mjs --spec <file> --base <ref> [--head HEAD] [--repo <path>]');
    process.exit(2);
  }
  try {
    const map = acMap({ spec: opts.spec, base: opts.base, head: typeof opts.head === 'string' ? opts.head : 'HEAD', repo: typeof opts.repo === 'string' ? opts.repo : '.' });
    console.log(JSON.stringify(map, null, 2));
    process.exit(map.missingTests.length || map.missingCommits.length ? 1 : 0);
  } catch (error) {
    console.error(`acmap: ${error.message}`);
    process.exit(2);
  }
}
