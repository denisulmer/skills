#!/usr/bin/env node
// The bookkeeping of a babysit-pr run, so every step that needs no judgment comes out the same each time:
// where the PR stands and what comes next, the review round's inputs and scope, and everything posted from a
// round's results. The PR stays the state: everything posted carries a pr-host key and a hidden
// `<!-- babysit {...} -->` marker this script reads back.
//
// What it posts is kept small on purpose. One thread, the triage, is the review's log: each round adds its
// findings, its outcomes and its summary there as replies. A finding gets a thread of its own only when it
// needs a person: a decision, or a decline they may disagree with. A fix with proof is one line in the log.
//
//   node babysit.mjs state   --pr <pr> [--repo <path>]
//   node babysit.mjs triage  --pr <pr> --risk <score.json> --intent-file <f> --scratch <dir> [--repo <path>]
//   node babysit.mjs args    --pr <pr> --repo <worktree> --target <ref> --scratch <dir> [--tier <t> --tier-reason <r>]
//                            [--mode owner|review] [--started <iso>] [--intent-file <f>]
//                            [--spec-file <f>]   the spec read out of a ticket; without it, a spec file on the branch
//   node babysit.mjs record  --pr <pr> --round <n> --scratch <dir> [--repo <path>] [--build-failures <file>]
//   node babysit.mjs reply   --pr <pr> --round <n> --scratch <dir> --repo <worktree> --fixer <file> --checks <file>
//                            [--choices <file>] [--escalate-unproven]
//   node babysit.mjs summary --pr <pr> --round <n> --scratch <dir> --repo <worktree> [--print]
//
// Files in <scratch>: round-<n>-args.json (written by args), round-<n>-result.json (the workflow result),
// round-<n>-threads.json (written by record), round-<n>-fixer*.json (the fixer's JSON blocks).
// PR_HOST_DRY_RUN passes through to pr-host, so a rehearsal posts nothing.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(HERE, '..', '..');
const PR_HOST = join(SKILLS, 'pr-host', 'scripts', 'pr-host.mjs');
const SIGNALS = join(SKILLS, 'score-pr', 'scripts', 'signals.mjs');
const MEASURE = join(SKILLS, 'measure-prs', 'scripts', 'measure.mjs');
const ACMAP = join(SKILLS, 'build-feature', 'scripts', 'acmap.mjs');
const TIERS = JSON.parse(readFileSync(join(HERE, '..', 'references', 'tiers.json'), 'utf8'));

const SEVERITIES = ['nit', 'minor', 'major', 'blocker'];
const ICON = { blocker: '🔴', major: '🟠', minor: '🟡', nit: '⚪' };
const rank = (s) => SEVERITIES.indexOf(s);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const STATE = /<!-- babysit (\{.*?\}) -->/;
const FINDING_KEY = /^pr-babysit:(R(\d+)-([FB])(\d+))$/;
// The triage thread is the review's log: every later entry of the review is a reply on it.
const LOG_KEY = 'pr-babysit:triage';
const DECLINE = {
  'false-positive': { status: 'closed', words: 'false positive' },
  'by-design': { status: 'byDesign', words: 'by design' },
  'out-of-scope': { status: 'wontFix', words: 'out of scope' },
};

// ---------------------------------------------------------------------------------------------
// Plumbing

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { opts._.push(argv[i]); continue; }
    const next = argv[i + 1];
    opts[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
  return opts;
}

