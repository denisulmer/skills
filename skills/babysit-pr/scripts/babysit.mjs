#!/usr/bin/env node
// The bookkeeping of a babysit-pr run, so every step that needs no judgment comes out the same each time:
// where the PR stands and what comes next, the review round's inputs and scope, and every comment posted
// from a round's results in references/style.md's templates. The PR stays the state: everything posted
// carries a pr-host key and a hidden `<!-- babysit {...} -->` marker this script reads back.
//
//   node babysit.mjs state   --pr <pr> [--repo <path>]
//   node babysit.mjs triage  --pr <pr> --risk <score.json> --intent-file <f> --scratch <dir> [--repo <path>]
//   node babysit.mjs args    --pr <pr> --repo <worktree> --target <ref> --scratch <dir> [--tier <t> --tier-reason <r>]
//                            [--mode owner|review] [--started <iso>] [--intent-file <f>]
//   node babysit.mjs record  --pr <pr> --round <n> --scratch <dir> [--repo <path>] [--build-failures <file>]
//   node babysit.mjs reply   --pr <pr> --round <n> --scratch <dir> --repo <worktree> --fixer <file> --checks <file>
//                            [--choices <file>] [--escalate-unproven]
//   node babysit.mjs summary --pr <pr> --round <n> --scratch <dir> --repo <worktree> [--print]
//
// Files in <scratch>: round-<n>-args.json (written by args), round-<n>-result.json (the workflow result),
// round-<n>-threads.json (written by record), round-<n>-fixer*.json (the fixer's JSON blocks).
// PR_HOST_DRY_RUN passes through to pr-host, so a rehearsal posts nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

