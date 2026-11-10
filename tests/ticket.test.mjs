// The Specification section of a ticket: it goes into the description without changing what the stakeholder
// wrote, in Jira's document format and in Markdown, comes back out as the same spec, and a changed
// stakeholder block is caught.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, sandbox } from './helpers.mjs';

const TICKET = join(ROOT, 'skills/sync-ticket/scripts/ticket.mjs');
const { adfToMarkdown, checkAbove, markdownToAdf, mergeSection, parseDescription, planSubtasks, readSpec } = await import(pathToFileURL(TICKET));
const { parseSpec } = await import(pathToFileURL(join(ROOT, 'skills/build-feature/scripts/acmap.mjs')));

const SPEC = `---
title: Supplier keys expire after 90 days
ticket: SHOP-228
slug: SHOP-228
status: approved
created: 2026-11-10
approved: 2026-11-10 by Denis
branch: feature/SHOP-228-supplier-key-expiry
pr:
risk: medium 50
---

# Supplier keys expire after 90 days

## Why

Suppliers keep keys forever. A leaked key works **until someone notices**.

## Acceptance criteria

- **AC1:** Given a key issued 91 days ago, when a supplier calls any API, then the call is refused with 401 and \`key_expired\`. · *verified by* test
- **AC2:** A key without an expiry date keeps working until it is rotated. · *verified by* test
- **AC3:** The key list shows each key's expiry date. · *verified by* manual: open the portal as a supplier

## Decisions

- **Existing keys?** Keep working until rotated. 🚪 one-way: decided by Denis on 2026-11-10.

## Plan

- \`src/Auth/ApiKeyHandler.cs\`: check the expiry.
  - and its tests
- See [ADR-0012](https://example.com/adr/12).

## Open questions

None.
`;

