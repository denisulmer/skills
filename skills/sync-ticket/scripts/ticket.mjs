#!/usr/bin/env node
// The part of working on a ticket that must come out the same every time: putting the specification into
// its own section of the ticket's description without touching a word of what the stakeholder wrote,
// proving afterwards that nothing else changed, reading the specification back, and saying which sub-tasks
// the acceptance criteria need. Everything else on a ticket (sub-tasks, statuses, comments) is done with the
// tracker's own tools: the Atlassian connector for Jira, `gh` for GitHub issues.
//
//   node ticket.mjs transport
//       how this machine writes a Jira description: `api` (exact) or `connector` (plain descriptions only)
//   node ticket.mjs jira-read  --ticket <url|KEY> [--out <spec.md>]      needs JIRA_EMAIL and JIRA_API_TOKEN
//       the ticket's title, status and sub-tasks, and its specification as a spec file
//   node ticket.mjs jira-write --ticket <url|KEY> --spec <spec.md>       needs JIRA_EMAIL and JIRA_API_TOKEN
//       writes the section into the description, reads it back, and puts the description back if anything
//       above the section changed
//
// Without those two variables, the description travels through a connector as a file:
//
//   node ticket.mjs merge    --description <file> --spec <spec.md> --out <file>
//       the description with the Specification section added or replaced; everything above it is kept
//   node ticket.mjs check    --before <file> --after <file>
//       exit 0 when everything above the Specification section is the same in both, else 1 with the differences
//   node ticket.mjs read     --description <file> --ticket <KEY> --title "<summary>" [--out <spec.md>]
//       the specification in the ticket, as the spec file the other skills work from
//   node ticket.mjs render   --spec <spec.md>
//       the section as Markdown, as it is written into a Markdown description
//   node ticket.mjs subtasks --spec <spec.md> [--existing <file>]
//       one sub-task per acceptance criterion: which to create, which exist, which belong to a dropped criterion
//
// A description file holds what the tracker returned: Jira's document format (ADF, JSON with "type": "doc")
// or Markdown text (GitHub, GitLab, Azure Boards as Markdown). `null`, an empty file and `{}` are an empty
// description. The section starts at the heading "Specification" and runs to the end of the description:
// everything above the heading is the stakeholder's, everything from it on is rewritten.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../../build-feature/scripts/acmap.mjs';
import { parseArgs } from '../../setup-repo/scripts/profile.mjs';

export const HEADING = 'Specification';
const NOTE = '_Written by the spec-feature skill. Add to the ticket above this heading: everything from here on is rewritten._';
const FIELDS = [['status', 'Status'], ['risk', 'Risk'], ['branch', 'Branch'], ['pr', 'PR'], ['created', 'Created']];

// ---------------------------------------------------------------------------------------------
// The spec file and the section

