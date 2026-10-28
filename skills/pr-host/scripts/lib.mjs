// Plumbing shared by pr-host and its platform adapters: arguments, shell, HTTP with retries and
// rehearsal, the hidden marker that makes posting idempotent, and the watch loop.

import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class UsageError extends Error {}

// Thread statuses are Azure DevOps' six, the richest set. GitHub and GitLab only know resolved or not:
// there the exact status rides in the marker and the thread is resolved for the RESOLVED ones.
export const THREAD_STATUSES = ['active', 'pending', 'fixed', 'wontFix', 'byDesign', 'closed'];
export const RESOLVED_STATUSES = ['fixed', 'wontFix', 'byDesign', 'closed'];
export const MERGE_STRATEGIES = ['merge', 'squash', 'rebase', 'rebase-merge'];
const STRATEGY_ALIASES = { noFastForward: 'merge', rebaseMerge: 'rebase-merge' };
// Check statuses every adapter reports: queued | running | passed | failed | skipped.

// Flags that never take a value, so `merge --keep-source-branch 12` keeps 12 as the PR.
const BOOLEAN_FLAGS = new Set(['all', 'keep-source-branch', 'draft']);

export function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      pos.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith('--')) opts[name] = true;
    else {
      opts[name] = next;
      i++;
    }
  }
  return { pos, opts };
}

export function sh(command, options = {}) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

// Trailing whitespace only: a leading space is meaningful in `git status --porcelain`.
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).replace(/\s+$/, '');
}

export function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const enc = encodeURIComponent;

export function readBody(opts) {
  let body = null;
  if (typeof opts.body === 'string') body = opts.body;
  else if (typeof opts['body-file'] === 'string') body = readFileSync(opts['body-file'] === '-' ? 0 : opts['body-file'], 'utf8').replace(/\s+$/, '');
  else throw new UsageError('pass --body-file <path> (or - for stdin) or --body "<text>"');
  if (!body.trim()) throw new UsageError('the body is empty');
  return body;
}

export function checkStatus(status) {
  if (!THREAD_STATUSES.includes(status)) throw new UsageError(`unknown thread status "${status}"; use ${THREAD_STATUSES.join(', ')}`);
  return status;
}

export function optionalStatus(opts) {
  return typeof opts.status === 'string' ? checkStatus(opts.status) : null;
}

export function normalizeStrategy(value, fallback = 'merge') {
  if (typeof value !== 'string') return fallback;
  const strategy = STRATEGY_ALIASES[value] ?? value;
  if (!MERGE_STRATEGIES.includes(strategy)) throw new UsageError(`unknown merge strategy "${value}"; use ${MERGE_STRATEGIES.join(', ')}`);
  return strategy;
}

export function lineRange(opts) {
  if (opts.line === undefined) throw new UsageError('--file needs --line <n>');
  const line = Number(opts.line);
  const endLine = Number(opts['end-line'] ?? line);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(endLine) || endLine < line) {
    throw new UsageError('--line and --end-line must be positive line numbers, end >= start');
  }
  return { line, endLine };
}

export function requirePr(c) {
  if (!c.prId) throw new UsageError('this command needs a pull-request id or URL');
}

// ---------------------------------------------------------------------------------------------
// Marker: <!-- pr-host key=K status=S reply-to=T --> at the end of a comment, invisible when rendered.
// Comments written by the older ado-pr script carry <!-- ado-pr key=K -->, which still reads.

const MARKER = /<!-- (?:pr-host|ado-pr) ([^>]*?) -->/;

export function readMarker(content) {
  const fields = Object.fromEntries(
    [...((content ?? '').match(MARKER)?.[1] ?? '').matchAll(/([\w-]+)=(\S+)/g)].map((m) => [m[1], m[2]]),
  );
  return { key: fields.key ?? null, status: fields.status ?? null, replyTo: fields['reply-to'] ?? null };
}

export function withMarker(body, { key, status, replyTo } = {}) {
  const fields = [key && `key=${key}`, status && `status=${status}`, replyTo && `reply-to=${replyTo}`].filter(Boolean);
  const stripped = body.replace(MARKER, '').replace(/\s+$/, '');
  return fields.length ? `${stripped}\n\n<!-- pr-host ${fields.join(' ')} -->` : stripped;
}

export const hasKey = (content, key) => readMarker(content).key === key;

// Status of a thread on a host that only knows resolved / unresolved: the latest status a marker set,
// unless a person has since resolved or reopened the thread natively, which wins.
export function deriveStatus(comments, resolved) {
  const marked = [...comments].reverse().map((comment) => readMarker(comment.content).status).find(Boolean) ?? null;
  if (resolved === true) return marked && RESOLVED_STATUSES.includes(marked) ? marked : 'closed';
  if (resolved === false) return marked && !RESOLVED_STATUSES.includes(marked) ? marked : 'active';
  return marked ?? 'active';
}