// What a stakeholder writes in Jira: text, a mention, a table, an image. None of it is ours to understand.
const stakeholder = [
  { type: 'paragraph', content: [{ type: 'text', text: 'Keys should ' }, { type: 'text', text: 'expire', marks: [{ type: 'strong' }] }, { type: 'text', text: ', says ' }, { type: 'mention', attrs: { id: '5b10a', text: '@Jane Doe', accessLevel: '' } }, { type: 'text', text: '.' }] },
  { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', collection: 'jira-10000', width: 640, height: 480 } }] },
  { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default', localId: 't1' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '90 days' }] }] }] }] },
  { type: 'panel', attrs: { panelType: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Needed before the audit.' }] }] },
];
const doc = (content) => JSON.stringify({ version: 1, type: 'doc', content });

test('Jira: the section is added below the stakeholder\'s blocks, which stay exactly as they were', () => {
  const before = doc(stakeholder);
  const merged = mergeSection(before, SPEC);
  assert.equal(merged.format, 'adf');
  const after = JSON.parse(merged.text);
  assert.deepEqual(after.content.slice(0, stakeholder.length), stakeholder);
  assert.equal(after.content[stakeholder.length].type, 'rule');
  assert.deepEqual(after.content[stakeholder.length + 1], { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Specification' }] });
  assert.deepEqual(checkAbove(before, merged.text), []);

  // The status line a stakeholder reads, and the nested list.
  const section = adfToMarkdown(after.content.slice(stakeholder.length + 1));
  assert.match(section, /^## Specification\n\n\*Status: approved 2026-11-10 by Denis · Risk: medium 50 · Branch: feature\/SHOP-228-supplier-key-expiry · Created: 2026-11-10\*/);
  assert.match(section, /### Acceptance criteria\n\n- \*\*AC1:\*\* Given a key issued 91 days ago/);
  assert.match(section, /- `src\/Auth\/ApiKeyHandler.cs`: check the expiry\.\n {2}- and its tests\n- See \[ADR-0012\]\(https:\/\/example.com\/adr\/12\)\./);
  const strong = after.content.find((n) => n.type === 'paragraph' && n.content.some((c) => c.text === 'until someone notices'));
  assert.deepEqual(strong.content.find((c) => c.text === 'until someone notices').marks, [{ type: 'strong' }]);

  // Written a second time, it replaces itself: one rule, one section.
  const again = JSON.parse(mergeSection(merged.text, SPEC.replace('status: approved', 'status: approved').replace('pr:', 'pr: https://dev.azure.com/x/_git/y/pullrequest/7')).text);
  assert.equal(again.content.filter((n) => n.type === 'rule').length, 1);
  assert.equal(again.content.filter((n) => n.type === 'heading' && n.attrs.level === 2).length, 1);
  assert.deepEqual(again.content.slice(0, stakeholder.length), stakeholder);
  assert.match(adfToMarkdown(again.content), /PR: https:\/\/dev\.azure\.com\/x\/_git\/y\/pullrequest\/7/);
});

test('Jira: the spec comes back out of the ticket as it went in', () => {
  const merged = mergeSection(doc(stakeholder), SPEC).text;
  const back = readSpec(merged, { ticket: 'SHOP-228', title: 'Supplier keys expire after 90 days' });
  const [a, b] = [parseSpec(SPEC), parseSpec(back)];
  assert.deepEqual(b.acs, a.acs);
  assert.deepEqual([b.title, b.status, b.ticket, b.branch], [a.title, 'approved', 'SHOP-228', a.branch]);
  assert.match(back, /^approved: 2026-11-10 by Denis$/m);
  assert.match(back, /^risk: medium 50$/m);
  assert.match(back, /^## Decisions\n\n- \*\*Existing keys\?\*\* Keep working until rotated\. 🚪 one-way: decided by Denis on 2026-11-10\.$/m);
  assert.equal(readSpec(doc(stakeholder), { ticket: 'SHOP-228', title: 't' }), null, 'no section yet');
});

test('Jira: a changed stakeholder block is caught; ids Jira adds when it stores a document are not changes', () => {
  const before = doc(stakeholder);
  const after = JSON.parse(mergeSection(before, SPEC).text);
  const stored = structuredClone(after);
  stored.content[0].attrs = { localId: 'p-1' };
  stored.content[2].attrs.localId = 'other';
  assert.deepEqual(checkAbove(before, JSON.stringify(stored)), []);

  const damaged = structuredClone(after);
  damaged.content[0].content[0].text = 'Keys must ';
  damaged.content.splice(1, 1);
  const differences = checkAbove(before, JSON.stringify(damaged));
  assert.equal(differences.length, 4);
  assert.match(differences[0], /^block 1: was "Keys should expire, says @Jane Doe\." \(paragraph\), is "Keys must expire, says @Jane Doe\." \(paragraph\)$/);
  assert.match(differences[1], /^block 2: was "" \(mediaSingle\), is "90 days" \(table\)$/);
});

test('an empty description, and a Markdown one', () => {
  const empty = mergeSection('null', SPEC, { format: 'adf' });
  assert.equal(JSON.parse(empty.text).content[0].type, 'heading', 'no rule above the section when nothing is above it');
  assert.deepEqual(checkAbove('null', empty.text), []);
  assert.equal(parseDescription('').format, 'empty');

  const before = 'Keys should expire.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const merged = mergeSection(before, SPEC);
  assert.equal(merged.format, 'markdown');
  assert.ok(merged.text.startsWith('Keys should expire.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n## Specification\n'));
  assert.deepEqual(checkAbove(before, merged.text), []);
  assert.deepEqual(checkAbove(before, mergeSection(merged.text, SPEC).text), [], 'writing it twice changes nothing above it');
  assert.deepEqual(checkAbove(before, merged.text.replace('Keys should', 'Keys must')), ['the text above the Specification section differs']);
  assert.deepEqual(parseSpec(readSpec(merged.text, { ticket: 'SHOP-228', title: 'Supplier keys expire after 90 days' })).acs, parseSpec(SPEC).acs);
});

test('Markdown and Jira\'s format convert both ways for what the section uses', () => {
  const markdown = '## A heading\n\nA paragraph with **bold**, *italic*, ~~gone~~, `code` and [a link](https://example.com/x).\n\n1. one\n2. two\n\n---\n\n```js\nconst a = 1;\n```';
  assert.equal(adfToMarkdown(markdownToAdf(markdown)), markdown);
  assert.deepEqual(markdownToAdf('https://example.com/a.')[0].content, [{ type: 'text', text: 'https://example.com/a', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }] }, { type: 'text', text: '.' }]);
  assert.deepEqual(markdownToAdf('snake_case_name and 2 * 3 * 4')[0].content, [{ type: 'text', text: 'snake_case_name and 2 * 3 * 4' }], 'underscores and stars inside words are text');
});

test('one sub-task per acceptance criterion, found again by its "AC<n>:" summary', () => {
  const plan = planSubtasks(SPEC.replace('- **AC2:** A key', '- **AC2:** ~~A key').replace('rotated. · *verified by* test', 'rotated.~~ dropped: not needed · *verified by* test'), [
    { key: 'SHOP-231', summary: 'AC1: Given a key issued 91 days ago…', status: 'Done' },
    { key: 'SHOP-232', summary: 'AC2: A key without an expiry date', status: 'To Do' },
    { key: 'SHOP-240', summary: 'Something a person added', status: 'To Do' },
  ]);
  assert.deepEqual(plan.existing, [{ ac: 'AC1', key: 'SHOP-231', status: 'Done' }]);
  assert.deepEqual(plan.dropped, [{ ac: 'AC2', key: 'SHOP-232', status: 'To Do' }]);
  assert.deepEqual(plan.create.map((x) => [x.ac, x.summary]), [['AC3', "AC3: The key list shows each key's expiry date."]]);
  assert.match(plan.create[0].description, /Verified by: manual: open the portal as a supplier/);
});

test('the command line: merge, check and read on files; a commit names its criterion with the ticket key', (t) => {
  const s = sandbox(t);
  const spec = s.write('spec.md', SPEC);
  const before = s.write('before.json', doc(stakeholder));
  const merged = s.node(TICKET, 'merge', '--description', before, '--spec', spec, '--out', join(s.scratch, 'after.json'));
  assert.deepEqual([merged.format, merged.replaced], ['adf', false]);
  assert.deepEqual(s.node(TICKET, 'check', '--before', before, '--after', merged.out), { unchanged: true });
  const read = s.node(TICKET, 'read', '--description', merged.out, '--ticket', 'SHOP-228', '--title', 'Supplier keys expire after 90 days', '--out', join(s.scratch, 'back.md'));
  assert.deepEqual([read.status, read.acs], ['approved', 3]);
  assert.throws(() => s.node(TICKET, 'check', '--before', before, '--after', s.write('bad.json', doc([{ type: 'paragraph', content: [{ type: 'text', text: 'rewritten' }] }]))), /block 1/);

  // acmap finds the criterion's commit by the ticket key, and its test by the id.
  s.git('checkout', '-q', '-b', 'feature/SHOP-228-supplier-key-expiry');
  s.commit('tests/keys.test.js', "test('AC1: an old key is refused', () => {});\n", 'feat(auth): AC1 expire keys\n\nRefs: SHOP-228 AC1');
  s.commit('src/other.js', '1\n', 'feat: unrelated\n\nRefs: SHOP-2281 AC2');
  let map;
  // acmap exits 1 while a criterion is uncovered; its map is on stdout either way.
  try { map = s.node(join(ROOT, 'skills/build-feature/scripts/acmap.mjs'), '--spec', read.out, '--base', 'main', '--repo', s.repo); } catch (error) { map = JSON.parse(error.stdout); }
  assert.deepEqual(map.missingCommits, ['AC2', 'AC3']);
  assert.deepEqual(map.missingTests, ['AC2']);
  assert.equal(map.slug, 'SHOP-228');
});
