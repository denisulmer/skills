#!/usr/bin/env node
// Metrics for babysit-pr runs: one record per review round and one per PR, kept in a local ledger
// (<config>/pr-metrics/<repo>.jsonl) and as a hidden marker on the PR, plus a report across PRs.
//
//   node measure.mjs round  --repo <checkout> --pr <id> --pr-url <url> --round <n> --tier <t> --scope full|delta
//                           --started <iso> --scratch <dir> [--ended <iso>] [--session <id>]
//   node measure.mjs pr     --repo <checkout> --pr <id> --pr-url <url> --tier <t> --score <n> --outcome <o>
//                           --started <iso> --scratch <dir> [--ended <iso>] [--session <id>]
//   node measure.mjs tokens --scratch <dir> --started <iso> [--ended <iso>] [--session <id>]
//   node measure.mjs import --repo <checkout> --pr <id|url>
//   node measure.mjs report [--repo <checkout> | --all] [--since YYYY-MM-DD] [--json]
//
// `round` reads <scratch>/round-<n>-result.json (the review workflow's result) and every
// <scratch>/round-<n>-fixer*.json (the fixer's JSON block). Tokens come from the Claude Code session
// transcripts (<config>/projects/*/<session>.jsonl and its subagents), counted inside the time window.
// The transcript format is not documented: when it cannot be read, tokens are recorded as unknown.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const LEDGER_DIR = join(CONFIG_DIR, 'pr-metrics');
const PR_HOST = join(HERE, '..', '..', 'pr-host', 'scripts', 'pr-host.mjs');
const SEVERITIES = ['nit', 'minor', 'major', 'blocker'];
const LENSES = ['generalist', 'correctness', 'standards-spec', 'blast-radius', 'tests', 'adversary', 'data-migration', 'security'];
const MARKER = /<!-- pr-metrics (\{.*?\}) -->/g;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { opts._.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[name] = true;
    else { opts[name] = next; i++; }
  }
  return opts;
}

