// ticket.mjs against a stand-in for Jira Cloud's REST API: the section is written into the stored document,
// the stakeholder's blocks stay as they were, and a server that changes them gets its description back.
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from './helpers.mjs';

const { jiraRead, jiraTarget, jiraWrite } = await import(pathToFileURL(join(ROOT, 'skills/sync-ticket/scripts/ticket.mjs')));

const SPEC = `---
title: Keys expire
ticket: SHOP-7
status: approved
approved: 2026-11-10 by Denis
risk: low 20
---

# Keys expire

## Acceptance criteria

- **AC1:** An old key is refused. · *verified by* test
`;
const stakeholder = [
  { type: 'paragraph', content: [{ type: 'text', text: 'Please make keys expire, ' }, { type: 'mention', attrs: { id: '5b10a', text: '@Jane Doe' } }] },
  { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'abc', type: 'file', collection: 'c' } }] },
];

// A Jira that stores what it is sent. `onPut` may change the document first, like a server that rewrites it.
async function fakeJira(t, { onPut = (doc) => doc } = {}) {
  const issue = { key: 'SHOP-7', fields: { summary: 'Keys expire', description: { type: 'doc', version: 1, content: structuredClone(stakeholder) }, status: { name: 'To Do' }, issuetype: { name: 'Story' }, subtasks: [{ key: 'SHOP-8', fields: { summary: 'AC1: An old key is refused.', status: { name: 'Done' } } }] } };
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, auth: request.headers.authorization });
      if (request.headers.authorization !== `Basic ${Buffer.from('me@example.com:secret').toString('base64')}`) { response.writeHead(401).end('{"errorMessages":["no"]}'); return; }
      if (!request.url.startsWith('/rest/api/3/issue/SHOP-7')) { response.writeHead(404).end('{}'); return; }
      if (request.method === 'PUT') { issue.fields.description = onPut(JSON.parse(body).fields.description, calls.filter((c) => c.method === 'PUT').length); response.writeHead(204).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(issue));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'secret', JIRA_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  return { issue, calls, env };
}

test('the section is written into Jira\'s document and the stakeholder\'s blocks stay as they were', async (t) => {
  const { issue, calls, env } = await fakeJira(t);
  const ticket = 'https://example.atlassian.net/browse/SHOP-7';
  assert.equal((await jiraRead(ticket, env)).spec, null, 'no section yet');

  assert.deepEqual(await jiraWrite(ticket, SPEC, env), { key: 'SHOP-7', written: true, replaced: false });
  const content = issue.fields.description.content;
  assert.deepEqual(content.slice(0, 2), stakeholder);
  assert.deepEqual(content.slice(2, 4).map((node) => node.type), ['rule', 'heading']);
  assert.deepEqual(calls.filter((c) => c.method === 'PUT').length, 1);

  const back = await jiraRead(ticket, env);
  assert.deepEqual([back.key, back.title, back.status, back.type], ['SHOP-7', 'Keys expire', 'To Do', 'Story']);
  assert.deepEqual(back.subtasks, [{ key: 'SHOP-8', summary: 'AC1: An old key is refused.', status: 'Done' }]);
  assert.ok(back.spec.includes('status: approved') && back.spec.includes('- **AC1:** An old key is refused. · *verified by* test'));
  assert.deepEqual((await jiraWrite(ticket, SPEC, env)).replaced, true, 'a second write replaces the section');
  assert.equal(issue.fields.description.content.filter((node) => node.type === 'heading' && node.attrs.level === 2).length, 1);
});

test('a server that changes what the stakeholder wrote gets the description back as it was', async (t) => {
  // It drops the image on the first write, and stores the second (the restore) as sent.
  const { issue, calls, env } = await fakeJira(t, { onPut: (document, nth) => (nth === 1 ? { ...document, content: document.content.filter((node) => node.type !== 'mediaSingle') } : document) });
  await assert.rejects(jiraWrite('https://example.atlassian.net/browse/SHOP-7', SPEC, env), /put back as it was: block 2: was "" \(mediaSingle\)/);
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 2);
  assert.deepEqual(issue.fields.description.content, stakeholder);
});

test('what a ticket and the credentials have to look like', () => {
  const env = { JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'secret' };
  assert.equal(jiraTarget('https://example.atlassian.net/browse/SHOP-7?focusedId=1', env).base, 'https://example.atlassian.net');
  assert.equal(jiraTarget('SHOP-7', { ...env, JIRA_SITE: 'https://example.atlassian.net/' }).base, 'https://example.atlassian.net');
  assert.throws(() => jiraTarget('SHOP-7', env), /pass the ticket as its URL/);
  assert.throws(() => jiraTarget('https://example.atlassian.net/browse/SHOP-7', {}), /JIRA_EMAIL and JIRA_API_TOKEN are not set/);
  assert.throws(() => jiraTarget('not a key', env), /not a ticket key or URL/);
});

test('wrong credentials say so', async (t) => {
  const { env } = await fakeJira(t);
  await assert.rejects(jiraRead('https://example.atlassian.net/browse/SHOP-7', { ...env, JIRA_API_TOKEN: 'wrong' }), /401.*check JIRA_EMAIL and JIRA_API_TOKEN/);
});
