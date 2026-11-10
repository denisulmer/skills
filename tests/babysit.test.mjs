// babysit.mjs end to end on a plain-git repository: what it posts (one log thread, and a thread of its own
// only for a finding that needs a person), the stop rule, the bars of full and follow-up rounds, the round
// limit, decisions, and what a finished review does when new commits arrive.
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTS, sandbox } from './helpers.mjs';

const F = (id, severity, extra = {}) => ({ id, title: `finding ${id}`, severity, file: 'a.txt', line: 1, claim: 'It breaks.', evidence: 'a.txt:1', impact: 'Someone is hurt.', suggestedFix: 'Fix it.', lenses: ['correctness'], verification: 'upheld by a skeptic', ...extra });
const risk = (tier, score) => ({ score, tier, door: 'recoverable', doorWord: 'one-way, recoverable', doorPoints: 28, doorWhy: 'why door', radius: 'contract', radiusWord: 'contract', radiusPoints: 57, radiusWhy: 'why radius', adjust: 0, floor: 0, cap: 100, boundReasons: [], safeBecause: 'it is off', safeBecauseProven: true });
const result = (round, tier, scope, findings, extra = {}) => ({ round, tier, scope, valid: true, clean: false, findings, nits: [], dropped: [], human: [], coverage: { agents: 3, reviewers: ['correctness'], portions: [], skeptics: 1, duplicatesMerged: 0 }, ...extra });
const visible = (content) => content.replace(/<!--[\s\S]*?-->/g, '').trim();

function harness(t) {
  const s = sandbox(t);
  const babysit = (cmd, pr, ...args) => s.node(SCRIPTS.babysit, cmd, '--pr', String(pr), '--repo', s.repo, ...args);
  const push = (branch) => s.git('branch', '-f', branch, 'HEAD');
  const open = (branch, tier, score) => {
    s.git('checkout', '-q', '-b', branch, 'main');
    s.commit('a.txt', `one\n${branch}\n`, `feat: ${branch}`);
    s.git('checkout', '-q', '--detach', branch);
    const pr = s.node(SCRIPTS.prHost, 'open', '--source', branch, '--target', 'main', '--title', `PR ${branch}`, '--draft').id;
    assert.equal(babysit('state', pr).next.action, 'triage');
    babysit('triage', pr, '--risk', s.write(`${branch}-risk.json`, risk(tier, score)), '--intent-file', s.write('intent.txt', 'Do the thing.'), '--scratch', s.scratch);
    return pr;
  };
  const threads = (pr) => s.node(SCRIPTS.prHost, 'threads', String(pr));
  // The visible text of the comment with this key, wherever it sits.
  const body = (pr, key) => {
    const comment = threads(pr).flatMap((x) => x.comments).find((c) => c.key === key);
    assert.ok(comment, `no comment with key ${key}`);
    return visible(comment.content);
  };
  // A round up to the fixer's outcomes: the workflow's result, then what the fixer decided.
  const run = (pr, n, branch, tier, findings, outcomes, { mode, ...extra } = {}) => {
    const args = babysit('args', pr, '--target', 'main', '--scratch', s.scratch, ...(mode ? ['--mode', mode] : []));
    assert.equal(args.round, n);
    for (const f of readdirSync(s.scratch).filter((name) => name.startsWith(`round-${n}-`) && !name.endsWith('-args.json'))) rmSync(join(s.scratch, f), { force: true });
    s.write(`round-${n}-result.json`, result(n, tier, args.scope, findings, extra));
    const recorded = babysit('record', pr, '--round', String(n), '--scratch', s.scratch);
    const results = outcomes.map((o) => {
      if (o.decision !== 'fixed') return o;
      const sha = s.commit('a.txt', `one\n${branch} ${o.id}\n`, `fix: ${o.id}\n\nRefs: pr-babysit ${o.id}`);
      return { id: o.id, decision: 'fixed', rootCause: 'c', change: 'ch', proof: { command: 'test', result: '1 passed' }, commit: sha };
    });
    if (results.some((r) => r.decision === 'fixed')) push(branch);
    const replied = results.length
      ? babysit('reply', pr, '--round', String(n), '--scratch', s.scratch, '--fixer', s.write(`round-${n}-fixer.json`, { results, nitsCommit: null }), '--checks', s.write(`round-${n}-checks.json`, { status: 'none' }))
      : null;
    return { args, recorded, replied };
  };
  const close = (pr, n) => babysit('summary', pr, '--round', String(n), '--scratch', s.scratch);
  const round = (...a) => { const r = run(...a); return { ...r, summary: close(a[0], a[1]) }; };
  const ledger = () => {
    const dir = join(s.work, 'cfg', 'pr-metrics');
    return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  };
  return { ...s, babysit, push, open, threads, body, run, close, round, ledger };
}