function splitSpec(text) {
  const normal = text.replace(/\r\n/g, '\n');
  const front = normal.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = {};
  for (const line of (front?.[1] ?? '').split('\n')) {
    const m = line.match(/^([\w-]+):[ \t]*(.*)$/);
    if (m) fields[m[1]] = m[2].replace(/\s+#.*$|^#.*$/, '').trim();
  }
  // The title is the ticket's summary, so the `# Title` line stays out of the section.
  const body = normal.slice(front?.[0].length ?? 0).replace(/^\s*# .*\n/, '').trim();
  return { fields, body };
}

// The section as Markdown: a status line a stakeholder can read instead of front matter, then the spec with
// its headings one level down.
export function renderSection(specText) {
  const { fields, body } = splitSpec(specText);
  const status = fields.status === 'approved' && fields.approved ? `approved ${fields.approved}` : fields.status || 'draft';
  const line = FIELDS.map(([key, label]) => [label, key === 'status' ? status : fields[key]]).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join(' · ');
  return [`## ${HEADING}`, '', `_${line}_`, '', NOTE, '', body.replace(/^(#{2,5}) /gm, '#$1 ')].join('\n').trim();
}

// The spec file back from a section's Markdown.
export function specFromSection(section, { ticket, title }) {
  const lines = section.replace(/\r\n/g, '\n').split('\n');
  const statusLine = lines.find((line) => /^[_*].*\bStatus:/.test(line)) ?? '';
  const fields = Object.fromEntries(statusLine.replace(/^[_*]|[_*]$/g, '').split(' · ').map((part) => part.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1].toLowerCase(), m[2].trim()]));
  const approved = fields.status?.match(/^approved\s+(.+)$/);
  const start = lines.findIndex((line) => /^#{3,6} /.test(line));
  const body = (start < 0 ? [] : lines.slice(start)).join('\n').replace(/^#(#{2,5}) /gm, '$1 ').trim();
  const front = [
    `title: ${title}`,
    `ticket: ${ticket}`,
    `slug: ${ticket}`,
    `status: ${approved ? 'approved' : fields.status || 'draft'}`,
    ...(fields.created ? [`created: ${fields.created}`] : []),
    `approved: ${approved?.[1] ?? ''}`.trimEnd(),
    `branch: ${fields.branch ?? ''}`.trimEnd(),
    `pr: ${fields.pr ?? ''}`.trimEnd(),
    `risk: ${fields.risk ?? ''}`.trimEnd(),
  ];
  return `---\n${front.join('\n')}\n---\n\n# ${title}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------------------------
// Markdown to Jira's document format and back, for the subset the section uses: headings, paragraphs,
// bullet and numbered lists (nested by indentation), rules, code blocks, and bold, italic, strike, code and
// links inline.

const text = (value, marks = []) => (value ? [{ type: 'text', text: value, ...(marks.length ? { marks } : {}) }] : []);

export function inlineToAdf(source, marks = []) {
  const out = [];
  const pattern = /(`[^`]+`)|(\*\*(?=\S)[\s\S]+?(?<=\S)\*\*)|(~~(?=\S)[\s\S]+?(?<=\S)~~)|(\[[^\]]+\]\([^)\s]+\))|((?<![\w*])\*(?=\S)[^*]+?(?<=\S)\*(?![\w*]))|((?<![\w_])_(?=\S)[^_]+?(?<=\S)_(?![\w_]))|(https?:\/\/[^\s<>)]+[^\s<>).,;:!?])/;
  let rest = source;
  while (rest) {
    const m = rest.match(pattern);
    if (!m) { out.push(...text(rest, marks)); break; }
    out.push(...text(rest.slice(0, m.index), marks));
    const token = m[0];
    if (m[1]) out.push(...text(token.slice(1, -1), [...marks, { type: 'code' }]));
    else if (m[2]) out.push(...inlineToAdf(token.slice(2, -2), [...marks, { type: 'strong' }]));
    else if (m[3]) out.push(...inlineToAdf(token.slice(2, -2), [...marks, { type: 'strike' }]));
    else if (m[4]) { const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/); out.push(...inlineToAdf(link[1], [...marks, { type: 'link', attrs: { href: link[2] } }])); }
    else if (m[5] || m[6]) out.push(...inlineToAdf(token.slice(1, -1), [...marks, { type: 'em' }]));
    else out.push(...text(token, [...marks, { type: 'link', attrs: { href: token } }]));
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

const paragraph = (source) => ({ type: 'paragraph', content: inlineToAdf(source) });

function listToAdf(lines, indent) {
  const items = [];
  let ordered = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
    if (!m) { if (items.length) items.at(-1).text += ` ${lines[i].trim()}`; continue; }
    if (m[1].length > indent && items.length) { items.at(-1).children.push(lines[i]); continue; }
    if (!items.length) ordered = /\d/.test(m[2]);
    items.push({ text: m[3], children: [] });
  }
  return {
    type: ordered ? 'orderedList' : 'bulletList',
    content: items.map((item) => ({
      type: 'listItem',
      content: [paragraph(item.text), ...(item.children.length ? [listToAdf(item.children, item.children[0].match(/^\s*/)[0].length)] : [])],
    })),
  };
}

export function markdownToAdf(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      nodes.push({ type: 'codeBlock', ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: text(code.join('\n')) });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { nodes.push({ type: 'heading', attrs: { level: heading[1].length }, content: inlineToAdf(heading[2]) }); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { nodes.push({ type: 'rule' }); continue; }
    const isItem = (l) => /^\s*([-*]|\d+[.)])\s+/.test(l);
    if (isItem(line)) {
      const block = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && (isItem(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) block.push(lines[++i]);
      nodes.push(listToAdf(block, line.match(/^\s*/)[0].length));
      continue;
    }
    const para = [line.trim()];
    while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,6}\s|```|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i + 1]) && !isItem(lines[i + 1])) para.push(lines[++i].trim());
    nodes.push(paragraph(para.join(' ')));
  }
  return nodes;
}

function inlineToMarkdown(nodes = []) {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '\n';
    if (node.type !== 'text') return node.text ?? node.attrs?.text ?? inlineToMarkdown(node.content);
    const has = (type) => (node.marks ?? []).find((mark) => mark.type === type);
    let out = node.text;
    if (has('code')) out = `\`${out}\``;
    if (has('strong')) out = `**${out}**`;
    if (has('em')) out = `*${out}*`;
    if (has('strike')) out = `~~${out}~~`;
    const link = has('link');
    if (link) out = link.attrs.href === node.text ? node.text : `[${out}](${link.attrs.href})`;
    return out;
  }).join('').replace(/\*\*\*\*/g, '');
}