// ---------------------------------------------------------------------------------------------
// HTTP. Rehearsal: with PR_HOST_DRY_RUN=<directory> (ADO_PR_DRY_RUN also works), writes are appended to
// <directory>/requests.jsonl instead of being sent, and answered with a synthetic response.

const DRY_RUN_DIR = process.env.PR_HOST_DRY_RUN || process.env.ADO_PR_DRY_RUN || null;
export const isDryRun = () => !!DRY_RUN_DIR;

export function logDryRun(entry) {
  mkdirSync(DRY_RUN_DIR, { recursive: true });
  const log = join(DRY_RUN_DIR, 'requests.jsonl');
  const id = 900000 + (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  appendFileSync(log, `${JSON.stringify({ id, ...entry })}\n`);
  return id;
}

// `write` defaults to every method but GET; pass write: false for a POST that only reads (GraphQL queries).
export async function request(method, url, { headers = {}, body, accept = 'application/json', write = method !== 'GET' } = {}) {
  if (DRY_RUN_DIR && write) {
    const id = logDryRun({ method, url, body });
    return { ...(body && typeof body === 'object' ? body : {}), id, status: body?.status ?? 'queued', dryRun: true };
  }
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: { Accept: accept, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) {
      const text = await response.text();
      if (accept !== 'application/json') return text;
      return text ? JSON.parse(text) : null;
    }
    const text = await response.text();
    // A write is retried only when the server says it did nothing (429, or GitHub's secondary rate limit:
    // 403 with Retry-After): after a 5xx it may have succeeded, and a second POST would post twice.
    const retryAfter = Number(response.headers.get('retry-after'));
    const rateLimited = response.status === 429 || (response.status === 403 && retryAfter > 0);
    if ((rateLimited || (response.status >= 500 && !write)) && attempt < 4) {
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2000 * attempt);
      continue;
    }
    const error = new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 600)}`);
    error.status = response.status;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Watch: poll a snapshot and print one plain line per change, for Monitor. The snapshot is
// { status, state: { name: value }, comments: [{ id, author, threadId, file, line }] }, where comments
// are people's comments (not marked ones). Exits when status is no longer active.

export async function watchLoop(prId, intervalSeconds, snapshot) {
  const interval = Math.max(15, Number(intervalSeconds ?? 60)) * 1000;
  let previous = null;
  const seen = new Set();
  for (;;) {
    try {
      const { status, state, comments } = await snapshot();
      if (previous === null) {
        console.log(`watching PR ${prId}: ${Object.entries(state).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        comments.forEach((comment) => seen.add(`${comment.threadId}/${comment.id}`));
      } else {
        for (const key of new Set([...Object.keys(previous), ...Object.keys(state)])) {
          if (previous[key] !== state[key]) console.log(`${key}: ${previous[key] ?? 'none'} -> ${state[key] ?? 'none'}`);
        }
        // Comment ids are only unique per thread on Azure DevOps.
        for (const comment of comments) {
          if (seen.has(`${comment.threadId}/${comment.id}`)) continue;
          seen.add(`${comment.threadId}/${comment.id}`);
          const where = comment.file ? ` at ${comment.file}:${comment.line}` : '';
          console.log(`new comment by ${comment.author} on thread ${comment.threadId}${where}`);
        }
      }
      previous = state;
      if (status !== 'active') {
        console.log(`pr finished: ${status}`);
        return;
      }
    } catch (error) {
      console.log(`watch error, retrying: ${error.message.slice(0, 200)}`);
    }
    await sleep(interval);
  }
}

// The state keys every adapter's snapshot uses, so watch lines read the same everywhere.
export function watchState({ status, mergeStatus, autoMerge, isDraft }, checks) {
  return {
    status,
    mergeStatus: mergeStatus ?? 'unknown',
    autoMerge: autoMerge ? 'set' : 'off',
    draft: isDraft ? 'yes' : 'no',
    ...Object.fromEntries(checks.map((check) => [`check "${check.name}"`, `${check.status}${check.runId ? ` run=${check.runId}` : ''}`])),
  };
}

export function peopleComments(threads) {
  return threads
    .filter((thread) => thread.kind !== 'system')
    .flatMap((thread) =>
      thread.comments
        .filter((comment) => !comment.key && comment.type !== 'system')
        .map((comment) => ({ id: comment.id, author: comment.author, threadId: thread.id, file: thread.file, line: thread.line })),
    );
}
