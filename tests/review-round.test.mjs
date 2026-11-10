// The review round's logic with stub agents: which agents a tier starts, on which model and effort, how
// reports of one defect merge, what the skeptics keep and drop, and when a round counts as clean.
// Run: node --test tests/*.test.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'skills/babysit-pr/workflows/review-round.js'), 'utf8').replace('export const meta', 'const meta');
const tiers = JSON.parse(readFileSync(join(ROOT, 'skills/babysit-pr/references/tiers.json'), 'utf8')).tiers;
const run = new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', `return (async () => {${source}\n})()`);

const F = (title, severity, file, line, extra = {}) => ({ title, severity, file, line, claim: `claim of ${title}`, evidence: `evidence of ${title}`, impact: 'impact', suggestedFix: 'fix it', ...extra });
const uphold = (severity) => ({ refuted: false, reason: 'holds', severity, evidence: 'read it' });
const refute = { refuted: true, reason: 'guard upstream at X.cs:1', severity: 'minor', evidence: 'read it' };

async function round({ tierName, scope = 'full', reviews, groups = () => [], verdict = (_, severity) => uphold(severity), second, portions, fail = [], sinceSha = null, human = [] }) {
  const calls = [];
  const prompts = {};
  const used = {};
  const agent = async (prompt, opts) => {
    calls.push(opts.label);
    prompts[opts.label] = prompt;
    used[opts.label] = `${opts.model}/${opts.effort}`;
    assert.ok(['low', 'medium', 'high'].includes(opts.effort), `${opts.label} runs at ${opts.effort}`);
    assert.ok(opts.model, `${opts.label} names no model`);
    if (fail.includes(opts.label)) return null;
    if (opts.label === 'map') return { portions };
    if (opts.label === 'group') return { groups: groups(prompt) };
    if (opts.label.startsWith('review:')) return { findings: reviews[opts.label.slice(7)] ?? [], checked: 'ok' };
    if (opts.label.startsWith('skeptic:blocker-')) return second(prompt);
    if (opts.label.startsWith('skeptic:')) {
      const found = [...prompt.matchAll(/^Finding (\d+): \[(\w+)\] \S+ - (.*)$/gm)];
      return { verdicts: found.map((m) => ({ index: Number(m[1]), ...verdict(m[3], m[2]) })) };
    }
    throw new Error(`unexpected agent ${opts.label}`);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const result = await run(
    { round: scope === 'delta' ? 2 : 1, tierName, tier: tiers[tierName], scope, pr: { id: 7, title: 'T', webUrl: 'u', intent: 'intent', score: 50 }, repo: { worktree: '/wt', mergeBase: 'aaa', headSha: 'bbb', sinceSha }, signals: { hitIds: [], reasons: [], destructive: [] }, prior: [], human, scratch: '/s' },
    agent, parallel, null, () => {}, () => {},
  );
  return { result, calls, prompts, used };
}

test('every tier names its model and none goes past high', () => {
  for (const [name, t] of Object.entries(tiers)) {
    assert.ok(t.model, `${name} names no model`);
    assert.ok(['medium', 'high'].includes(t.effort), `${name} runs at ${t.effort}`);
  }
});

test('critical, full round: one finding per defect, one skeptic pass, a second skeptic for a blocker', async () => {
  const { result, calls, prompts, used } = await round({
    tierName: 'critical',
    portions: [{ name: 'Domain', files: ['a.cs'], focus: 'x' }, { name: 'Infra', files: ['b.cs'], focus: 'y' }],
    reviews: {
      'correctness-domain': [F('Ten rejected rows switch the sync off', 'major', 'a.cs', 80), F('Edge case in mapping', 'minor', 'a.cs', 10)],
      'correctness-infra': [F('One bad upload stops the sync for everyone', 'major', 'b.cs', 85)],
      adversary: [F('Sync halts until restart after ten rejections', 'major', 'a.cs', 120), F('Migration drops a column', 'blocker', 'm.sql', 3, { oneWay: true })],
      'adversary-fable': [F('Password goes to any server', 'major', 'c.cs', 5)],
      'standards-spec': [F('Naming breaks the glossary', 'minor', 'd.cs', 1), F('Typo', 'nit', 'd.cs', 2)],
      'blast-radius': [F('Old build writes rows that never sync', 'minor', 'e.cs', 9)],
    },
    groups: (prompt) => {
      const same = [...prompt.matchAll(/^Report (\d+): .*(rejected rows|bad upload|ten rejections)/gm)].map((m) => Number(m[1]));
      return [{ members: same, cause: 'the streak counter' }, { members: [99, 0], cause: 'a group the script must ignore' }];
    },
    verdict: (title, severity) => (/Naming|Migration/.test(title) ? refute : uphold(severity)),
    second: () => uphold('blocker'),
  });
  assert.equal(result.valid, true);
  // The ladder: the tier's model and effort for reviewers and the skeptics of major findings, the next model
  // up for the second adversary and a blocker's second skeptic, small models for routing and minor findings.
  assert.deepEqual(used, {
    map: 'haiku/medium',
    'review:correctness-domain': 'opus/high', 'review:correctness-infra': 'opus/high', 'review:standards-spec': 'opus/high',
    'review:blast-radius': 'opus/high', 'review:adversary': 'opus/high', 'review:adversary-fable': 'fable/high',
    group: 'sonnet/medium', 'skeptic:majors-1': 'opus/high', 'skeptic:minors-1': 'sonnet/high',
    'skeptic:blocker-migration-drops-a-column': 'fable/high',
  });
  const streak = result.findings.filter((f) => /rejected|upload|rejections/.test(f.title));
  assert.equal(streak.length, 1, 'three reports of one defect are one finding');
  assert.equal(streak[0].lenses.length, 3);
  assert.equal(streak[0].alsoAt.length, 2);
  assert.equal(result.findings.find((f) => f.severity === 'blocker').verification, 'upheld by 1 of 2 skeptics');
  assert.deepEqual(result.dropped.map((d) => [d.title, d.severity]), [['Naming breaks the glossary', 'minor']]);
  assert.equal(result.coverage.duplicatesMerged, 2);
  assert.equal(result.coverage.skeptics, 3);
  assert.equal(result.coverage.agents, calls.length);
  assert.equal(result.clean, false);
  assert.deepEqual(result.findings.map((f) => f.id), ['R1-F1', 'R1-F2', 'R1-F3', 'R1-F4', 'R1-F5']);
  assert.match(prompts['skeptic:majors-1'], /do not look up tickets/);
  assert.match(prompts['review:standards-spec'], /Read the linked work item/);
  assert.match(prompts['review:correctness-domain'], /a test would fail if the code were wrong/);
});

test('critical, follow-up round: a minor in a fix is clean, a major is not', async () => {
  const minor = await round({ tierName: 'critical', scope: 'delta', sinceSha: 'ccc', reviews: { fixes: [F('A deploy still writes two error logs', 'minor', 'a.cs', 4)], adversary: [] } });
  assert.deepEqual(minor.calls, ['review:fixes', 'review:adversary', 'skeptic:minors-1']);
  assert.equal(minor.result.clean, true);
  assert.match(minor.prompts['review:fixes'], /git -C "\/wt" diff ccc\.\.bbb/);
  const major = await round({ tierName: 'critical', scope: 'delta', sinceSha: 'ccc', reviews: { fixes: [F('The fix breaks the caller', 'major', 'a.cs', 4)], adversary: [] } });
  assert.equal(major.result.clean, false);
});

test('low: Sonnet at high, duplicates merged, findings checked by a skeptic', async () => {
  const { result, calls, used } = await round({
    tierName: 'low',
    reviews: { correctness: [F('Null key crashes the handler', 'major', 'a.cs', 4)], 'standards-spec': [F('Handler does not accept keys without expiry', 'major', 'b.cs', 40)] },
    groups: () => [{ members: [0, 1], cause: 'same' }],
  });
  assert.deepEqual(calls, ['review:correctness', 'review:standards-spec', 'group', 'skeptic:majors-1']);
  assert.equal(used['review:correctness'], 'sonnet/high');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].verification, 'upheld by a skeptic');
});