function listToMarkdown(node, depth) {
  return node.content.map((item, i) => {
    const [first, ...rest] = item.content ?? [];
    const bullet = node.type === 'orderedList' ? `${i + 1}.` : '-';
    const nested = rest.map((child) => (/List$/.test(child.type) ? listToMarkdown(child, depth + 1) : `${'  '.repeat(depth + 1)}${inlineToMarkdown(child.content)}`));
    return [`${'  '.repeat(depth)}${bullet} ${inlineToMarkdown(first?.content)}`, ...nested].join('\n');
  }).join('\n');
}

export function adfToMarkdown(nodes) {
  return nodes.map((node) => {
    if (node.type === 'heading') return `${'#'.repeat(node.attrs?.level ?? 1)} ${inlineToMarkdown(node.content)}`;
    if (node.type === 'paragraph') return inlineToMarkdown(node.content);
    if (/List$/.test(node.type)) return listToMarkdown(node, 0);
    if (node.type === 'rule') return '---';
    if (node.type === 'codeBlock') return `\`\`\`${node.attrs?.language ?? ''}\n${inlineToMarkdown(node.content)}\n\`\`\``;
    return inlineToMarkdown(node.content);
  }).filter((block) => block !== '').join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// A description: the stakeholder's part and our section, in either format

const plain = (node) => (node.text ?? node.attrs?.text ?? '') + (node.content ?? []).map(plain).join('');
const isOurHeading = (node) => node?.type === 'heading' && plain(node).trim() === HEADING;

// { format, doc?, above, section }: `above` is everything before the section (nodes or text), without the
// rule we put in front of it.
export function parseDescription(raw) {
  const trimmed = (raw ?? '').replace(/^﻿/, '').trim();
  let json = null;
  if (/^[{[n"]/.test(trimmed)) { try { json = JSON.parse(trimmed); } catch { json = null; } }
  if (typeof json === 'string') return parseDescription(json);
  if (trimmed === '' || trimmed === 'null' || (json && typeof json === 'object' && !Array.isArray(json) && !Object.keys(json).length)) return { format: 'empty', above: null, section: null };
  if (json?.type === 'doc') {
    const content = json.content ?? [];
    const at = content.findIndex(isOurHeading);
    const end = at < 0 ? content.length : content[at - 1]?.type === 'rule' ? at - 1 : at;
    return { format: 'adf', doc: json, above: content.slice(0, end), section: at < 0 ? null : content.slice(at) };
  }
  const normal = (raw ?? '').replace(/\r\n/g, '\n');
  const lines = normal.split('\n');
  const at = lines.findIndex((line) => new RegExp(`^##\\s+${HEADING}\\s*$`).test(line));
  const above = (at < 0 ? lines : lines.slice(0, at)).join('\n').replace(/\s*\n-{3,}\s*$/, '').trimEnd();
  return { format: 'markdown', above, section: at < 0 ? null : lines.slice(at).join('\n').trim() };
}

// The description with the section added or replaced. An empty description becomes Jira's format when
// `format` says so (the caller knows the tracker), else Markdown.
export function mergeSection(raw, specText, { format } = {}) {
  const parsed = parseDescription(raw);
  const section = renderSection(specText);
  const kind = parsed.format === 'empty' ? format ?? 'markdown' : parsed.format;
  if (kind === 'adf') {
    const above = parsed.above ?? [];
    const doc = { ...(parsed.doc ?? { type: 'doc', version: 1 }), content: [...above, ...(above.length ? [{ type: 'rule' }] : []), ...markdownToAdf(section)] };
    return { format: 'adf', text: JSON.stringify(doc, null, 2), replaced: parsed.section !== null };
  }
  const above = parsed.above ?? '';
  return { format: 'markdown', text: `${above ? `${above}\n\n---\n\n` : ''}${section}\n`, replaced: parsed.section !== null };
}

// Jira adds ids and empty containers when it stores a document; those are not changes to what was written.
function canonical(node) {
  if (Array.isArray(node)) return node.map(canonical);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const key of Object.keys(node).sort()) {
    if (key === 'localId') continue;
    const value = canonical(node[key]);
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) continue;
    if (Array.isArray(value) && !value.length && key === 'marks') continue;
    out[key] = value;
  }
  return out;
}

// What differs above the section between two versions of a description.
export function checkAbove(beforeRaw, afterRaw) {
  const before = parseDescription(beforeRaw);
  const after = parseDescription(afterRaw);
  const differences = [];
  if (before.format === 'empty') {
    const left = after.format === 'adf' ? after.above.length : after.above ? 1 : 0;
    if (left) differences.push('the description was empty, and now has content above the Specification section');
    return differences;
  }
  if (before.format !== after.format) return [`the description changed format (${before.format} → ${after.format})`];
  if (before.format === 'markdown') {
    if (before.above !== after.above) differences.push('the text above the Specification section differs');
    return differences;
  }
  const a = before.above.map((node) => JSON.stringify(canonical(node)));
  const b = after.above.map((node) => JSON.stringify(canonical(node)));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const was = before.above[i] ? `"${plain(before.above[i]).slice(0, 80)}" (${before.above[i].type})` : 'nothing';
    const is = after.above[i] ? `"${plain(after.above[i]).slice(0, 80)}" (${after.above[i].type})` : 'nothing';
    differences.push(`block ${i + 1}: was ${was}, is ${is}`);
  }
  return differences;
}

export function readSpec(raw, { ticket, title }) {
  const parsed = parseDescription(raw);
  if (!parsed.section) return null;
  return specFromSection(parsed.format === 'adf' ? adfToMarkdown(parsed.section) : parsed.section, { ticket, title });
}

// ---------------------------------------------------------------------------------------------
// Sub-tasks: one per acceptance criterion, found again by the "AC<n>:" its summary starts with

export function planSubtasks(specText, existing = []) {
  const spec = parseSpec(specText);
  const byAc = new Map();
  for (const task of existing) {
    const id = task.summary?.match(/^\s*(AC\d+)\b/i)?.[1]?.toUpperCase();
    if (id && !byAc.has(id)) byAc.set(id, task);
  }
  const acs = spec.acs.filter((ac, i) => spec.acs.findIndex((x) => x.id === ac.id) === i);
  const short = (statement) => { const plainText = statement.replace(/[*_`~]/g, ''); return plainText.length > 110 ? `${plainText.slice(0, 107).trimEnd()}…` : plainText; };
  return {
    create: acs.filter((ac) => !ac.dropped && !byAc.has(ac.id)).map((ac) => ({ ac: ac.id, summary: `${ac.id}: ${short(ac.statement)}`, description: `${ac.statement}\n\nVerified by: ${ac.verifiedBy}` })),
    existing: acs.filter((ac) => !ac.dropped && byAc.has(ac.id)).map((ac) => ({ ac: ac.id, key: byAc.get(ac.id).key, status: byAc.get(ac.id).status ?? null })),
    dropped: acs.filter((ac) => ac.dropped && byAc.has(ac.id)).map((ac) => ({ ac: ac.id, key: byAc.get(ac.id).key, status: byAc.get(ac.id).status ?? null })),
  };
}

// ---------------------------------------------------------------------------------------------
// Jira Cloud over its REST API: only with JIRA_EMAIL and JIRA_API_TOKEN set. This is the exact way to write
// the section, because it sends Jira's own document back with the stakeholder's blocks untouched; a
// connector hands the description over as Markdown, which cannot carry images, mentions or smart links.

export function jiraTarget(ticket, env = process.env) {
  const url = String(ticket ?? '').match(/^https?:\/\/([^/]+)\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  const site = url?.[1] ?? env.JIRA_SITE?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const key = url?.[2] ?? ticket;
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key ?? '')) throw new Error(`not a ticket key or URL: ${ticket}`);
  if (!site) throw new Error('pass the ticket as its URL (https://<site>.atlassian.net/browse/KEY) or set JIRA_SITE');
  if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) throw new Error('JIRA_EMAIL and JIRA_API_TOKEN are not set; without them, use the tracker\'s connector (sync-ticket SKILL.md)');
  return { key, base: env.JIRA_BASE_URL ?? `https://${site}`, auth: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}` };
}

async function jira(target, method, path, body) {
  const response = await fetch(`${target.base}/rest/api/3${path}`, {
    method,
    headers: { Authorization: target.auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const textBody = await response.text();
  if (!response.ok) throw new Error(`Jira ${method} ${path} -> ${response.status}: ${textBody.slice(0, 300)}${response.status === 401 ? ' (check JIRA_EMAIL and JIRA_API_TOKEN)' : ''}`);
  return textBody ? JSON.parse(textBody) : null;
}

const issuePath = (target) => `/issue/${encodeURIComponent(target.key)}`;
const describe = (issue) => JSON.stringify(issue.fields.description ?? null);

export async function jiraRead(ticket, env = process.env) {
  const target = jiraTarget(ticket, env);
  const issue = await jira(target, 'GET', `${issuePath(target)}?fields=summary,description,status,issuetype,subtasks`);
  return {
    key: issue.key,
    title: issue.fields.summary,
    status: issue.fields.status?.name ?? null,
    type: issue.fields.issuetype?.name ?? null,
    subtasks: (issue.fields.subtasks ?? []).map((task) => ({ key: task.key, summary: task.fields?.summary ?? '', status: task.fields?.status?.name ?? null })),
    spec: readSpec(describe(issue), { ticket: issue.key, title: issue.fields.summary }),
  };
}

// Write the section, read the ticket back, and prove nothing above the section changed. On a difference
// the description is put back as it was.
export async function jiraWrite(ticket, specText, env = process.env) {
  const target = jiraTarget(ticket, env);
  const path = `${issuePath(target)}?fields=description`;
  const before = describe(await jira(target, 'GET', path));
  const merged = mergeSection(before, specText, { format: 'adf' });
  await jira(target, 'PUT', issuePath(target), { fields: { description: JSON.parse(merged.text) } });
  const differences = checkAbove(before, describe(await jira(target, 'GET', path)));
  if (differences.length) {
    await jira(target, 'PUT', issuePath(target), { fields: { description: JSON.parse(before) } });
    throw new Error(`the description changed above the Specification section, so it was put back as it was: ${differences.join('; ')}`);
  }
  return { key: target.key, written: true, replaced: merged.replaced };
}

// ---------------------------------------------------------------------------------------------

const read = (file) => readFileSync(file, 'utf8');

const COMMANDS = {
  render: (opts) => { need(opts, 'spec'); return renderSection(read(opts.spec)); },
  merge: (opts) => {
    need(opts, 'description', 'spec', 'out');
    const merged = mergeSection(read(opts.description), read(opts.spec), { format: typeof opts.format === 'string' ? opts.format : undefined });
    writeFileSync(opts.out, merged.text);
    return { out: opts.out, format: merged.format, replaced: merged.replaced, next: 'write this file to the ticket as its description, save what the tracker returns, and run check' };
  },
  check: (opts) => {
    need(opts, 'before', 'after');
    const differences = checkAbove(read(opts.before), read(opts.after));
    if (differences.length) {
      console.log(JSON.stringify({ unchanged: false, differences, next: 'write the "before" file back to the ticket as its description, then stop and tell the user' }, null, 2));
      console.error(`ticket: the description changed above the Specification section: ${differences.join('; ')}`);
      process.exit(1);
    }
    return { unchanged: true };
  },
  read: (opts) => {
    need(opts, 'description', 'ticket', 'title');
    const spec = readSpec(read(opts.description), { ticket: opts.ticket, title: opts.title });
    if (spec === null) return { spec: null, why: `the description has no "${HEADING}" section yet` };
    if (typeof opts.out === 'string') { writeFileSync(opts.out, spec); return { out: opts.out, status: parseSpec(spec).status, acs: parseSpec(spec).acs.length }; }
    return spec;
  },
  subtasks: (opts) => { need(opts, 'spec'); return planSubtasks(read(opts.spec), typeof opts.existing === 'string' ? JSON.parse(read(opts.existing)) : []); },
  // Which way this machine can write a ticket: `api` with the two variables set, else `connector`.
  transport: () => ({ jira: process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN ? 'api' : 'connector', improve: process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN ? null : 'Set JIRA_EMAIL and JIRA_API_TOKEN (an Atlassian API token) and the Specification section is written into any description exactly, images and mentions included.' }),
  'jira-read': async (opts) => {
    need(opts, 'ticket');
    const { spec, ...ticket } = await jiraRead(opts.ticket);
    if (spec && typeof opts.out === 'string') writeFileSync(opts.out, spec);
    return { ...ticket, spec: spec ? (typeof opts.out === 'string' ? opts.out : spec) : null };
  },
  'jira-write': async (opts) => { need(opts, 'ticket', 'spec'); return jiraWrite(opts.ticket, read(opts.spec)); },
};

function need(opts, ...names) {
  const missing = names.filter((name) => typeof opts[name] !== 'string');
  if (missing.length) throw new Error(`missing ${missing.map((name) => `--${name}`).join(', ')}`);
}

// Run as a command, also through a junction or symlink (personal skills): compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const command = COMMANDS[process.argv[2]];
  if (!command) {
    console.error(`usage: ticket.mjs ${Object.keys(COMMANDS).join(' | ')}  (see the header of this file)`);
    process.exit(2);
  }
  try {
    const out = await command(parseArgs(process.argv.slice(3)));
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(`ticket: ${error.message}`);
    process.exit(1);
  }
}