test('a fix with proof posts no thread; a decline gets one; the rest is the log', (t) => {
  const h = harness(t);
  const pr = h.open('feature', 'critical', 85);
  assert.match(h.body(pr, 'pr-babysit:triage'), /\*\*Plan:\*\* round 1 reviews the whole change .* up to 4 rounds in all · a skeptic checks every finding/);

  const first = h.round(pr, 1, 'feature', 'critical',
    [F('R1-F1', 'major', { alsoAt: ['b.txt:9'], lenses: ['correctness-a', 'adversary'] }), F('R1-F2', 'minor', { alsoAt: ['c.txt:3'] })],
    [{ id: 'R1-F1', decision: 'fixed' }, { id: 'R1-F2', decision: 'declined', declineKind: 'by-design', declineReason: 'ADR-0038 allows it.' }],
    { dropped: [{ title: 'a refuted major', severity: 'major', file: 'a.txt', line: 2, lenses: ['adversary'], reason: 'guarded upstream' }, { title: 'a refuted minor', severity: 'minor', file: 'a.txt', line: 3, lenses: ['correctness'], reason: 'not reachable' }], coverage: { agents: 9, reviewers: ['correctness-a', 'standards-spec', 'adversary'], portions: ['A'], skeptics: 2, duplicatesMerged: 2 } });
  assert.deepEqual([first.args.scope, first.args.ask], ['full', false]);

  // One log thread with the round's entries, and one thread for the finding a person may disagree with.
  const all = h.threads(pr);
  assert.deepEqual(all.map((x) => x.key), ['pr-babysit:triage', 'pr-babysit:R1-F2']);
  assert.deepEqual(all[0].comments.map((c) => c.key.replace(/-outcomes-\w+$/, '-outcomes')), ['pr-babysit:triage', 'pr-babysit:R1-findings', 'pr-babysit:R1-outcomes', 'pr-babysit:R1-summary']);
  assert.equal(all[0].status, 'closed');
  assert.equal(h.body(pr, 'pr-babysit:R1-findings'), '🤖 **Round 1:** 🟠 1 · 🟡 1 found, 2 disproved → fixing');
  const declined = all[1];
  assert.equal(declined.status, 'byDesign');
  assert.equal(declined.comments.length, 1, 'the verdict and the finding are one comment');
  const text = visible(declined.comments[0].content);
  assert.match(text, /^🤖 ↩️ \*\*Declined, by design:\*\* ADR-0038 allows it\./);
  assert.match(text, /\*\*The finding was:\*\* finding R1-F2\. It breaks\. Someone is hurt\. The same defect also shows at `c.txt:3`\./);

  assert.equal(first.summary.clean, false);
  assert.deepEqual([first.summary.next.action, first.summary.next.round, first.summary.next.scope], ['round', 2, 'delta']);
  const summary = h.body(pr, 'pr-babysit:R1-summary');
  assert.match(summary, /\| 🟠 \| R1-F1 finding R1-F1 \| ✅ `[0-9a-f]{7}` \|/, 'a fixed finding is a row without a link');
  assert.match(summary, /\| 🟡 \| \[R1-F2\]\(.+\) finding R1-F2 \| ↩️ by design \|/);
  assert.match(summary, /\*\*Not clean\*\* \(2 at or above minor\) → round 2 is next, on the fixes only/);
  assert.match(summary, /- 🟠 `a.txt:2` a refuted major: guarded upstream/);
  assert.match(summary, /opus high · 2 duplicate reports merged · every finding checked by a skeptic \(2\)/);

  const state = h.babysit('state', pr);
  assert.deepEqual(state.findings.map((f) => [f.id, f.status]), [['R1-F1', 'fixed'], ['R1-F2', 'byDesign']]);
  assert.equal(state.findings[0].detail, undefined, 'state stays small');
  assert.equal(state.cost.rounds, 1);

  const second = h.round(pr, 2, 'feature', 'critical', [F('R2-F1', 'minor', { lenses: ['fixes'] })], [{ id: 'R2-F1', decision: 'fixed' }]);
  assert.deepEqual([second.args.scope, second.args.ask], ['delta', false]);
  assert.match(JSON.stringify(JSON.parse(readFileSync(second.args.file, 'utf8')).prior), /"key":"R1-F1".*"resolution":"fixed: fixed in [0-9a-f]{7}: ch"/);
  assert.equal(second.summary.clean, true, 'a minor in a follow-up round is clean, even at critical');
  assert.equal(second.summary.next.action, 'report');
  assert.equal(h.threads(pr).length, 2, 'round 2 added no thread');

  // A finished review starts no round by itself, opens again when someone else pushed, and asks first.
  assert.throws(() => h.babysit('args', pr, '--target', 'main', '--scratch', h.scratch), /not a new round/);
  h.commit('b.txt', 'new\n', 'feat: more');
  h.push('feature');
  const again = h.babysit('args', pr, '--target', 'main', '--scratch', h.scratch);
  assert.deepEqual([again.round, again.scope, again.ask], [3, 'full', true]);
});