export function analyse(show, threads) {
  const byKey = new Map(threads.filter((t) => t.key).map((t) => [t.key, t]));
  const triageThread = byKey.get('pr-babysit:triage') ?? null;
  const triage = triageThread
    ? readState(triageThread.comments[0]?.content) ?? { tier: triageThread.comments[0]?.content.match(/·\s*(trivial|low|medium|high|critical) review/)?.[1] ?? null }
    : null;
  if (triage && triageThread) triage.published = triageThread.comments[0]?.published ?? null;

  const findings = [];
  for (const t of threads) {
    const m = t.key?.match(FINDING_KEY);
    if (!m) continue;
    const st = readState(t.comments[0]?.content) ?? {};
    const legacy = t.comments[0]?.content.match(/\*\*(Blocker|Major|Minor|Nit) · R\d+-[FB]\d+:\*\*\s*(.+)/);
    const replies = t.comments.slice(1).filter((c) => c.isMine);
    findings.push({
      id: m[1],
      round: Number(m[2]),
      kind: m[3] === 'B' ? 'build' : 'finding',
      threadId: t.id,
      url: t.url,
      status: t.status,
      severity: st.severity ?? legacy?.[1]?.toLowerCase() ?? (m[3] === 'B' ? 'major' : 'minor'),
      title: st.title ?? legacy?.[2]?.trim() ?? firstLine(t.comments[0]?.content),
      file: t.file ?? st.file ?? null,
      line: t.line ?? st.line ?? null,
      lastReply: replies.length ? firstLine(replies.at(-1).content) : null,
      replyKeys: t.comments.map((c) => c.key).filter(Boolean),
    });
  }
  // A person's confirmed comment became a finding: our reply on their thread (key R<n>-reply-<thread>)
  // carries the finding's marker.
  for (const t of threads) {
    const confirm = t.comments.find((c) => /^pr-babysit:R\d+-reply-\d+$/.test(c.key ?? '') && readState(c.content)?.id);
    if (!confirm) continue;
    const st = readState(confirm.content);
    const replies = t.comments.filter((c) => c.isMine && c !== confirm && c.key);
    findings.push({
      id: st.id,
      round: Number(st.id.match(/^R(\d+)-/)?.[1] ?? 0),
      kind: 'finding',
      human: true,
      threadId: t.id,
      url: t.url,
      status: t.status,
      severity: st.severity ?? 'minor',
      title: st.title ?? firstLine(t.comments[0]?.content),
      file: t.file ?? st.file ?? null,
      line: t.line ?? st.line ?? null,
      lastReply: replies.length ? firstLine(replies.at(-1).content) : null,
      replyKeys: t.comments.map((c) => c.key).filter(Boolean),
    });
  }
  const summaries = [];
  for (const t of threads) {
    const m = t.key?.match(/^pr-babysit:R(\d+)-summary$/);
    if (!m) continue;
    const content = t.comments[0]?.content ?? '';
    const st = readState(content) ?? {};
    summaries.push({
      round: Number(m[1]),
      url: t.url,
      tier: st.tier ?? content.match(/·\s*(trivial|low|medium|high|critical) review/)?.[1] ?? null,
      scope: st.scope ?? null,
      clean: st.clean ?? /✅ clean/.test(content),
      reviewed: st.reviewed ?? content.match(/(?:up to|Reviewed) `([0-9a-f]{7,40})`/)?.[1] ?? null,
    });
  }
  summaries.sort((a, b) => a.round - b.round);
  const tier = summaries.at(-1)?.tier ?? triage?.tier ?? null;
  const report = byKey.get('pr-babysit:report') ?? null;
  const human = threads.filter((t) => t.kind === 'human' && ['active', 'pending'].includes(t.status) && t.comments.length && !t.comments.at(-1).isMine);
  return { triage, findings, summaries, tier, report: report ? { url: report.url } : null, human, mode: show.isMine ? 'owner' : 'review' };
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
  const openRound = [...new Set(a.findings.filter((f) => f.kind !== 'build').map((f) => f.round))].filter((r) => !closed.has(r)).sort((x, y) => x - y)[0];
  if (openRound !== undefined) {
    const open = a.findings.filter((f) => f.round === openRound);
    if (open.some((f) => f.status === 'active')) return { action: a.mode === 'owner' ? 'fix' : 'close', round: openRound, why: `${open.filter((f) => f.status === 'active').length} finding(s) of round ${openRound} not handled yet` };
    if (open.some((f) => f.status === 'pending')) return { action: 'await-decisions', round: openRound, why: `${open.filter((f) => f.status === 'pending').length} decision(s) waiting for the user` };
    return { action: 'close', round: openRound, why: `every finding of round ${openRound} is handled; post its summary` };
  }
  const last = a.summaries.at(-1)?.round ?? 0;
  if (last === 0) return { action: 'round', round: 1, why: 'triage done, no round yet' };
  let streak = 0;
  for (const s of [...a.summaries].reverse()) { if (!s.clean) break; streak++; }
  if (last >= t.minRounds && streak >= t.cleanRoundsNeeded) return { action: a.report ? 'merge-gate' : 'report', why: `${streak} clean round(s) in a row after ${last} round(s)` };
  if (last >= t.maxRounds) return { action: 'round-limit', round: last, why: `${t.maxRounds} rounds without ${t.cleanRoundsNeeded} clean in a row` };
  if (last >= t.minRounds) return { action: 'ask-another', round: last + 1, why: `round ${last} was not clean; the tier's minimum of ${t.minRounds} is reached` };
  return { action: 'round', round: last + 1, why: `the tier needs at least ${t.minRounds} rounds` };
}