function need(opts, ...names) {
  const missing = names.filter((n) => typeof opts[n] !== 'string');
  if (missing.length) throw new Error(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = (file) => { try { return readJson(file); } catch { return null; } };

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

function host(opts, args) {
  const out = execFileSync(process.execPath, [PR_HOST, ...args], { cwd: opts.repo ?? process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function bodyFile(scratch, key, body) {
  const dir = join(scratch, 'bodies');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key.replace(/[^\w.-]+/g, '_')}.md`);
  writeFileSync(file, body);
  return file;
}

const stateMarker = (data) => `<!-- babysit ${JSON.stringify(data).replace(/--/g, '-\\u002d')} -->`;
const readState = (content) => { const m = (content ?? '').match(STATE); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
const firstLine = (content) => (content ?? '').replace(/<!--[\s\S]*?-->/g, '').trim().split('\n')[0].replace(/^🤖\s*/, '').replace(/\*\*/g, '').trim();
const short = (sha) => (sha ? sha.slice(0, 7) : '');

function commitLink(show, sha) {
  if (!sha) return '';
  return show.repoWebUrl ? `[\`${short(sha)}\`](${show.repoWebUrl}/commit/${sha})` : `\`${short(sha)}\``;
}

function trimLines(text, max = 10) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').trim().split('\n');
  return lines.length > max ? [...lines.slice(0, max - 1), '…'].join('\n') : lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// State: read the PR back

export function readPr(opts) {
  const show = host(opts, ['show', String(opts.pr)]);
  const threads = host(opts, ['threads', String(opts.pr)]);
  return { show, threads };
}

// What the review left on the PR. The triage thread is the review's log: each round adds its findings, its
// outcomes and its summary there as replies, each with a marker. A finding has a thread of its own only when
// it needs a person (a decision, or a decline they may disagree with); in review-only mode, and on PRs
// reviewed before 4.6, every finding has one. A thread's status wins over a marker: a person may have
// reopened it.
export function analyse(show, threads) {
  const byKey = new Map(threads.filter((t) => t.key).map((t) => [t.key, t]));
  const log = byKey.get(LOG_KEY) ?? null;
  const triage = log
    ? readState(log.comments[0]?.content) ?? { tier: log.comments[0]?.content.match(/·\s*(trivial|low|medium|high|critical) review/)?.[1] ?? null }
    : null;
  if (triage && log) triage.published = log.comments[0]?.published ?? null;

  // Every comment the review keyed, with its thread, in the order it was posted.
  const keyed = (pattern) => threads.flatMap((t) => t.comments.map((c) => ({ c, t, m: c.key?.match(pattern) ?? null })).filter((x) => x.m));

  const findings = new Map();
  const recorded = new Set();
  for (const { c, m } of keyed(/^pr-babysit:R(\d+)-findings$/)) {
    recorded.add(Number(m[1]));
    for (const f of readState(c.content)?.findings ?? []) {
      findings.set(f.id, { id: f.id, round: Number(m[1]), kind: 'finding', threadId: null, url: null, status: 'active', severity: f.severity, title: f.title, file: f.file ?? null, line: f.line ?? null, lastReply: null, replyKeys: [], detail: f });
    }
  }
  for (const { c } of keyed(/^pr-babysit:R\d+-outcomes-\w+$/)) {
    for (const [id, outcome] of Object.entries(readState(c.content)?.outcomes ?? {})) {
      const f = findings.get(id);
      if (f) Object.assign(f, { status: outcome.status, lastReply: outcome.text ?? null, outcome });
    }
  }
  for (const t of threads) {
    const m = t.key?.match(FINDING_KEY);
    if (!m) continue;
    const known = findings.get(m[1]);
    const st = readState(t.comments[0]?.content) ?? {};
    const legacy = t.comments[0]?.content.match(/\*\*(Blocker|Major|Minor|Nit) · R\d+-[FB]\d+:\*\*\s*(.+)/);
    const replies = t.comments.slice(1).filter((c) => c.isMine);
    findings.set(m[1], {
      ...known,
      id: m[1],
      round: Number(m[2]),
      kind: m[3] === 'B' ? 'build' : 'finding',
      threadId: t.id,
      url: t.url,
      status: t.status,
      severity: known?.severity ?? st.severity ?? legacy?.[1]?.toLowerCase() ?? (m[3] === 'B' ? 'major' : 'minor'),
      title: known?.title ?? st.title ?? legacy?.[2]?.trim() ?? firstLine(t.comments[0]?.content),
      file: t.file ?? st.file ?? known?.file ?? null,
      line: t.line ?? st.line ?? known?.line ?? null,
      lastReply: replies.length ? firstLine(replies.at(-1).content) : known?.lastReply ?? null,
      replyKeys: t.comments.map((c) => c.key).filter(Boolean),
    });
  }
  // A person's confirmed comment became a finding: our reply on their thread (key R<n>-reply-<thread>)
  // carries the finding's marker, and the thread is theirs.
  for (const t of threads) {
    const confirm = t.comments.find((c) => /^pr-babysit:R\d+-reply-\d+$/.test(c.key ?? '') && readState(c.content)?.id);
    if (!confirm) continue;
    const st = readState(confirm.content);
    const known = findings.get(st.id);
    const replies = t.comments.filter((c) => c.isMine && c !== confirm && c.key);
    findings.set(st.id, {
      ...known,
      id: st.id,
      round: Number(st.id.match(/^R(\d+)-/)?.[1] ?? 0),
      kind: 'finding',
      human: true,
      threadId: t.id,
      url: t.url,
      status: t.status,
      severity: st.severity ?? known?.severity ?? 'minor',
      title: st.title ?? known?.title ?? firstLine(t.comments[0]?.content),
      file: t.file ?? st.file ?? known?.file ?? null,
      line: t.line ?? st.line ?? known?.line ?? null,
      lastReply: replies.length ? firstLine(replies.at(-1).content) : known?.lastReply ?? null,
      replyKeys: t.comments.map((c) => c.key).filter(Boolean),
    });
  }

  const summaries = keyed(/^pr-babysit:R(\d+)-summary$/).map(({ c, t, m }) => {
    const st = readState(c.content) ?? {};
    return {
      round: Number(m[1]),
      url: t.url,
      tier: st.tier ?? c.content.match(/·\s*(trivial|low|medium|high|critical) review/)?.[1] ?? null,
      scope: st.scope ?? null,
      clean: st.clean ?? /✅ clean/.test(c.content),
      reviewed: st.reviewed ?? c.content.match(/(?:up to|Reviewed) `([0-9a-f]{7,40})`/)?.[1] ?? null,
    };
  }).sort((a, b) => a.round - b.round);
  const tier = summaries.at(-1)?.tier ?? triage?.tier ?? null;
  const report = keyed(/^pr-babysit:report$/)[0] ?? null;
  // Waiting for an answer: a person's open thread whose last word is not ours, and any thread of the review
  // that someone wrote on after it (a disagreement with a decline, a question on a decision).
  const human = threads.filter((t) => {
    const last = t.comments.at(-1);
    if (!last || t.kind === 'system') return false;
    if (t.kind === 'human') return ['active', 'pending'].includes(t.status) && !last.isMine;
    return !last.key && last.type !== 'system';
  });
  const order = (a, b) => a.round - b.round || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, undefined, { numeric: true });
  return {
    triage,
    log: log ? { id: log.id, url: log.url } : null,
    findings: [...findings.values()].sort(order),
    recorded: [...recorded],
    summaries,
    tier,
    report: report ? { url: report.t.url } : null,
    human,
    mode: show.isMine ? 'owner' : 'review',
  };
}

// The stop rule from SKILL.md §2.8, given the closed rounds.
export function nextStep(a) {
  if (!a.triage) return { action: 'triage', why: 'no triage thread yet' };
  const t = TIERS.tiers[a.tier];
  const closed = new Set(a.summaries.map((s) => s.round));
  const builds = a.findings.filter((f) => f.kind === 'build' && !closed.has(f.round));
  const redBuilds = builds.filter((f) => f.status === 'active');
  if (redBuilds.length) return { action: 'fix-build', round: builds[0].round, why: `the PR build is red (${redBuilds.map((f) => f.id).join(', ')}); fix it before the review` };
  if (builds.some((f) => f.status === 'pending')) return { action: 'await-decisions', round: builds[0].round, why: 'a build fix waits for the user' };
  // A round is open from the moment its findings are on the log (even when it found none) until its summary is.
  const openRound = [...new Set([...(a.recorded ?? []), ...a.findings.filter((f) => f.kind !== 'build').map((f) => f.round)])].filter((r) => !closed.has(r)).sort((x, y) => x - y)[0];
  if (openRound !== undefined) {
    const open = a.findings.filter((f) => f.round === openRound);
    if (open.some((f) => f.status === 'active')) return { action: a.mode === 'owner' ? 'fix' : 'close', round: openRound, why: `${open.filter((f) => f.status === 'active').length} finding(s) of round ${openRound} not handled yet` };
    if (open.some((f) => f.status === 'pending')) return { action: 'await-decisions', round: openRound, why: `${open.filter((f) => f.status === 'pending').length} decision(s) waiting for the user` };
    return { action: 'close', round: openRound, why: `every finding of round ${openRound} is handled; post its summary` };
  }
  const last = a.summaries.at(-1);
  if (!last) return { action: 'round', round: 1, why: 'triage done, no round yet' };
  const done = a.report ? 'merge-gate' : 'report';
  if (last.clean) return { action: done, why: `round ${last.round} was clean` };
  // An unclean round whose findings were all declined or decided without a change leaves nothing to
  // verify. Only when every head we know (the host's, the checkout's) is still the reviewed commit.
  const unchanged = Boolean(last.reviewed) && a.heads?.length > 0 && a.heads.every((h) => sameSha(h, last.reviewed));
  if (unchanged && !a.human.length) return { action: done, why: `round ${last.round} was not clean, but nothing changed since: its findings were declined or decided without a change` };
  if (last.round >= t.maxRounds) return { action: 'round-limit', round: last.round, why: `${t.maxRounds} rounds without a clean one` };
  return { action: 'round', round: last.round + 1, why: `round ${last.round} was not clean; the next round verifies its fixes` };
}

const sameSha = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

// The PR head as the host reports it and as the checkout has it. A host can lag behind a push, so
// "nothing changed" needs both to agree.
function headsOf(show, opts) {
  return [show.sourceCommit, tryGit(opts.repo ?? process.cwd(), ['rev-parse', 'HEAD'])].filter(Boolean);
}

// What the review has cost so far, from the metrics ledger; null when nothing is recorded yet.
function costOf(opts, show) {
  try {
    return JSON.parse(execFileSync(process.execPath, [MEASURE, 'cost', '--repo', opts.repo ?? process.cwd(), '--pr', String(show.id), '--pr-url', show.webUrl ?? String(show.id)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

function cmdState(opts) {
  need(opts, 'pr');
  const { show, threads } = readPr(opts);
  const a = { ...analyse(show, threads), heads: headsOf(show, opts) };
  return {
    pr: { id: show.id, title: show.title, status: show.status, isDraft: show.isDraft, webUrl: show.webUrl, head: show.sourceCommit },
    mode: a.mode,
    tier: a.tier,
    triage: a.triage,
    rounds: a.summaries,
    log: a.log,
    findings: a.findings.map(({ replyKeys, detail, outcome, ...f }) => f),
    humanWaiting: a.human.map((t) => ({ threadId: t.id, author: t.comments[0].author, file: t.file, line: t.line, url: t.url })),
    report: a.report,
    cost: costOf(opts, show),
    next: nextStep(a),
  };
}

// ---------------------------------------------------------------------------------------------
// Triage

function lensText(lenses) {
  return lenses.map((l) => l.replace('standards-spec', 'standards and intent').replace(/-/g, ' ')).join(', ');
}

export function sumText(risk) {
  const adjust = risk.adjust ? ` ${risk.adjust > 0 ? '+' : '−'} ${Math.abs(risk.adjust)} adjustment` : '';
  const parts = `blast radius ${risk.radiusPoints} (${risk.radiusWord ?? risk.radius}) + door ${risk.doorPoints} (${risk.doorWord})${adjust}`;
  const raw = risk.radiusPoints + risk.doorPoints + (risk.adjust ?? 0);
  if (risk.score > raw) return `${parts} = ${raw}, raised to the floor of ${risk.floor}`;
  if (risk.score < raw) return `${parts} = ${raw}, held at the cap of ${risk.cap}`;
  return `${parts}${risk.floor > 0 && raw > risk.floor ? `, above the floor of ${risk.floor}` : ''}`;
}

export function triageBody(risk, tierName) {
  const t = TIERS.tiers[tierName];
  const doorTitle = risk.doorWord?.startsWith('one-way') ? 'one-way' : 'two-way';
  const bullets = [
    `- **Door, ${doorTitle}:** ${risk.doorWhy}`,
    `- **Blast radius, ${risk.radiusWord ?? risk.radius}:** ${risk.radiusWhy}`,
    ...(risk.floor > 0 && risk.boundReasons?.length ? [`- **Floor ${risk.floor}:** ${risk.boundReasons[0]}`] : []),
    `- **Safe because:** ${risk.safeBecause}${risk.safeBecauseProven ? '' : ' ⚠️ Unproven: round 1 checks this first.'}`,
  ];
  const first = [...t.portionLenses.map((l) => `${l} per part`), ...t.wholeLenses.filter((l) => !t.portionLenses.includes(l))];
  const skeptics = t.skeptics ? ' · a skeptic checks every finding before it is posted' : '';
  const later = t.maxRounds > 1 ? ` · if it keeps a ${t.severityBar} finding, follow-up rounds check only the fixes, up to ${t.maxRounds} rounds in all` : '';
  return [
    `🤖 **Risk ${risk.score}/100 · ${tierName} review**`,
    '',
    `**${risk.score}** = ${sumText(risk)}`,
    '',
    ...bullets,
    '',
    `**Plan:** round 1 reviews the whole change (${lensText(first)})${later}${skeptics}`,
  ].join('\n');
}

function cmdTriage(opts) {
  need(opts, 'pr', 'risk', 'intent-file', 'scratch');
  const risk = readJson(opts.risk);
  if (!TIERS.tiers[risk.tier]) throw new Error(`unknown tier ${risk.tier} in ${opts.risk}`);
  const intent = readFileSync(opts['intent-file'], 'utf8').trim();
  const state = { v: 1, tier: risk.tier, score: risk.score, intent, risk: { door: risk.door, radius: risk.radius, safeBecauseProven: risk.safeBecauseProven, watch: risk.watch ?? [] } };
  const body = `${triageBody(risk, risk.tier)}\n\n${stateMarker(state)}`;
  const key = 'pr-babysit:triage';
  const posted = host(opts, ['thread-create', String(opts.pr), '--key', key, '--status', 'closed', '--body-file', bodyFile(opts.scratch, key, body)]);
  return { posted, tier: risk.tier, score: risk.score };
}

// ---------------------------------------------------------------------------------------------
// Round arguments

export function decideScope({ round, mode, tierRaised, sinceSha, foreignCommits }) {
  if (round === 1 || !sinceSha) return { scope: 'full', why: 'first round' };
  if (tierRaised) return { scope: 'full', why: 'the tier went up' };
  if (mode === 'review') return { scope: 'delta', why: 'review-only: the author\'s new commits' };
  if (foreignCommits.length) return { scope: 'full', why: `${foreignCommits.length} commit(s) not from this review landed: ${foreignCommits.slice(0, 3).join('; ')}` };
  return { scope: 'delta', why: 'only fixes from this review since the last round' };
}

// Commits since the last round that this review did not write: no `Refs: pr-babysit` trailer, not the nits
// commit, not a merge, and not already on the target (a merge of main brings those in, and main is reviewed).
function foreignCommits(repo, since, target) {
  const log = tryGit(repo, ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${since}..HEAD`, `^${target}`]) ?? '';
  return log.split('\x1e').map((e) => e.trim()).filter(Boolean).map((e) => e.split('\x1f'))
    .filter(([, subject, body]) => !/Refs: pr-babysit/.test(body ?? '') && !/^chore: review nits/.test(subject))
    .map(([sha, subject]) => `${short(sha)} ${subject}`);
}

function profileNotes(repo, target) {
  try {
    const out = execFileSync(process.execPath, [SIGNALS, '--which-profile', '--base', target, '--repo', repo], { encoding: 'utf8' });
    const profile = JSON.parse(out);
    if (!profile) return '';
    const text = profile.text.replace(/\r\n/g, '\n');
    const sectionOf = (heading) => {
      const lines = text.split('\n');
      const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}`, 'i').test(l));
      if (start < 0) return '';
      const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
      return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
    };
    return [sectionOf('Judgment notes'), sectionOf('Conventions')].filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}

// The spec this branch builds (spec-feature), found by its shape rather than its folder: a Markdown file
// added or changed on the branch with front matter and `**AC<n>:**` lines. The reviewers judge against it.
// Ambiguity or a failing map leaves the round without a spec and says why; it never stops the round.
function findSpec(repo, target, mergeBase) {
  const changed = (tryGit(repo, ['diff', '--name-status', '--diff-filter=AM', mergeBase, 'HEAD', '--', '*.md']) ?? '')
    .split('\n').filter(Boolean).map((line) => { const [status, path] = line.split('\t'); return { status, path }; });
  const specs = changed.filter(({ path }) => {
    const text = tryGit(repo, ['show', `HEAD:${path}`]) ?? '';
    return /^---\r?\n[\s\S]*?\btitle:[\s\S]*?\r?\n---/.test(text) && /^\s*[-*]\s*\*\*AC\d+:\*\*/m.test(text);
  });
  const added = specs.filter((f) => f.status === 'A');
  const pick = added.length === 1 ? added[0] : specs.length === 1 ? specs[0] : null;
  if (!pick) return { spec: null, specWarning: specs.length > 1 ? `${specs.length} specs changed on this branch (${specs.map((f) => f.path).join(', ')}); reviewing without one` : null };
  return mapSpec(repo, target, pick.path);
}

// A spec's acceptance criteria with the commits and tests that name them. The path is in the repository,
// or anywhere on disk when the spec lives in a ticket and was read out of it (`--spec-file`).
function mapSpec(repo, target, path) {
  let out;
  try {
    out = execFileSync(process.execPath, [ACMAP, '--spec', path, '--base', target, '--repo', repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    out = error.stdout?.toString(); // acmap exits 1 when an AC is uncovered; its map is still on stdout
  }
  try {
    const map = JSON.parse(out);
    const acs = map.acs.filter((a) => !a.dropped).map(({ id, statement, verifiedBy }) => ({ id, statement, verifiedBy }));
    return { spec: { path: path.replace(/\\/g, '/'), title: map.title, acs, missingTests: map.missingTests, missingCommits: map.missingCommits }, specWarning: null };
  } catch {
    return { spec: null, specWarning: `could not map the acceptance criteria of ${path}; reviewing without the spec` };
  }
}

function cmdArgs(opts) {
  need(opts, 'pr', 'repo', 'target', 'scratch');
  const { show, threads } = readPr(opts);
  const a = { ...analyse(show, threads), heads: headsOf(show, opts) };
  if (!a.triage) throw new Error('no triage thread: run triage first');
  const intent = a.triage.intent ?? (typeof opts['intent-file'] === 'string' ? readFileSync(opts['intent-file'], 'utf8').trim() : null);
  if (!intent) throw new Error('the triage thread has no intent in its marker (posted before 4.1); pass --intent-file');
  const next = nextStep(a);
  const lastRound = a.summaries.at(-1) ?? null;
  const sinceSha = lastRound?.reviewed ?? null;
  const foreign = sinceSha ? foreignCommits(opts.repo, sinceSha, opts.target) : [];
  // A finished review opens again when someone else pushed or a person waits for an answer.
  const reopened = ['report', 'merge-gate'].includes(next.action) && (foreign.length > 0 || a.human.length > 0);
  if (!['round', 'round-limit'].includes(next.action) && !reopened) throw new Error(`the next step is ${next.action} (${next.why}), not a new round`);
  const round = next.action === 'round' ? next.round : lastRound.round + 1;
  const previousTier = a.tier;
  const tierName = typeof opts.tier === 'string' ? opts.tier : previousTier;
  if (!TIERS.tiers[tierName]) throw new Error(`unknown tier ${tierName}`);
  const tierOrder = Object.keys(TIERS.tiers);
  if (tierOrder.indexOf(tierName) < tierOrder.indexOf(previousTier)) throw new Error(`the tier never goes down (${previousTier} -> ${tierName})`);
  const mode = typeof opts.mode === 'string' ? opts.mode : a.mode;
  const { scope, why } = decideScope({ round, mode, tierRaised: tierName !== previousTier, sinceSha, foreignCommits: foreign });

  const headSha = git(opts.repo, ['rev-parse', 'HEAD']);
  const mergeBase = git(opts.repo, ['merge-base', opts.target, 'HEAD']);
  let signals = { hitIds: [], reasons: [], destructive: [] };
  try {
    const s = JSON.parse(execFileSync(process.execPath, [SIGNALS, '--base', opts.target, '--head', 'HEAD', '--repo', opts.repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    signals = { hitIds: (s.hits ?? []).filter((h) => h.applies?.length).map((h) => h.id), reasons: [...(s.bounds?.floorReasons ?? []), ...(s.bounds?.capReasons ?? []), ...(s.bounds?.adjustReasons ?? [])], destructive: s.destructive ?? [] };
  } catch { /* no signals: the reviewers go without */ }

  const { spec, specWarning } = typeof opts['spec-file'] === 'string' ? mapSpec(opts.repo, opts.target, resolve(opts['spec-file'])) : findSpec(opts.repo, opts.target, mergeBase);

  const args = {
    round,
    tierName,
    tier: TIERS.tiers[tierName],
    scope,
    pr: { id: show.id, title: show.title, webUrl: show.webUrl, score: a.triage.score ?? null, intent },
    repo: { worktree: resolve(opts.repo).replace(/\\/g, '/'), mergeBase, headSha, sinceSha },
    signals,
    profileNotes: profileNotes(opts.repo, opts.target),
    ...(spec ? { spec } : {}),
    prior: a.findings.map((f) => ({ key: f.id, severity: f.severity, file: f.file, line: f.line, title: f.title, resolution: `${f.status}${f.lastReply ? `: ${f.lastReply}` : ''}` })),
    human: a.human.map((t) => ({ threadId: t.id, author: t.comments[0].author, file: t.file, line: t.line, conversation: t.comments.map((c) => `${c.author}: ${c.content.replace(/<!--[\s\S]*?-->/g, '').trim()}`).join('\n---\n') })),
    scratch: join(opts.scratch, `round-${round}`).replace(/\\/g, '/'),
  };
  const meta = { scopeWhy: why, mode, startedAt: typeof opts.started === 'string' ? opts.started : new Date().toISOString(), previousTier, tierReason: typeof opts['tier-reason'] === 'string' ? opts['tier-reason'] : null, user: show.me?.name ?? null };
  mkdirSync(opts.scratch, { recursive: true });
  const file = join(opts.scratch, `round-${round}-args.json`);
  writeFileSync(file, JSON.stringify({ ...args, _babysit: meta }, null, 2));
  // A second full round costs as much as the first, so the user says yes to it; a follow-up round does not ask.
  const ask = round > 1 && scope === 'full';
  return { file, round, tier: tierName, scope, scopeWhy: why, ask, sinceSha, headSha, human: args.human.length, prior: args.prior.length, spec: spec ? { path: spec.path, acs: spec.acs.length, missingTests: spec.missingTests } : null, specWarning, next };
}

// ---------------------------------------------------------------------------------------------
// Recording a round's findings

export function findingBody(f, round, tierName) {
  const machinery = `_Found by ${f.lenses?.length ? f.lenses.join(', ') : 'review'} · ${f.verification ?? 'unverified'} · round ${round}, ${tierName} review_`;
  return [
    `🤖 ${ICON[f.severity]} **${cap(f.severity)} · ${f.id}:** ${f.title}`,
    '',
    `${f.claim}${f.impact ? ` ${f.impact}` : ''}`,
    ...(f.alsoAt?.length ? ['', `Reported more than once; the same defect also shows at ${f.alsoAt.map((at) => `\`${at}\``).join(', ')}.`] : []),
    '',
    '**Evidence:**',
    '',
    '```text',
    trimLines(f.evidence, 12),
    '```',
    '',
    `**Suggested fix:** ${f.suggestedFix}`,
    '',
    machinery,
    '',
    stateMarker({ v: 1, id: f.id, severity: f.severity, title: f.title, file: f.file, line: f.line, oneWay: !!f.oneWay }),
  ].join('\n');
}

function humanReplyBody(h, finding) {
  if (h.verdict === 'confirmed') {
    const marker = finding ? `\n\n${stateMarker({ v: 1, id: finding.id, severity: finding.severity, title: finding.title, file: finding.file, line: finding.line, human: true })}` : '';
    return `🤖 **Checked: right.** ${h.reply} Tracked as ${h.findingId ?? 'a finding'}; the fix will be linked here.${marker}`;
  }
  if (h.verdict === 'refuted') return `🤖 **Checked: this doesn't hold.** ${h.reply}\n\nReopen the thread if there is a path this misses.`;
  return `🤖 **Answer:** ${h.reply}`;
}

function buildFindingBody(id, failure, round, tierName) {
  const steps = (failure.failedSteps ?? []).map((s) => `${s.name}\n${trimLines(s.logTail ?? (s.issues ?? []).join('\n'), 15)}`).join('\n…\n');
  return [
    `🤖 ${ICON.major} **Major · ${id}:** the PR build fails in ${failure.check ?? 'a check'}`,
    '',
    `[Run ${failure.runId ?? ''}](${failure.url ?? ''}) on \`${short(failure.commit)}\`. Review waits until it is green.`,
    '',
    '**Evidence:**',
    '',
    '```text',
    trimLines(steps || failure.result || 'no log', 20),
    '```',
    '',
    `_PR build · round ${round}, ${tierName} review_`,
    '',
    stateMarker({ v: 1, id, severity: 'major', title: `the PR build fails in ${failure.check ?? 'a check'}`, file: null, line: null }),
  ].join('\n');
}

function cmdRecord(opts) {
  need(opts, 'pr', 'round', 'scratch');
  const n = Number(opts.round);
  const argsFile = join(opts.scratch, `round-${n}-args.json`);
  const args = tryJson(argsFile);
  const mapFile = join(opts.scratch, `round-${n}-threads.json`);
  const map = tryJson(mapFile) ?? {};
  const pr = String(opts.pr);

  // A red build comes before the round's review, so before its args exist.
  if (typeof opts['build-failures'] === 'string') {
    const { show, threads } = readPr(opts);
    const tierName = args?.tierName ?? analyse(show, threads).tier;
    mkdirSync(opts.scratch, { recursive: true });
    const failures = [].concat(readJson(opts['build-failures']));
    const existing = Object.keys(map).filter((k) => k.startsWith(`R${n}-B`)).length;
    failures.forEach((failure, i) => {
      const id = `R${n}-B${existing + i + 1}`;
      const key = `pr-babysit:${id}`;
      const posted = host(opts, ['thread-create', pr, '--key', key, '--status', 'active', '--body-file', bodyFile(opts.scratch, key, buildFindingBody(id, failure, n, tierName))]);
      map[id] = { threadId: posted.id, url: posted.url, kind: 'build' };
    });
    writeFileSync(mapFile, JSON.stringify(map, null, 2));
    return { recorded: failures.length, threads: map };
  }

  if (!args) throw new Error(`cannot read ${argsFile}: run args first`);
  const review = args._babysit?.mode === 'review';
  const resultFile = join(opts.scratch, `round-${n}-result.json`);
  const result = tryJson(resultFile);
  if (!result) throw new Error(`cannot read ${resultFile}: save the workflow result there first`);
  if (result.valid === false) throw new Error(`round ${n} is invalid (${result.reason}); post nothing and stop the round`);
  const { show, threads } = readPr(opts);
  const a = analyse(show, threads);
  if (!a.log) throw new Error('no triage thread: run triage first');

  // People's threads: a verdict on each. A confirmed comment is a finding from here on, on their thread.
  let replied = 0;
  for (const h of result.human ?? []) {
    if (h.verdict === 'unchecked') continue;
    const key = `pr-babysit:R${n}-reply-${h.threadId}`;
    const status = review ? [] : ['--status', h.verdict === 'confirmed' ? 'active' : 'closed'];
    host(opts, ['reply', pr, String(h.threadId), '--key', key, ...status, '--body-file', bodyFile(opts.scratch, key, humanReplyBody(h, result.findings.find((f) => f.id === h.findingId)))]);
    replied++;
  }
  let created = 0;
  for (const f of result.findings) {
    if (f.humanThreadId) { map[f.id] = { threadId: f.humanThreadId, human: true }; continue; }
    // Review-only: the author has to see each finding where it is, so each gets its thread now.
    if (!review) continue;
    const key = `pr-babysit:${f.id}`;
    const posted = host(opts, [...placeFlags(['thread-create', pr, '--key', key, '--status', 'active'], f), '--body-file', bodyFile(opts.scratch, key, findingBody(f, n, args.tierName))]);
    map[f.id] = { threadId: posted.id, url: posted.url };
    if (!posted.existing) created++;
  }

  // The round's findings go on the log. In owner mode a finding gets a thread of its own only later, and
  // only when it needs a person (`reply`): a fix with proof is one line in the round summary.
  const slim = (f) => ({
    id: f.id, severity: f.severity, title: f.title, file: f.file, line: f.line, ...(f.endLine ? { endLine: f.endLine } : {}),
    claim: f.claim, impact: f.impact, evidence: trimLines(f.evidence, 12), suggestedFix: f.suggestedFix,
    lenses: f.lenses ?? [], verification: f.verification ?? null, oneWay: !!f.oneWay,
    ...(f.alsoAt?.length ? { alsoAt: f.alsoAt } : {}), ...(f.humanThreadId ? { humanThreadId: f.humanThreadId } : {}),
  });
  const key = `pr-babysit:R${n}-findings`;
  const body = `${findingsLine(n, result, review)}\n\n${stateMarker({ v: 2, round: n, findings: result.findings.map(slim) })}`;
  host(opts, ['reply', pr, String(a.log.id), '--key', key, '--body-file', bodyFile(opts.scratch, key, body)]);
  writeFileSync(mapFile, JSON.stringify(map, null, 2));
  return { recorded: result.findings.length, created, replied, log: a.log.url, threads: map, file: mapFile };
}

// ---------------------------------------------------------------------------------------------
// Replying with the fixer's outcomes

// A thread a finding already has: a person's own thread, or one from an earlier pass.
function threadFor(map, a, id) {
  if (map[id]) return map[id];
  const f = a.findings.find((x) => x.id === id);
  return f?.threadId ? { threadId: f.threadId, url: f.url, human: !!f.human } : null;
}

const placeFlags = (flags, f) => {
  if (!f.file || !f.line) return flags;
  const placed = [...flags, '--file', f.file.replace(/^\/+/, ''), '--line', String(f.line)];
  return f.endLine && f.endLine > f.line ? [...placed, '--end-line', String(f.endLine)] : placed;
};

const severityCounts = (findings) => ['blocker', 'major', 'minor'].map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, count]) => count).map(([s, count]) => `${ICON[s]} ${count}`).join(' · ');

export function findingsLine(n, result, review) {
  const found = result.findings.length ? `${severityCounts(result.findings)} found` : 'nothing found';
  const dropped = result.dropped?.length ? `, ${result.dropped.length} disproved` : '';
  const nits = result.nits?.length ? `, ${result.nits.length} nit${result.nits.length === 1 ? '' : 's'}` : '';
  const then = !result.findings.length ? '' : review ? ' → posted for the author' : ' → fixing';
  return `🤖 **Round ${n}:** ${found}${dropped}${nits}${then}`;
}

// The option letter of a recommendation ("A, because …"), of a choice ("1A", "A: keep it", "… (option A)"),
// or of { option, text }.
export const optionLetter = (value) => {
  if (value && typeof value === 'object') return value.option ?? null;
  const m = String(value ?? '').trim().match(/^\d*([A-Z])(?![a-z])|\(option ([A-Z])\)/);
  return m?.[1] ?? m?.[2] ?? null;
};
const choiceText = (choice) => (typeof choice === 'string' ? choice : choice?.text ?? `option ${choice?.option}`);

export function fixedBody(r, show) {
  const lines = [
    `🤖 ✅ **Fixed** in ${commitLink(show, r.commit)}`,
    '',
    `- **Cause:** ${r.rootCause}`,
    `- **Change:** ${r.change}`,
    `- **Proof:** \`${r.proof?.command ?? ''}\` → ${r.proof?.result ?? ''}`,
  ];
  if (r.alsoFixed?.length) lines.push(`- **Same mistake, also fixed:** ${r.alsoFixed.join('; ')}`);
  return lines.join('\n');
}

export function declinedBody(r) {
  const kind = DECLINE[r.declineKind] ?? DECLINE['false-positive'];
  return `🤖 ↩️ **Declined, ${kind.words}:** ${r.declineReason}`;
}

function optionLines(r) {
  const recommended = optionLetter(r.recommendation);
  const options = (r.options ?? []).map((o) => {
    const m = o.match(/^\s*([A-Z])\s*[:.)-]\s*(.*)$/s);
    const letter = m?.[1] ?? '';
    return `- **${letter}${letter && letter === recommended ? ' (recommended)' : ''}:** ${m?.[2] ?? o}`;
  });
  const why = (r.recommendation ?? '').replace(/^\s*[A-Z]\s*[,:.)-]?\s*(because\s+)?/i, '').trim();
  return [...options, ...(why ? ['', `Recommended because ${why.replace(/\.$/, '')}.`] : [])];
}

export function needsBody(r, user) {
  return [`🤖 ❓ **Needs ${user}:** ${r.question}`, '', ...optionLines(r), '', 'The question is waiting in the babysit session.'].join('\n');
}

export function decidedBody(r, choice, user, show) {
  if (r.decision === 'fixed') return `🤖 🧭 **Decided by ${user}:** ${choice}\n\nDone in ${commitLink(show, r.commit)}: ${r.change}`;
  return `🤖 🧭 **Decided by ${user}:** ${choice}\n\n${r.declineReason ?? 'No change needed.'}`;
}

// The two threads a finding can get in owner mode. Each says in one comment what a person has to know:
// the ask or the verdict first, the finding in two sentences, nothing they need not read.
const findingMachinery = (f, round, tierName) => `_${f.id} · ${ICON[f.severity]} ${f.severity} · found by ${f.lenses?.length ? f.lenses.join(', ') : 'review'} · ${f.verification ?? 'unverified'} · round ${round}, ${tierName} review_`;
const findingMarker = (f) => stateMarker({ v: 1, id: f.id, severity: f.severity, title: f.title, file: f.file, line: f.line, oneWay: !!f.oneWay });
const findingText = (f) => `${f.title.replace(/\.$/, '')}. ${f.claim ?? ''}${f.impact ? ` ${f.impact}` : ''}${f.alsoAt?.length ? ` The same defect also shows at ${f.alsoAt.map((at) => `\`${at}\``).join(', ')}.` : ''}`.trim();

export function needsThreadBody(f, r, user, round, tierName) {
  return [
    `🤖 ❓ **Needs ${user}:** ${r.question}`,
    '',
    findingText(f),
    '',
    ...optionLines(r),
    '',
    'The question is waiting in the babysit session.',
    '',
    findingMachinery(f, round, tierName),
    '',
    findingMarker(f),
  ].join('\n');
}

export function declinedThreadBody(f, r, round, tierName) {
  const kind = DECLINE[r.declineKind] ?? DECLINE['false-positive'];
  return [
    `🤖 ↩️ **Declined, ${kind.words}:** ${r.declineReason}`,
    '',
    `**The finding was:** ${findingText(f)}`,
    '',
    'Write here if you disagree; the review answers it.',
    '',
    findingMachinery(f, round, tierName),
    '',
    findingMarker(f),
  ].join('\n');
}

function cmdReply(opts) {
  need(opts, 'pr', 'round', 'scratch', 'repo', 'fixer');
  const n = Number(opts.round);
  const fixer = readJson(opts.fixer);
  const choices = typeof opts.choices === 'string' ? readJson(opts.choices) : null;
  const { show, threads } = readPr(opts);
  const a = analyse(show, threads);
  if (!a.log) throw new Error('no triage thread: run triage first');
  const tierName = tryJson(join(opts.scratch, `round-${n}-args.json`))?.tierName ?? a.tier;
  const map = tryJson(join(opts.scratch, `round-${n}-threads.json`)) ?? {};
  const user = (show.me?.name ?? 'you').split(/\s+/)[0];
  const pr = String(opts.pr);

  // The conductor's own check run on the pushed head, never the fixer's word, gates every fix.
  const wantsFixed = fixer.results.some((r) => r.decision === 'fixed');
  let checks = null;
  if (wantsFixed) {
    if (typeof opts.checks !== 'string') throw new Error('missing --checks: run checks.mjs on the pushed head first and pass its JSON');
    checks = readJson(opts.checks);
    const head = git(opts.repo, ['rev-parse', 'HEAD']);
    if (checks.status === 'failed') throw new Error(`the checks failed on ${short(checks.headSha)}: ${checks.results.filter((r) => r.status !== 'passed').map((r) => r.id).join(', ')}; fix before replying`);
    if (checks.headSha && checks.headSha !== head) throw new Error(`the checks ran on ${short(checks.headSha)}, but HEAD is ${short(head)}: run them again`);
  }

  const posted = [];
  const unproven = [];
  const outcomes = {};
  for (const r of fixer.results) {
    const f = a.findings.find((x) => x.id === r.id);
    const thread = threadFor(map, a, r.id);
    if (!f && !thread) { posted.push({ id: r.id, skipped: 'no such finding in this review' }); continue; }
    const detail = { id: r.id, severity: f?.severity ?? 'minor', title: f?.title ?? r.id, file: f?.file ?? null, line: f?.line ?? null, ...(f?.detail ?? {}) };
    const exists = r.decision === 'fixed' && tryGit(opts.repo, ['cat-file', '-t', r.commit ?? 'x']) === 'commit';
    let outcome; let status; let reply; let own = null; let text;
    if (choices && choices[r.id] !== undefined) {
      if (r.decision === 'fixed' && !exists) { unproven.push({ id: r.id, why: `commit ${r.commit} does not exist` }); continue; }
      const chosen = choiceText(choices[r.id]);
      outcome = 'decided'; status = r.decision === 'fixed' ? 'fixed' : 'closed';
      reply = decidedBody(r, chosen, user, show);
      text = `decided by ${user}: ${chosen}`;
    } else if (r.decision === 'fixed') {
      if (!(exists && r.proof?.command && r.proof?.result)) {
        const why = exists ? 'no proof command and result' : `commit ${r.commit} does not exist`;
        if (!opts['escalate-unproven']) { unproven.push({ id: r.id, why }); continue; }
        const ask = { question: `The fix could not be proven (${why}). Keep it, revert it, or fix it by hand?`, options: ['A: keep it and check by hand (a few minutes)', 'B: revert it and leave the finding open (no risk, finding stays)'], recommendation: 'B' };
        outcome = 'needs'; status = 'pending'; reply = needsBody(ask, user); own = needsThreadBody(detail, ask, user, n, tierName); text = 'needs a decision: the fix could not be proven';
      } else {
        outcome = 'fixed'; status = 'fixed'; reply = fixedBody(r, show); text = `fixed in ${short(r.commit)}: ${r.change}`;
      }
    } else if (r.decision === 'declined') {
      const kind = DECLINE[r.declineKind] ?? DECLINE['false-positive'];
      outcome = 'declined'; status = kind.status; reply = declinedBody(r); own = declinedThreadBody(detail, r, n, tierName); text = `declined, ${kind.words}: ${r.declineReason}`;
    } else if (r.decision === 'escalate') {
      outcome = 'needs'; status = 'pending'; reply = needsBody(r, user); own = needsThreadBody(detail, r, user, n, tierName); text = `needs a decision: ${r.question}`;
    } else { posted.push({ id: r.id, skipped: `unknown decision ${r.decision}` }); continue; }

    let url = thread?.url ?? null;
    if (thread) {
      const key = `pr-babysit:${r.id}-${outcome}`;
      const statusFlag = a.mode === 'review' && thread.human ? [] : ['--status', status];
      host(opts, ['reply', pr, String(thread.threadId), '--key', key, ...statusFlag, '--body-file', bodyFile(opts.scratch, key, reply)]);
    } else if (own) {
      // It needs a person, so it gets a thread at its line: the ask or the verdict, and the finding, in one comment.
      const key = `pr-babysit:${r.id}`;
      url = host(opts, [...placeFlags(['thread-create', pr, '--key', key, '--status', status], detail), '--body-file', bodyFile(opts.scratch, key, own)]).url ?? null;
    }
    // A fix with proof and no thread posts nothing: its line in the round summary and its commit are the record.
    outcomes[r.id] = {
      status, outcome, text,
      ...(r.commit && r.decision === 'fixed' ? { commit: r.commit } : {}),
      ...(outcome === 'needs' ? { recommended: optionLetter(r.recommendation ?? 'B') } : {}),
      ...(outcome === 'decided' ? { chosen: optionLetter(choices[r.id]), recommended: f?.outcome?.recommended ?? null } : {}),
    };
    posted.push({ id: r.id, outcome, status, thread: url });
  }

  if (Object.keys(outcomes).length) {
    const count = (o) => Object.values(outcomes).filter((x) => x.outcome === o).length;
    const parts = [count('fixed') && `✅ ${count('fixed')} fixed`, count('decided') && `🧭 ${count('decided')} decided`, count('declined') && `↩️ ${count('declined')} declined`, count('needs') && `❓ ${count('needs')} need${count('needs') === 1 ? 's' : ''} ${user}`].filter(Boolean);
    const hash = createHash('sha1').update(JSON.stringify(outcomes)).digest('hex').slice(0, 8);
    const key = `pr-babysit:R${n}-outcomes-${hash}`;
    host(opts, ['reply', pr, String(a.log.id), '--key', key, '--body-file', bodyFile(opts.scratch, key, `🤖 **Round ${n} outcomes:** ${parts.join(' · ')}\n\n${stateMarker({ v: 2, round: n, outcomes })}`)]);
  }
  return { posted, unproven, checks: checks ? checks.status : null, decisions: posted.filter((p) => p.outcome === 'needs').map((p) => ({ id: p.id, thread: p.thread })) };
}

// ---------------------------------------------------------------------------------------------
// Round summary

const isDecided = (f) => f.outcome?.outcome === 'decided' || f.replyKeys.some((k) => k.endsWith('-decided'));

function outcomeCell(f, show, fixerById, choices) {
  const commit = fixerById[f.id]?.commit ?? f.outcome?.commit ?? null;
  if (f.status === 'pending') return '❓ waiting for a decision';
  if (f.status === 'active') return 'open';
  if (isDecided(f)) return `🧭 ${choices?.[f.id] ? choiceText(choices[f.id]).slice(0, 60) : 'decided'}${commit ? ` · ${commitLink(show, commit)}` : ''}`;
  if (f.status === 'fixed') return `✅ ${commit ? commitLink(show, commit) : 'fixed'}`;
  if (f.status === 'byDesign') return '↩️ by design';
  if (f.status === 'wontFix') return '↩️ out of scope';
  return '↩️ false positive';
}

// Clean = no review finding at or above the bar, people's confirmed comments included. The bar is the
// tier's for a round over the whole change and major for a round over the fixes: a minor in a fix is
// fixed and listed, and never buys another round. Build threads were fixed before the review started
// and do not count.
export const barOf = (tier, scope) => (scope === 'delta' ? 'major' : tier.severityBar);
export const isClean = (findings, tier, scope) => !findings.some((f) => f.kind !== 'build' && rank(f.severity) >= rank(barOf(tier, scope)));

export function summaryBody({ n, args, result, findings, show, fixers, choices, next }) {
  const t = args.tier;
  // A decision pass's result (with its commit) wins over the first pass's escalation for the same finding.
  const fixerById = {};
  for (const r of fixers.flatMap((x) => x?.results ?? [])) if (!fixerById[r.id] || r.commit) fixerById[r.id] = r;
  const count = (pred) => findings.filter(pred).length;
  const decided = count(isDecided);
  const fixed = count((f) => f.status === 'fixed' && !isDecided(f));
  const declined = count((f) => ['closed', 'byDesign', 'wontFix'].includes(f.status) && !isDecided(f));
  const waiting = count((f) => ['pending', 'active'].includes(f.status));
  const counts = [fixed && `✅ ${fixed} fixed`, decided && `🧭 ${decided} decided`, declined && `↩️ ${declined} declined`, waiting && `❓ ${waiting} open`].filter(Boolean).join(' · ');
  const header = `🤖 **Round ${n} of up to ${t.maxRounds} · ${args.tierName} review:** ${findings.length ? counts : '✅ clean, nothing found'}`;
  const lines = [header];
  if (args._babysit?.previousTier && args._babysit.previousTier !== args.tierName) lines.push('', `⬆️ **Raised from ${args._babysit.previousTier} to ${args.tierName}:** ${args._babysit.tierReason ?? 'a new risk signal'}`);
  if (findings.length) {
    lines.push('', '| | Finding | Outcome |', '|---|---|---|');
    for (const f of [...findings].sort((x, y) => rank(y.severity) - rank(x.severity) || x.id.localeCompare(y.id, undefined, { numeric: true }))) {
      lines.push(`| ${ICON[f.severity]} | ${f.url ? `[${f.id}](${f.url})` : f.id} ${f.title.replace(/\|/g, '\\|')} | ${outcomeCell(f, show, fixerById, choices)} |`);
    }
  }
  const bar = barOf(t, args.scope);
  const above = findings.filter((f) => f.kind !== 'build' && rank(f.severity) >= rank(bar)).length;
  const clean = isClean(findings, t, args.scope);
  const nextText = {
    round: `round ${next.round} is next${next.scope === 'delta' ? ', on the fixes only; done once they hold no major finding' : ''}`,
    'round-limit': 'the round limit is reached',
    report: 'the review is done',
    'merge-gate': 'the review is done',
  }[next.action] ?? next.why;
  const unchanged = !clean && ['report', 'merge-gate'].includes(next.action) ? ': nothing changed since, so there is no fix to verify' : '';
  if (findings.length) lines.push('', `**${clean ? 'Clean' : 'Not clean'}** (${clean ? 'nothing' : above} at or above ${bar}) → ${nextText}${unchanged}.`);
  if (result.dropped?.length) {
    // A disproved major or blocker shows its severity, so it can be listed under "worth a glance".
    lines.push('', `**Disproved before posting:** ${result.dropped.length}`, '');
    for (const d of result.dropped) lines.push(`- ${rank(d.severity) >= rank('major') ? `${ICON[d.severity]} ` : ''}\`${d.file}:${d.line}\` ${d.title}: ${String(d.reason).split(' / ')[0]}`);
  }
  if (result.nits?.length) {
    const nitsCommit = fixers.map((x) => x?.nitsCommit).find(Boolean);
    lines.push('', `**Nits:** ${result.nits.length}${nitsCommit ? `, the clear ones fixed in ${commitLink(show, nitsCommit)}` : ', none fixed'}`);
  }
  const reviewed = args.scope === 'delta' && args.repo.sinceSha ? `the fixes since \`${short(args.repo.sinceSha)}\` up to \`${short(args.repo.headSha)}\`` : `\`${short(args.repo.headSha)}\``;
  const reviewers = result.coverage?.reviewers ?? [];
  const merged = result.coverage?.duplicatesMerged ?? 0;
  const skepticCount = result.coverage?.skeptics ?? 0;
  const skeptics = `${merged ? ` · ${merged} duplicate report${merged === 1 ? '' : 's'} merged` : ''}${skepticCount ? ` · every finding checked by a skeptic (${skepticCount})` : ''}`;
  lines.push('', `_Reviewed ${reviewed} · ${reviewers.length} reviewer${reviewers.length === 1 ? '' : 's'}${reviewers.length ? ` (${lensText(reviewers)})` : ''} · ${t.model} ${t.effort}${skeptics}_`);
  return { body: lines.join('\n'), clean };
}

function cmdSummary(opts) {
  need(opts, 'pr', 'round', 'scratch', 'repo');
  const n = Number(opts.round);
  const args = tryJson(join(opts.scratch, `round-${n}-args.json`));
  if (!args) throw new Error(`cannot read round-${n}-args.json in ${opts.scratch}`);
  const result = tryJson(join(opts.scratch, `round-${n}-result.json`)) ?? { findings: [], dropped: [], nits: [] };
  const fixers = existsSync(opts.scratch) ? readdirSync(opts.scratch).filter((f) => new RegExp(`^round-${n}-fixer.*\\.json$`).test(f)).map((f) => tryJson(join(opts.scratch, f))) : [];
  const choices = tryJson(join(opts.scratch, `round-${n}-choices.json`));
  const { show, threads } = readPr(opts);
  const a = { ...analyse(show, threads), heads: headsOf(show, opts) };
  const findings = a.findings.filter((f) => f.round === n);
  // Decide what comes after this round as if its summary were already posted.
  const cleanNow = isClean(findings, args.tier, args.scope);
  const next = nextStep({ ...a, findings: a.findings.filter((f) => f.round !== n), summaries: [...a.summaries.filter((s) => s.round !== n), { round: n, clean: cleanNow, tier: args.tierName, reviewed: args.repo.headSha }], tier: args.tierName });
  if (next.action === 'round') next.scope = 'delta';
  const { body, clean } = summaryBody({ n, args, result, findings, show, fixers, choices, next });
  const state = { v: 1, round: n, tier: args.tierName, scope: args.scope, clean, reviewed: args.repo.headSha, since: args.repo.sinceSha ?? null };

  // Metrics never block the summary; a preview records nothing.
  let metrics = null;
  if (!opts.print) try {
    const out = execFileSync(process.execPath, [MEASURE, 'round', '--repo', opts.repo, '--pr', String(show.id), '--pr-url', show.webUrl ?? String(show.id), '--round', String(n), '--tier', args.tierName, '--scope', args.scope, '--started', args._babysit?.startedAt ?? new Date().toISOString(), '--scratch', opts.scratch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    metrics = JSON.parse(out);
  } catch (error) {
    metrics = { error: String(error.stderr ?? error.message).trim().slice(0, 300) };
  }
  const full = [body, '', stateMarker(state), ...(metrics?.marker ? [metrics.marker] : [])].join('\n');
  if (opts.print) return { body: full, next, metrics: metrics?.error ? metrics : 'recorded' };
  if (!a.log) throw new Error('no triage thread: run triage first');
  const key = `pr-babysit:R${n}-summary`;
  const posted = host(opts, ['reply', String(opts.pr), String(a.log.id), '--key', key, '--body-file', bodyFile(opts.scratch, key, full)]);
  return { posted, clean, next, metrics: metrics?.error ? metrics : { ledger: metrics?.ledger } };
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = { state: cmdState, triage: cmdTriage, args: cmdArgs, record: cmdRecord, reply: cmdReply, summary: cmdSummary };

// Run as a command, also through a junction or symlink (personal skills): compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()) {
  const opts = parseArgs(process.argv.slice(2));
  const command = COMMANDS[opts._[0]];
  if (!command) {
    console.error(`usage: babysit.mjs ${Object.keys(COMMANDS).join(' | ')}  (see the header of this file)`);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(command(opts), null, 2));
  } catch (error) {
    console.error(`babysit: ${String(error.stderr ?? '').trim() || error.message}`);
    process.exit(1);
  }
}