test('trivial: one Sonnet reviewer at medium, nothing grouped or checked', async () => {
  const { result, calls, used } = await round({ tierName: 'trivial', reviews: { generalist: [F('a', 'minor', 'a.cs', 1), F('b', 'minor', 'a.cs', 90)] } });
  assert.deepEqual(calls, ['review:generalist']);
  assert.equal(used['review:generalist'], 'sonnet/medium');
  assert.equal(result.clean, true);
  assert.equal(result.findings[0].verification, 'not checked by skeptics at this tier');
});

test('medium: a skeptic without an answer makes the round invalid; failed grouping does not', async () => {
  const base = { tierName: 'medium', reviews: { correctness: [F('x', 'major', 'a.cs', 1)], 'blast-radius': [F('y', 'minor', 'b.cs', 1)] } };
  const bad = await round({ ...base, fail: ['skeptic:majors-1'] });
  assert.equal(bad.result.valid, false);
  assert.deepEqual(bad.result.failed, ['skeptic of "x"']);
  const ok = await round({ ...base, fail: ['group'] });
  assert.equal(ok.result.valid, true);
  assert.equal(ok.result.findings.length, 2);
  assert.equal(ok.used['review:correctness'], 'opus/medium');
  assert.equal(ok.used['skeptic:majors-1'], 'opus/medium');
});

test('high: nine majors go to three skeptics of at most four each', async () => {
  const many = Array.from({ length: 9 }, (_, i) => F(`major ${i}`, 'major', `f${i}.cs`, 1));
  const { calls } = await round({ tierName: 'high', portions: [{ name: 'One', files: ['a'], focus: 'f' }], reviews: { 'correctness-one': many } });
  assert.deepEqual(calls.filter((c) => c.startsWith('skeptic:')), ['skeptic:majors-1', 'skeptic:majors-2', 'skeptic:majors-3']);
});