function cmdState(opts) {
  need(opts, 'pr');
  const { show, threads } = readPr(opts);
  const a = analyse(show, threads);
  return {
    pr: { id: show.id, title: show.title, status: show.status, isDraft: show.isDraft, webUrl: show.webUrl, head: show.sourceCommit },
    mode: a.mode,
    tier: a.tier,
    triage: a.triage,
    rounds: a.summaries,
    findings: a.findings.map(({ replyKeys, ...f }) => f),
    humanWaiting: a.human.map((t) => ({ threadId: t.id, author: t.comments[0].author, file: t.file, line: t.line, url: t.url })),
    report: a.report,
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
  const rounds = t.minRounds === t.maxRounds ? `${t.minRounds} round` : `${t.minRounds}–${t.maxRounds} rounds`;
  const done = t.cleanRoundsNeeded > 1 ? `${t.cleanRoundsNeeded} clean rounds in a row` : `a clean one with no ${t.severityBar} finding`;
  const first = [...t.portionLenses.map((l) => `${l} per part`), ...t.wholeLenses.filter((l) => !t.portionLenses.includes(l))];
  const skeptics = t.refuters > 0 ? ` · ${t.refuters} skeptic${t.refuters > 1 ? 's' : ''} check every major finding` : '';
  const later = t.maxRounds > 1 ? `, later rounds only the fixes (${lensText(t.followUpLenses ?? t.wholeLenses)})` : '';
  return [
    `🤖 **Risk ${risk.score}/100 · ${tierName} review**`,
    '',
    `**${risk.score}** = ${sumText(risk)}`,
    '',
    ...bullets,
    '',
    `**Plan:** ${rounds}, done after ${done} · round 1 reviews the whole change (${lensText(first)})${later}${skeptics}`,
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
  let out;
  try {
    out = execFileSync(process.execPath, [ACMAP, '--spec', pick.path, '--base', target, '--repo', repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    out = error.stdout?.toString(); // acmap exits 1 when an AC is uncovered; its map is still on stdout
  }
  try {
    const map = JSON.parse(out);
    const acs = map.acs.filter((a) => !a.dropped).map(({ id, statement, verifiedBy }) => ({ id, statement, verifiedBy }));
    return { spec: { path: pick.path, title: map.title, acs, missingTests: map.missingTests, missingCommits: map.missingCommits }, specWarning: null };
  } catch {
    return { spec: null, specWarning: `could not map the acceptance criteria of ${pick.path}; reviewing without the spec` };
  }
}

function cmdArgs(opts) {
  need(opts, 'pr', 'repo', 'target', 'scratch');
  const { show, threads } = readPr(opts);
  const a = analyse(show, threads);
  if (!a.triage) throw new Error('no triage thread: run triage first');
  const intent = a.triage.intent ?? (typeof opts['intent-file'] === 'string' ? readFileSync(opts['intent-file'], 'utf8').trim() : null);
  if (!intent) throw new Error('the triage thread has no intent in its marker (posted before 4.1); pass --intent-file');
  const next = nextStep(a);
  if (!['round', 'ask-another', 'round-limit'].includes(next.action)) throw new Error(`the next step is ${next.action} (${next.why}), not a new round`);
  const round = next.action === 'round-limit' ? next.round + 1 : next.round;
  const previousTier = a.tier;
  const tierName = typeof opts.tier === 'string' ? opts.tier : previousTier;
  if (!TIERS.tiers[tierName]) throw new Error(`unknown tier ${tierName}`);
  const tierOrder = Object.keys(TIERS.tiers);
  if (tierOrder.indexOf(tierName) < tierOrder.indexOf(previousTier)) throw new Error(`the tier never goes down (${previousTier} -> ${tierName})`);
  const sinceSha = a.summaries.at(-1)?.reviewed ?? null;
  const mode = typeof opts.mode === 'string' ? opts.mode : a.mode;
  const { scope, why } = decideScope({ round, mode, tierRaised: tierName !== previousTier, sinceSha, foreignCommits: sinceSha ? foreignCommits(opts.repo, sinceSha, opts.target) : [] });

  const headSha = git(opts.repo, ['rev-parse', 'HEAD']);
  const mergeBase = git(opts.repo, ['merge-base', opts.target, 'HEAD']);
  let signals = { hitIds: [], reasons: [], destructive: [] };
  try {
    const s = JSON.parse(execFileSync(process.execPath, [SIGNALS, '--base', opts.target, '--head', 'HEAD', '--repo', opts.repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    signals = { hitIds: (s.hits ?? []).filter((h) => h.applies?.length).map((h) => h.id), reasons: [...(s.bounds?.floorReasons ?? []), ...(s.bounds?.capReasons ?? []), ...(s.bounds?.adjustReasons ?? [])], destructive: s.destructive ?? [] };
  } catch { /* no signals: the reviewers go without */ }

  const { spec, specWarning } = findSpec(opts.repo, opts.target, mergeBase);

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
  return { file, round, tier: tierName, scope, scopeWhy: why, sinceSha, headSha, human: args.human.length, prior: args.prior.length, spec: spec ? { path: spec.path, acs: spec.acs.length, missingTests: spec.missingTests } : null, specWarning, next };
}

// ---------------------------------------------------------------------------------------------
// Recording a round's findings

export function findingBody(f, round, tierName) {
  const machinery = `_Found by ${f.lenses?.length ? f.lenses.join(', ') : 'review'} · ${f.verification ?? 'unverified'} · round ${round}, ${tierName} review_`;
  return [
    `🤖 ${ICON[f.severity]} **${cap(f.severity)} · ${f.id}:** ${f.title}`,
    '',
    `${f.claim}${f.impact ? ` ${f.impact}` : ''}`,
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
  let created = 0;
  for (const f of result.findings) {
    if (f.humanThreadId) { map[f.id] = { threadId: f.humanThreadId, human: true }; continue; }
    const key = `pr-babysit:${f.id}`;
    const flags = ['thread-create', pr, '--key', key, '--status', 'active', '--file', f.file.replace(/^\/+/, ''), '--line', String(f.line)];
    if (f.endLine && f.endLine > f.line) flags.push('--end-line', String(f.endLine));
    const posted = host(opts, [...flags, '--body-file', bodyFile(opts.scratch, key, findingBody(f, n, args.tierName))]);
    map[f.id] = { threadId: posted.id, url: posted.url };
    if (!posted.existing) created++;
  }
  let replied = 0;
  for (const h of result.human ?? []) {
    if (h.verdict === 'unchecked') continue;
    const key = `pr-babysit:R${n}-reply-${h.threadId}`;
    const status = review ? [] : ['--status', h.verdict === 'confirmed' ? 'active' : 'closed'];
    host(opts, ['reply', pr, String(h.threadId), '--key', key, ...status, '--body-file', bodyFile(opts.scratch, key, humanReplyBody(h, result.findings.find((f) => f.id === h.findingId)))]);
    replied++;
  }
  writeFileSync(mapFile, JSON.stringify(map, null, 2));
  return { created, replied, findings: result.findings.length, threads: map, file: mapFile };
}

// ---------------------------------------------------------------------------------------------
// Replying with the fixer's outcomes

function threadFor(map, a, id) {
  if (map[id]) return map[id];
  const f = a.findings.find((x) => x.id === id);
  return f ? { threadId: f.threadId, url: f.url } : null;
}

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

export function needsBody(r, user) {
  const recommended = (r.recommendation ?? '').trim().charAt(0).toUpperCase();
  const options = (r.options ?? []).map((o) => {
    const m = o.match(/^\s*([A-Z])\s*[:.)-]\s*(.*)$/s);
    const letter = m?.[1] ?? '';
    const text = m?.[2] ?? o;
    return `- **${letter}${letter && letter === recommended ? ' (recommended)' : ''}:** ${text}`;
  });
  const why = (r.recommendation ?? '').replace(/^\s*[A-Z]\s*[,:.)-]?\s*(because\s+)?/i, '').trim();
  return [`🤖 ❓ **Needs ${user}:** ${r.question}`, '', ...options, ...(why ? ['', `Recommended because ${why.replace(/\.$/, '')}.`] : []), '', 'The question is waiting in the babysit session.'].join('\n');
}

export function decidedBody(r, choice, user, show) {
  if (r.decision === 'fixed') return `🤖 🧭 **Decided by ${user}:** ${choice}\n\nDone in ${commitLink(show, r.commit)}: ${r.change}`;
  return `🤖 🧭 **Decided by ${user}:** ${choice}\n\n${r.declineReason ?? 'No change needed.'}`;
}

function cmdReply(opts) {
  need(opts, 'pr', 'round', 'scratch', 'repo', 'fixer');
  const n = Number(opts.round);
  const fixer = readJson(opts.fixer);
  const choices = typeof opts.choices === 'string' ? readJson(opts.choices) : null;
  const { show, threads } = readPr(opts);
  const a = analyse(show, threads);
  const map = tryJson(join(opts.scratch, `round-${n}-threads.json`)) ?? {};
  const user = (show.me?.name ?? 'you').split(/\s+/)[0];
  const pr = String(opts.pr);

  // The conductor's own check run on the pushed head, never the fixer's word, gates every Fixed reply.
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
  for (const r of fixer.results) {
    const thread = threadFor(map, a, r.id);
    if (!thread) { posted.push({ id: r.id, skipped: 'no thread for this finding' }); continue; }
    let body; let status; let outcome;
    if (choices && choices[r.id] !== undefined) {
      if (r.decision === 'fixed' && tryGit(opts.repo, ['cat-file', '-t', r.commit ?? 'x']) !== 'commit') { unproven.push({ id: r.id, why: `commit ${r.commit} does not exist` }); continue; }
      body = decidedBody(r, choices[r.id], user, show); status = r.decision === 'fixed' ? 'fixed' : 'closed'; outcome = 'decided';
    } else if (r.decision === 'fixed') {
      const exists = tryGit(opts.repo, ['cat-file', '-t', r.commit ?? 'x']) === 'commit';
      const proven = exists && r.proof?.command && r.proof?.result;
      if (!proven) {
        const why = exists ? 'no proof command and result' : `commit ${r.commit} does not exist`;
        if (!opts['escalate-unproven']) { unproven.push({ id: r.id, why }); continue; }
        body = needsBody({ question: `The fix could not be proven (${why}). Keep it, revert it, or fix it by hand?`, options: ['A: keep it and check by hand (a few minutes)', 'B: revert it and leave the finding open (no risk, finding stays)'], recommendation: 'B' }, user);
        status = 'pending'; outcome = 'needs';
      } else { body = fixedBody(r, show); status = 'fixed'; outcome = 'fixed'; }
    } else if (r.decision === 'declined') {
      body = declinedBody(r); status = (DECLINE[r.declineKind] ?? DECLINE['false-positive']).status; outcome = 'declined';
    } else if (r.decision === 'escalate') {
      body = needsBody(r, user); status = 'pending'; outcome = 'needs';
    } else { posted.push({ id: r.id, skipped: `unknown decision ${r.decision}` }); continue; }
    const key = `pr-babysit:${r.id}-${outcome}`;
    const statusFlag = a.mode === 'review' && thread.human ? [] : ['--status', status];
    host(opts, ['reply', pr, String(thread.threadId), '--key', key, ...statusFlag, '--body-file', bodyFile(opts.scratch, key, body)]);
    posted.push({ id: r.id, outcome, status });
  }
  return { posted, unproven, checks: checks ? checks.status : null, decisions: posted.filter((p) => p.outcome === 'needs').map((p) => p.id) };
}

// ---------------------------------------------------------------------------------------------
// Round summary

function outcomeCell(f, show, fixerById, choices) {
  const r = fixerById[f.id];
  if (f.status === 'pending') return '❓ waiting for a decision';
  if (f.status === 'active') return 'open';
  if (f.replyKeys.some((k) => k.endsWith('-decided'))) return `🧭 ${choices?.[f.id] ? choices[f.id].slice(0, 60) : 'decided'}${r?.commit ? ` · ${commitLink(show, r.commit)}` : ''}`;
  if (f.status === 'fixed') return `✅ ${r?.commit ? commitLink(show, r.commit) : 'fixed'}`;
  if (f.status === 'byDesign') return '↩️ by design';
  if (f.status === 'wontFix') return '↩️ out of scope';
  return '↩️ false positive';
}

// Clean = no review finding at or above the tier's bar, people's confirmed comments included. Build
// threads were fixed before the review started and do not count.
export const isClean = (findings, tier) => !findings.some((f) => f.kind !== 'build' && rank(f.severity) >= rank(tier.severityBar));

export function summaryBody({ n, args, result, findings, show, fixers, choices, next }) {
  const t = args.tier;
  // A decision pass's result (with its commit) wins over the first pass's escalation for the same finding.
  const fixerById = {};
  for (const r of fixers.flatMap((x) => x?.results ?? [])) if (!fixerById[r.id] || r.commit) fixerById[r.id] = r;
  const count = (pred) => findings.filter(pred).length;
  const isDecided = (f) => f.replyKeys.some((k) => k.endsWith('-decided'));
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
      lines.push(`| ${ICON[f.severity]} | [${f.id}](${f.url}) ${f.title.replace(/\|/g, '\\|')} | ${outcomeCell(f, show, fixerById, choices)} |`);
    }
  }
  const above = findings.filter((f) => f.kind !== 'build' && rank(f.severity) >= rank(t.severityBar)).length;
  const clean = isClean(findings, t);
  const nextText = {
    round: `round ${next.round} is next${next.scope === 'delta' ? ', on the fixes only' : ''}`,
    'ask-another': `another round needs your yes`,
    'round-limit': 'the round limit is reached',
    report: 'the review is done',
    'merge-gate': 'the review is done',
  }[next.action] ?? next.why;
  const doneRule = t.cleanRoundsNeeded > 1 ? `${t.cleanRoundsNeeded} clean rounds in a row` : `a round with no ${t.severityBar} finding`;
  if (findings.length) lines.push('', `**${clean ? 'Clean' : `Not clean** (${above} at or above ${t.severityBar})`}${clean ? '**' : ''} → ${nextText}; done after ${doneRule}.`);
  if (result.dropped?.length) {
    lines.push('', `**Disproved before posting:** ${result.dropped.length}`, '');
    for (const d of result.dropped) lines.push(`- \`${d.file}:${d.line}\` ${d.title}: ${String(d.reason).split(' / ')[0]}`);
  }
  if (result.nits?.length) {
    const nitsCommit = fixers.map((x) => x?.nitsCommit).find(Boolean);
    lines.push('', `**Nits:** ${result.nits.length}${nitsCommit ? `, the clear ones fixed in ${commitLink(show, nitsCommit)}` : ', none fixed'}`);
  }
  const reviewed = args.scope === 'delta' && args.repo.sinceSha ? `the fixes since \`${short(args.repo.sinceSha)}\` up to \`${short(args.repo.headSha)}\`` : `\`${short(args.repo.headSha)}\``;
  const reviewers = result.coverage?.reviewers ?? [];
  const skeptics = t.refuters > 0 ? ` · ${t.refuters} skeptic${t.refuters > 1 ? 's' : ''} per major finding, 1 for the minor ones` : '';
  lines.push('', `_Reviewed ${reviewed} · ${reviewers.length} reviewer${reviewers.length === 1 ? '' : 's'}${reviewers.length ? ` (${lensText(reviewers)})` : ''} · ${t.model ?? 'session model'} ${t.effort}${skeptics}_`);
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
  const a = analyse(show, threads);
  const findings = a.findings.filter((f) => f.round === n);
  // Decide what comes after this round as if its summary were already posted.
  const cleanNow = isClean(findings, args.tier);
  const next = nextStep({ ...a, findings: a.findings.filter((f) => f.round !== n), summaries: [...a.summaries.filter((s) => s.round !== n), { round: n, clean: cleanNow, tier: args.tierName }], tier: args.tierName });
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
  const key = `pr-babysit:R${n}-summary`;
  const posted = host(opts, ['thread-create', String(opts.pr), '--key', key, '--status', 'closed', '--body-file', bodyFile(opts.scratch, key, full)]);
  return { posted, clean, next, metrics: metrics?.error ? metrics : { ledger: metrics?.ledger } };
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = { state: cmdState, triage: cmdTriage, args: cmdArgs, record: cmdRecord, reply: cmdReply, summary: cmdSummary };

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
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