test('a decision: one thread with the ask, a reply when decided, and the ledger says whether the recommendation was taken', (t) => {
  const h = harness(t);
  const pr = h.open('decide', 'high', 70);
  const ask = (id, recommendation) => ({ id, decision: 'escalate', question: `What about ${id}?`, options: ['A: keep it (safe)', 'B: remove it (clean)'], recommendation });
  const { replied } = h.run(pr, 1, 'decide', 'high', [F('R1-F1', 'major'), F('R1-F2', 'major'), F('R1-F3', 'minor')],
    [ask('R1-F1', 'A, because it is safe'), ask('R1-F2', 'A, because it is safe'), { id: 'R1-F3', decision: 'fixed' }]);
  assert.deepEqual(replied.decisions.map((d) => d.id), ['R1-F1', 'R1-F2']);
  assert.ok(replied.decisions[0].thread, 'the decision names its thread');
  const thread = h.threads(pr).find((x) => x.key === 'pr-babysit:R1-F1');
  assert.equal(thread.status, 'pending');
  const text = visible(thread.comments[0].content);
  assert.match(text, /^🤖 ❓ \*\*Needs T:\*\* What about R1-F1\?\n\nfinding R1-F1\. It breaks\. Someone is hurt\.\n\n- \*\*A \(recommended\):\*\* keep it \(safe\)\n- \*\*B:\*\* remove it \(clean\)\n\nRecommended because it is safe\./);
  let state = h.babysit('state', pr);
  assert.equal(state.next.action, 'await-decisions');
  assert.deepEqual(state.findings.map((f) => f.status), ['pending', 'pending', 'fixed']);

  // The user takes one recommendation and overrides the other.
  const fix = h.commit('a.txt', 'one\ndecided\n', 'fix: R1-F2\n\nRefs: pr-babysit R1-F2');
  h.push('decide');
  h.babysit('reply', pr, '--round', '1', '--scratch', h.scratch,
    '--fixer', h.write('round-1-fixer-decisions.json', { results: [{ id: 'R1-F1', decision: 'declined', declineReason: 'Kept as it is.' }, { id: 'R1-F2', decision: 'fixed', rootCause: 'c', change: 'removed it', proof: { command: 't', result: 'ok' }, commit: fix }], nitsCommit: null }),
    '--checks', h.write('round-1-checks.json', { status: 'none' }),
    '--choices', h.write('round-1-choices.json', { 'R1-F1': { option: 'A', text: 'keep it' }, 'R1-F2': '2B' }));
  const decided = h.threads(pr).find((x) => x.key === 'pr-babysit:R1-F2');
  assert.equal(decided.status, 'fixed');
  assert.match(visible(decided.comments[1].content), /^🤖 🧭 \*\*Decided by T:\*\* 2B\n\nDone in `[0-9a-f]{7}`: removed it/);
  state = h.babysit('state', pr);
  assert.equal(state.next.action, 'close');
  const summary = h.close(pr, 1);
  assert.match(h.body(pr, 'pr-babysit:R1-summary'), /✅ 1 fixed · 🧭 2 decided/);
  assert.equal(summary.next.action, 'round');
  assert.deepEqual(h.ledger().find((r) => r.kind === 'round').decided, { asRecommended: 1, overridden: 1 });
});