function need(opts, ...names) {
  const missing = names.filter((n) => opts[n] === undefined || opts[n] === true);
  if (missing.length) throw new Error(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = (file) => { try { return readJson(file); } catch { return null; } };

function pluginVersion() {
  const manifest = tryJson(join(HERE, '..', '..', '..', '.claude-plugin', 'marketplace.json'));
  return manifest?.plugins?.find((p) => p.name === 'denisulmer-skills')?.version ?? null;
}

// ---------------------------------------------------------------------------------------------
// Ledger

function git(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// One ledger per repository, named after its origin (host and path, without user name or .git), or after
// the main checkout's folder when it has no remote.
export function repoSlug(repo) {
  const url = git(repo, ['remote', 'get-url', 'origin']);
  if (url) {
    const cleaned = url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '').replace(/:(?!\d)/, '/');
    return cleaned.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return basename(common ? dirname(common) : repo).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const ledgerFile = (slug) => join(LEDGER_DIR, `${slug}.jsonl`);
const recordKey = (r) => `${r.kind}|${r.prUrl ?? r.pr}|${r.round ?? ''}`;

function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// A record replaces an earlier one with the same key, so rerunning a step after a crash does not count twice.
function upsert(file, records) {
  const keys = new Set(records.map(recordKey));
  const kept = readLedger(file).filter((r) => !keys.has(recordKey(r)));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...kept, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// HTML comments end at "--", which can only occur inside JSON strings, where - reads back the same.
export const toMarker = (record) => `<!-- pr-metrics ${JSON.stringify(record).replace(/--/g, '-\\u002d')} -->`;

export function fromText(text) {
  return [...(text ?? '').matchAll(MARKER)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Tokens from session transcripts

function sessionId(opts) {
  if (opts.session && opts.session !== true) return opts.session;
  const match = String(opts.scratch ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] ?? null;
}

function findTranscript(id) {
  for (const root of new Set([CONFIG_DIR, join(homedir(), '.claude')])) {
    const projects = join(root, 'projects');
    if (!existsSync(projects)) continue;
    for (const project of readdirSync(projects)) {
      const file = join(projects, project, `${id}.jsonl`);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function jsonlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsonlFiles(join(dir, e.name)) : e.name.endsWith('.jsonl') && e.name.startsWith('agent-') ? [join(dir, e.name)] : []);
}

// What kind of agent wrote a transcript: the main conversation, a review-workflow agent by its label
// (review:<lens>, skeptic:…, comment:…, map), or another subagent such as the fixer.
function groupOf(file, mainFile) {
  if (file === mainFile) return 'main';
  const meta = tryJson(file.replace(/\.jsonl$/, '.meta.json')) ?? {};
  const label = String(meta.description ?? '');
  if (meta.agentType === 'workflow-subagent' || /[\\/]workflows[\\/]/.test(file)) {
    const head = label.split(':')[0];
    return ['review', 'skeptic', 'comment', 'map'].includes(head) ? head : 'workflow';
  }
  return /fix|decision/i.test(label) ? 'fixer' : 'subagent';
}

// Weighted = input-token equivalents at Claude's price ratios: cache writes 1.25x, cache reads 0.1x,
// output 5x. It compares runs; it is not a bill (models differ in price).
const weigh = (u) => Math.round(u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead + 5 * u.output);

export function countTokens({ scratch, session, started, ended }) {
  const id = sessionId({ scratch, session });
  const mainFile = id ? findTranscript(id) : null;
  if (!mainFile) return { source: 'unknown', reason: id ? `no transcript for session ${id}` : 'no session id in --scratch or --session' };
  const from = Date.parse(started);
  const to = ended ? Date.parse(ended) : Date.now();
  const groups = {};
  const models = {};
  const files = [mainFile, ...jsonlFiles(join(mainFile.replace(/\.jsonl$/, ''), 'subagents'))];
  for (const file of files) {
    const group = groupOf(file, mainFile);
    const seen = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.message;
      if (entry.type !== 'assistant' || !message?.usage) continue;
      const at = Date.parse(entry.timestamp);
      if (!(at >= from && at <= to)) continue;
      seen.set(message.id ?? entry.uuid, { usage: message.usage, model: message.model ?? 'unknown' });
    }
    if (!seen.size) continue;
    const g = (groups[group] ??= { agents: 0, turns: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    g.agents += file === mainFile ? 0 : 1;
    for (const { usage, model } of seen.values()) {
      const u = { input: usage.input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
      g.turns++;
      for (const k of Object.keys(u)) g[k] += u[k];
      if (model === '<synthetic>') continue;
      const m = (models[model] ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
      for (const k of Object.keys(u)) m[k] += u[k];
    }
  }
  for (const g of Object.values(groups)) g.weighted = weigh(g);
  for (const m of Object.values(models)) m.weighted = weigh(m);
  const weighted = Object.values(groups).reduce((sum, g) => sum + g.weighted, 0);
  return { source: 'transcript', session: id, weighted, groups, models };
}

// ---------------------------------------------------------------------------------------------
// Records

const lensOf = (label) => (/^comment/.test(label) ? 'comment' : LENSES.filter((l) => label === l || label.startsWith(`${l}-`)).sort((a, b) => b.length - a.length)[0] ?? label);

export function roundRecord(base, result, fixers) {
  const found = Object.fromEntries(SEVERITIES.slice(1).map((s) => [s, 0]));
  const lenses = {};
  const bump = (label, field) => { const l = (lenses[lensOf(label)] ??= { kept: 0, refuted: 0 }); l[field]++; };
  for (const f of result.findings ?? []) {
    found[f.severity] = (found[f.severity] ?? 0) + 1;
    for (const label of new Set((f.lenses ?? []).map(lensOf))) bump(label, 'kept');
  }
  for (const d of result.dropped ?? []) for (const label of new Set((d.lenses ?? []).map(lensOf))) bump(label, 'refuted');
  const human = {};
  for (const h of result.human ?? []) human[h.verdict] = (human[h.verdict] ?? 0) + 1;
  const outcomes = { fixed: 0, declined: 0, escalate: 0 };
  for (const fixer of fixers) for (const r of fixer?.results ?? []) outcomes[r.decision] = (outcomes[r.decision] ?? 0) + 1;
  return {
    ...base,
    kind: 'round',
    scope: result.scope ?? base.scope,
    valid: result.valid !== false,
    clean: result.clean ?? null,
    agents: result.coverage?.agents ?? result.coverage?.reviewers?.length ?? null,
    reviewers: result.coverage?.reviewers?.length ?? null,
    found,
    refuted: (result.dropped ?? []).length,
    nits: (result.nits ?? []).length,
    human,
    lenses,
    fixed: outcomes.fixed,
    declined: outcomes.declined,
    escalated: outcomes.escalate,
    failed: result.valid === false ? (result.failed ?? []).length : 0,
  };
}

function baseRecord(opts, kind) {
  const ended = opts.ended && opts.ended !== true ? opts.ended : new Date().toISOString();
  return {
    v: 1,
    kind,
    repo: repoSlug(opts.repo),
    pr: String(opts.pr),
    prUrl: opts['pr-url'] ?? null,
    tier: opts.tier ?? null,
    started: opts.started,
    ended,
    minutes: Math.round((Date.parse(ended) - Date.parse(opts.started)) / 60000),
    version: pluginVersion(),
  };
}

const compactTokens = (t) => (t.source === 'transcript'
  ? { source: t.source, weighted: t.weighted, byGroup: Object.fromEntries(Object.entries(t.groups).map(([k, g]) => [k, g.weighted])) }
  : { source: 'unknown', reason: t.reason });

function cmdRound(opts) {
  need(opts, 'repo', 'pr', 'round', 'tier', 'started', 'scratch');
  const n = Number(opts.round);
  const resultFile = join(opts.scratch, `round-${n}-result.json`);
  const result = tryJson(resultFile);
  if (!result) throw new Error(`cannot read ${resultFile}: save the workflow result there first`);
  const fixers = existsSync(opts.scratch)
    ? readdirSync(opts.scratch).filter((f) => new RegExp(`^round-${n}-fixer.*\\.json$`).test(f)).map((f) => tryJson(join(opts.scratch, f)))
    : [];
  const base = { ...baseRecord(opts, 'round'), round: n, scope: opts.scope ?? null };
  const tokens = countTokens({ scratch: opts.scratch, session: opts.session, started: base.started, ended: base.ended });
  const record = { ...roundRecord(base, result, fixers), tokens: compactTokens(tokens) };
  upsert(ledgerFile(record.repo), [record]);
  return { record, marker: toMarker(record), ledger: ledgerFile(record.repo) };
}

function cmdPr(opts) {
  need(opts, 'repo', 'pr', 'outcome', 'started');
  const base = baseRecord(opts, 'pr');
  const rounds = readLedger(ledgerFile(base.repo)).filter((r) => r.kind === 'round' && (r.prUrl ?? r.pr) === (base.prUrl ?? base.pr));
  const tokens = countTokens({ scratch: opts.scratch, session: opts.session, started: base.started, ended: base.ended });
  const sum = (field) => rounds.reduce((s, r) => s + (r[field] ?? 0), 0);
  const record = {
    ...base,
    score: opts.score !== undefined ? Number(opts.score) : null,
    outcome: opts.outcome,
    rounds: rounds.filter((r) => r.valid).length,
    invalidRounds: rounds.filter((r) => !r.valid).length,
    found: Object.fromEntries(SEVERITIES.slice(1).map((s) => [s, rounds.reduce((t, r) => t + (r.found?.[s] ?? 0), 0)])),
    fixed: sum('fixed'),
    declined: sum('declined'),
    decisions: sum('escalated'),
    tokens: compactTokens(tokens),
    roundTokens: rounds.every((r) => r.tokens?.source === 'transcript') ? rounds.reduce((s, r) => s + r.tokens.weighted, 0) : null,
  };
  upsert(ledgerFile(record.repo), [record]);
  return { record, marker: toMarker(record), ledger: ledgerFile(record.repo) };
}

function cmdImport(opts) {
  need(opts, 'repo', 'pr');
  const out = execFileSync(process.execPath, [PR_HOST, 'threads', String(opts.pr)], { cwd: opts.repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const records = JSON.parse(out).flatMap((t) => t.comments.flatMap((c) => fromText(c.content)));
  const byFile = {};
  for (const r of records) (byFile[ledgerFile(r.repo)] ??= []).push(r);
  for (const [file, list] of Object.entries(byFile)) upsert(file, list);
  return { imported: records.length, ledgers: Object.keys(byFile) };
}

// ---------------------------------------------------------------------------------------------
// Report

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const M = (x) => (x == null ? '–' : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');

export function aggregate(records, { since } = {}) {
  const from = since ? Date.parse(since) : 0;
  const recs = records.filter((r) => Date.parse(r.started) >= from);
  const rounds = recs.filter((r) => r.kind === 'round');
  const prs = recs.filter((r) => r.kind === 'pr');
  const tiers = {};
  for (const r of rounds) {
    const t = (tiers[r.tier] ??= { prs: new Set(), finished: 0, rounds: 0, invalid: 0, minutes: [], tokens: [], prTokens: [], byIndex: {}, byScope: {}, lenses: {}, kept: 0, refuted: 0, fixed: 0, declined: 0, escalated: 0 });
    t.prs.add(r.prUrl ?? r.pr);
    if (!r.valid) { t.invalid++; continue; }
    t.rounds++;
    t.minutes.push(r.minutes);
    if (r.tokens?.source === 'transcript') t.tokens.push(r.tokens.weighted);
    const idx = (t.byIndex[r.round] ??= { n: 0, notClean: 0, tokens: [] });
    idx.n++; if (r.clean === false) idx.notClean++; if (r.tokens?.weighted) idx.tokens.push(r.tokens.weighted);
    const sc = (t.byScope[r.scope ?? 'full'] ??= { n: 0, tokens: [], minutes: [] });
    sc.n++; sc.minutes.push(r.minutes); if (r.tokens?.weighted) sc.tokens.push(r.tokens.weighted);
    for (const [lens, l] of Object.entries(r.lenses ?? {})) {
      const x = (t.lenses[lens] ??= { runs: 0, kept: 0, refuted: 0 });
      x.runs++; x.kept += l.kept; x.refuted += l.refuted;
    }
    t.kept += Object.values(r.found ?? {}).reduce((a, b) => a + b, 0);
    t.refuted += r.refuted ?? 0;
    t.fixed += r.fixed ?? 0; t.declined += r.declined ?? 0; t.escalated += r.escalated ?? 0;
  }
  for (const p of prs) {
    const t = tiers[p.tier];
    if (!t) continue;
    t.finished++;
    if (p.tokens?.source === 'transcript') t.prTokens.push(p.tokens.weighted);
  }
  // Facts a tuning proposal can rest on. Thresholds are deliberately conservative: a signal needs data.
  const signals = [];
  for (const [tier, t] of Object.entries(tiers)) {
    if (t.invalid) signals.push({ tier, kind: 'invalid-rounds', text: `${t.invalid} round(s) stopped because agents returned nothing (usage limits or errors)` });
    for (const [i, x] of Object.entries(t.byIndex)) {
      if (Number(i) >= 2 && x.n >= 5 && x.notClean === 0) signals.push({ tier, kind: 'quiet-round', round: Number(i), text: `round ${i} found nothing at or above the bar in ${x.n} of ${x.n} PRs` });
    }
    for (const [lens, l] of Object.entries(t.lenses)) {
      if (lens === 'comment') continue;
      if (l.runs >= 5 && l.kept / l.runs < 0.2) signals.push({ tier, kind: 'low-yield-lens', lens, text: `${lens} kept ${l.kept} finding(s) in ${l.runs} rounds` });
      if (l.kept + l.refuted >= 10 && l.refuted / (l.kept + l.refuted) > 0.5) signals.push({ tier, kind: 'noisy-lens', lens, text: `skeptics refuted ${pct(l.refuted, l.kept + l.refuted)} of ${lens}'s findings` });
    }
    const judged = t.kept + t.refuted;
    if (judged >= 20 && t.refuted / judged < 0.1) signals.push({ tier, kind: 'idle-skeptics', text: `skeptics refuted only ${pct(t.refuted, judged)} of ${judged} findings` });
    if (t.fixed + t.declined >= 10 && t.declined / (t.fixed + t.declined) > 0.4) signals.push({ tier, kind: 'declined-often', text: `the fixer declined ${pct(t.declined, t.fixed + t.declined)} of the findings it handled` });
  }
  return { rounds: rounds.length, prs: prs.length, tiers, signals };
}

function renderReport(agg, scopeLabel) {
  const lines = [`# PR review metrics · ${scopeLabel}`, '', `${agg.prs} PRs finished, ${agg.rounds} rounds recorded. Tokens are weighted input-token equivalents.`, ''];
  if (!agg.rounds) return [...lines, 'No rounds recorded yet. babysit-pr records one per round from version 4.0.0 on; `import` reads markers from older PRs.'].join('\n');
  lines.push('## Per tier', '', '| Tier | PRs | Rounds | Median min/round | Median tokens/round | Median tokens/PR | Kept | Refuted | Fixed | Declined | Decisions |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [tier, t] of Object.entries(agg.tiers)) {
    lines.push(`| ${tier} | ${t.prs.size} | ${t.rounds}${t.invalid ? ` (+${t.invalid} failed)` : ''} | ${median(t.minutes) ?? '–'} | ${M(median(t.tokens))} | ${M(median(t.prTokens))} | ${t.kept} | ${t.refuted} | ${t.fixed} | ${t.declined} | ${t.escalated} |`);
  }
  for (const [tier, t] of Object.entries(agg.tiers)) {
    lines.push('', `## ${tier}`, '', '| Round | Rounds | Not clean | Median tokens |', '|---|---|---|---|');
    for (const [i, x] of Object.entries(t.byIndex).sort((a, b) => a[0] - b[0])) lines.push(`| ${i} | ${x.n} | ${pct(x.notClean, x.n)} | ${M(median(x.tokens))} |`);
    lines.push('', '| Scope | Rounds | Median min | Median tokens |', '|---|---|---|---|');
    for (const [s, x] of Object.entries(t.byScope)) lines.push(`| ${s} | ${x.n} | ${median(x.minutes) ?? '–'} | ${M(median(x.tokens))} |`);
    lines.push('', '| Lens | Rounds | Kept | Refuted | Kept per round |', '|---|---|---|---|---|');
    for (const [lens, l] of Object.entries(t.lenses).sort((a, b) => b[1].kept - a[1].kept)) lines.push(`| ${lens} | ${l.runs} | ${l.kept} | ${l.refuted} | ${(l.kept / l.runs).toFixed(2)} |`);
  }
  lines.push('', '## Signals', '');
  if (!agg.signals.length) lines.push('None yet: each signal needs at least 5 rounds or 10 to 20 findings behind it.');
  for (const s of agg.signals) lines.push(`- **${s.tier}** · ${s.kind}: ${s.text}`);
  return lines.join('\n');
}

function cmdReport(opts) {
  let files;
  if (opts.all) files = existsSync(LEDGER_DIR) ? readdirSync(LEDGER_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => join(LEDGER_DIR, f)) : [];
  else { need(opts, 'repo'); files = [ledgerFile(repoSlug(opts.repo))]; }
  const records = files.flatMap(readLedger);
  const agg = aggregate(records, { since: opts.since });
  const label = opts.all ? 'all repositories' : basename(files[0], '.jsonl');
  if (opts.json) return { ...agg, tiers: Object.fromEntries(Object.entries(agg.tiers).map(([k, t]) => [k, { ...t, prs: t.prs.size }])) };
  return renderReport(agg, `${label}${opts.since ? ` since ${opts.since}` : ''}`);
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = {
  round: cmdRound,
  pr: cmdPr,
  import: cmdImport,
  report: cmdReport,
  tokens: (opts) => { need(opts, 'started'); return countTokens(opts); },
};

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const opts = parseArgs(process.argv.slice(2));
  const command = COMMANDS[opts._[0]];
  if (!command) {
    console.error('usage: measure.mjs round | pr | tokens | import | report  (see the header of this file)');
    process.exit(2);
  }
  try {
    const out = command(opts);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(`measure: ${error.message}`);
    process.exit(1);
  }
}