test('someone writes on a thread of the review: the review has to answer', (t) => {
  const h = harness(t);
  const pr = h.open('talk', 'high', 70);
  h.round(pr, 1, 'talk', 'high', [F('R1-F1', 'minor')], [{ id: 'R1-F1', decision: 'declined', declineKind: 'false-positive', declineReason: 'unreachable' }]);
  assert.deepEqual(h.babysit('state', pr).humanWaiting, []);
  const thread = h.threads(pr).find((x) => x.key === 'pr-babysit:R1-F1');
  h.node(SCRIPTS.prHost, 'reply', String(pr), String(thread.id), '--body', 'I disagree: it is reachable through the import job.');
  const state = h.babysit('state', pr);
  assert.deepEqual(state.humanWaiting.map((x) => x.threadId), [thread.id]);
  // The finished review opens again for it.
  assert.equal(h.babysit('args', pr, '--target', 'main', '--scratch', h.scratch).round, 2);
});

test('review-only: every finding is a thread for the author; a round without findings still closes', (t) => {
  const h = harness(t);
  const pr = h.open('theirs', 'medium', 50);
  const { recorded } = h.run(pr, 1, 'theirs', 'medium', [F('R1-F1', 'major'), F('R1-F2', 'minor')], [], { mode: 'review' });
  assert.equal(recorded.created, 2);
  assert.deepEqual(h.threads(pr).map((x) => [x.key, x.status]), [['pr-babysit:triage', 'closed'], ['pr-babysit:R1-F1', 'active'], ['pr-babysit:R1-F2', 'active']]);
  assert.match(h.body(pr, 'pr-babysit:R1-findings'), /→ posted for the author$/);

  const empty = h.open('nothing', 'low', 30);
  h.run(empty, 1, 'nothing', 'low', [], []);
  assert.equal(h.body(empty, 'pr-babysit:R1-findings'), '🤖 **Round 1:** nothing found');
  assert.deepEqual(h.babysit('state', empty).next, { action: 'close', round: 1, why: 'every finding of round 1 is handled; post its summary' });
  assert.equal(h.close(empty, 1).next.action, 'report');
});

test('an unclean round whose findings were all declined ends the review, with no round on nothing', (t) => {
  const h = harness(t);
  const pr = h.open('declined', 'high', 70);
  const { summary } = h.round(pr, 1, 'declined', 'high', [F('R1-F1', 'major')], [{ id: 'R1-F1', decision: 'declined', declineKind: 'false-positive', declineReason: 'unreachable' }]);
  assert.equal(summary.clean, false);
  assert.equal(summary.next.action, 'report');
  assert.match(h.body(pr, 'pr-babysit:R1-summary'), /nothing changed since, so there is no fix to verify/);
  assert.match(h.babysit('state', pr).next.why, /nothing changed since/);
});

test('two unclean rounds at low reach the round limit', (t) => {
  const h = harness(t);
  const pr = h.open('limit', 'low', 30);
  h.round(pr, 1, 'limit', 'low', [F('R1-F1', 'major')], [{ id: 'R1-F1', decision: 'fixed' }]);
  const { summary } = h.round(pr, 2, 'limit', 'low', [F('R2-F1', 'major')], [{ id: 'R2-F1', decision: 'fixed' }]);
  assert.equal(summary.next.action, 'round-limit');
  assert.match(h.body(pr, 'pr-babysit:R2-summary'), /the round limit is reached/);
});

test('a spec read out of a ticket reaches the reviewers: its criteria, and the ones no test covers yet', (t) => {
  const h = harness(t);
  const pr = h.open('ticket', 'medium', 50);
  h.commit('tests/keys.test.js', "test('AC1: an old key is refused', () => {});\n", 'feat: AC1\n\nRefs: SHOP-228 AC1');
  h.push('ticket');
  const spec = h.write('spec.md', '---\ntitle: Keys expire\nticket: SHOP-228\nstatus: approved\n---\n\n# Keys expire\n\n## Acceptance criteria\n\n- **AC1:** An old key is refused. · *verified by* test\n- **AC2:** A key without an expiry date keeps working. · *verified by* test\n');
  const args = h.babysit('args', pr, '--target', 'main', '--scratch', h.scratch, '--spec-file', spec);
  assert.deepEqual(args.spec, { path: spec.replace(/\\/g, '/'), acs: 2, missingTests: ['AC2'] });
  const round = JSON.parse(readFileSync(args.file, 'utf8'));
  assert.deepEqual(round.spec.acs.map((ac) => ac.id), ['AC1', 'AC2']);
  assert.deepEqual(round.spec.missingCommits, ['AC2']);
  // Without it, and with no spec file on the branch, the round has no spec.
  assert.equal(h.babysit('args', pr, '--target', 'main', '--scratch', h.scratch).spec, null);
});
