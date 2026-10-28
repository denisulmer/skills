#!/usr/bin/env node
// Azure DevOps pull-request operations over the REST API, shaped for agents.
//
// Auth: AZURE_DEVOPS_EXT_PAT or ADO_PAT (Basic), otherwise a token from the signed-in Azure CLI.
// The PR comes from a pull-request URL, or from an id plus the `origin` remote of the current directory.
// Every command prints JSON on stdout, except `watch`, which prints one plain line per event for Monitor.
// Failures print to stderr and exit 1.

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API = '7.1';
const DESCRIPTION_LIMIT = 4000;
const THREAD_STATUSES = ['active', 'pending', 'fixed', 'wontFix', 'byDesign', 'closed'];
const MERGE_STRATEGIES = ['noFastForward', 'squash', 'rebase', 'rebaseMerge'];
const VOTES = { 10: 'approved', 5: 'approved-with-suggestions', 0: 'none', [-5]: 'waiting-for-author', [-10]: 'rejected' };
const keyMarker = (key) => `<!-- ado-pr key=${key} -->`;
const KEY_PATTERN = /<!-- ado-pr key=(\S+) -->/;

const USAGE = `ado-pr <command> [args]

  context [pr]                         org/project/repo, signed-in user, PR web URL
  find --branch <name>                 active PR whose source branch is <name>
  show <pr>                            PR summary (author, branches, commits, merge status, reviewers)
  threads <pr> [--all]                 comment threads; kind = bot (has a key), human, or system (--all)
  thread-create <pr> --body-file F [--key K] [--file P --line N [--end-line M]] [--status S]
  reply <pr> <threadId> --body-file F [--key K] [--status S]
  set-status <pr> <threadId> <status>  status: ${THREAD_STATUSES.join(' | ')}
  set-description <pr> --body-file F  fails above ${DESCRIPTION_LIMIT} characters
  publish <pr>                         draft -> published
  policies <pr>                        branch-policy evaluations (build validation, reviewers, ...)
  requeue-policy <pr> <evaluationId>   re-run one policy evaluation (e.g. a flaky build)
  build-failures <buildId> [--tail N]  failed tasks of a build with the last N log lines (default 80)
  autocomplete <pr> [--strategy S] [--keep-source-branch] [--message M]
                                       strategy: ${MERGE_STRATEGIES.join(' | ')} (default noFastForward)
  cancel-autocomplete <pr>
  watch <pr> [--interval SECONDS]      poll and print one line per change; exits when the PR is no longer active

  <pr> is a pull-request id or URL. --body-file - reads stdin; --body "text" passes text inline.
  --key makes a create or reply idempotent: a thread or comment that already carries the key is returned, not posted again.
  ADO_PR_DRY_RUN=<dir> logs every write to <dir>/requests.jsonl instead of sending it; reads stay live.`;

class UsageError extends Error {}

function parseArgs(argv) {
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
    if (next === undefined || next.startsWith('--')) opts[name] = true;
    else {
      opts[name] = next;
      i++;
    }
  }
  return { pos, opts };
}

function sh(command) {
  return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------
// Context

function parseRemote(url) {
  const patterns = [
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/,
    /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/,
    /([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return { org: match[1], project: decodeURIComponent(match[2]), repo: decodeURIComponent(match[3]) };
  }
  return null;
}

function resolveContext(prArg, opts) {
  let ctx;
  let prId;
  if (prArg && /^https?:\/\//.test(prArg)) {
    ctx = parseRemote(prArg);
    prId = prArg.match(/pullrequest\/(\d+)/i)?.[1];
    if (!ctx || !prId) throw new UsageError(`not an Azure DevOps pull-request URL: ${prArg}`);
  } else {
    if (prArg !== undefined && !/^\d+$/.test(prArg)) throw new UsageError(`not a pull-request id or URL: ${prArg}`);
    prId = prArg;
    let remote = '';
    try {
      remote = sh('git remote get-url origin');
    } catch {
      // Fall through to the explicit options below.
    }
    ctx = parseRemote(remote) ?? {};
  }
  ctx = { org: opts.org ?? ctx.org, project: opts.project ?? ctx.project, repo: opts.repo ?? ctx.repo };
  if (!ctx.org || !ctx.project || !ctx.repo) {
    throw new UsageError('cannot tell the organization, project and repository: pass a PR URL, run inside an Azure Repos checkout, or pass --org --project --repo');
  }
  return { ...ctx, prId: prId === undefined ? undefined : Number(prId) };
}

const orgUrl = (c) => `https://dev.azure.com/${enc(c.org)}`;
const projectUrl = (c) => `${orgUrl(c)}/${enc(c.project)}`;
const repoApi = (c) => `${projectUrl(c)}/_apis/git/repositories/${enc(c.repo)}`;
const prApi = (c) => `${repoApi(c)}/pullRequests/${c.prId}`;
const repoWebUrl = (c) => `${projectUrl(c)}/_git/${enc(c.repo)}`;
const prWebUrl = (c) => `${repoWebUrl(c)}/pullrequest/${c.prId}`;

function requirePr(c) {
  if (!c.prId) throw new UsageError('this command needs a pull-request id or URL');
}

// ---------------------------------------------------------------------------------------------
// HTTP

let authHeader;
function auth() {
  if (authHeader) return authHeader;
  const pat = process.env.AZURE_DEVOPS_EXT_PAT || process.env.ADO_PAT;
  if (pat) {
    authHeader = `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
    return authHeader;
  }
  let token;
  try {
    token = sh(`az account get-access-token --resource ${ADO_RESOURCE} --query accessToken -o tsv`);
  } catch (error) {
    throw new Error(`no Azure DevOps credentials: set AZURE_DEVOPS_EXT_PAT or run "az login" (${error.message.split('\n')[0]})`);
  }
  authHeader = `Bearer ${token}`;
  return authHeader;
}

// Rehearsal: with ADO_PR_DRY_RUN=<directory>, writes are appended to <directory>/requests.jsonl instead of
// being sent, and answered with a synthetic response. Reads still go to Azure DevOps.
const DRY_RUN_DIR = process.env.ADO_PR_DRY_RUN || null;
function dryRun(method, url, body) {
  mkdirSync(DRY_RUN_DIR, { recursive: true });
  const log = join(DRY_RUN_DIR, 'requests.jsonl');
  const id = 900000 + (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  appendFileSync(log, `${JSON.stringify({ id, method, url, body })}\n`);
  return { ...body, id, status: body?.status ?? 'queued', dryRun: true };
}

async function ado(method, url, body, accept = 'application/json') {
  if (DRY_RUN_DIR && method !== 'GET') return dryRun(method, url, body);
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      method,
      headers: { Authorization: auth(), Accept: accept, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) {
      if (response.status === 204) return null;
      return accept === 'application/json' ? response.json() : response.text();
    }
    const text = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 600)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Shapes

const person = (identity) =>
  identity ? { id: identity.id, name: identity.displayName, uniqueName: identity.uniqueName ?? null } : null;

let cachedMe;
async function me(c) {
  if (cachedMe) return cachedMe;
  const data = await ado('GET', `${orgUrl(c)}/_apis/connectionData`);
  const user = data.authenticatedUser;
  cachedMe = { id: user.id, name: user.providerDisplayName, uniqueName: user.properties?.Account?.$value ?? null };
  return cachedMe;
}

function summarizePr(c, pr, self) {
  const branch = (ref) => (ref ?? '').replace(/^refs\/heads\//, '');
  return {
    id: pr.pullRequestId,
    title: pr.title,
    description: pr.description ?? '',
    status: pr.status,
    isDraft: !!pr.isDraft,
    author: person(pr.createdBy),
    isMine: pr.createdBy?.id === self.id,
    sourceBranch: branch(pr.sourceRefName),
    targetBranch: branch(pr.targetRefName),
    sourceCommit: pr.lastMergeSourceCommit?.commitId ?? null,
    targetCommit: pr.lastMergeTargetCommit?.commitId ?? null,
    mergeCommit: pr.lastMergeCommit?.commitId ?? null,
    mergeStatus: pr.mergeStatus ?? null,
    autoComplete: pr.autoCompleteSetBy ? person(pr.autoCompleteSetBy) : null,
    completionOptions: pr.completionOptions ?? null,
    reviewers: (pr.reviewers ?? []).map((r) => ({ name: r.displayName, vote: VOTES[r.vote] ?? r.vote, isRequired: !!r.isRequired })),
    org: c.org,
    project: c.project,
    projectId: pr.repository?.project?.id ?? null,
    repo: c.repo,
    webUrl: prWebUrl(c),
    repoWebUrl: repoWebUrl(c),
    me: self,
  };
}

function summarizeThread(c, thread, self) {
  const comments = (thread.comments ?? [])
    .filter((comment) => !comment.isDeleted)
    .map((comment) => ({
      id: comment.id,
      parentId: comment.parentCommentId,
      author: comment.author?.displayName ?? null,
      authorId: comment.author?.id ?? null,
      isMine: comment.author?.id === self.id,
      type: comment.commentType,
      key: (comment.content ?? '').match(KEY_PATTERN)?.[1] ?? null,
      content: comment.content ?? '',
      published: comment.publishedDate,
    }));
  const context = thread.threadContext;
  const key = comments[0]?.key ?? null;
  const isSystem = comments.length > 0 && comments.every((comment) => comment.type === 'system');
  return {
    id: thread.id,
    kind: isSystem ? 'system' : key ? 'bot' : 'human',
    key,
    status: thread.status ?? 'unknown',
    file: context?.filePath ?? null,
    line: context?.rightFileStart?.line ?? context?.leftFileStart?.line ?? null,
    url: `${prWebUrl(c)}?discussionId=${thread.id}`,
    comments,
    updated: thread.lastUpdatedDate,
  };
}

async function readThreads(c, self) {
  const data = await ado('GET', `${prApi(c)}/threads?api-version=${API}`);
  return data.value.filter((thread) => !thread.isDeleted).map((thread) => summarizeThread(c, thread, self));
}

function readBody(opts) {
  if (typeof opts.body === 'string') return opts.body;
  if (typeof opts['body-file'] === 'string') {
    return readFileSync(opts['body-file'] === '-' ? 0 : opts['body-file'], 'utf8').replace(/\s+$/, '');
  }
  throw new UsageError('pass --body-file <path> (or - for stdin) or --body "<text>"');
}

function checkStatus(status) {
  if (!THREAD_STATUSES.includes(status)) throw new UsageError(`unknown thread status "${status}"; use ${THREAD_STATUSES.join(', ')}`);
  return status;
}

// ---------------------------------------------------------------------------------------------
// Commands

async function policyEvaluations(c, projectId) {
  const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId}/${c.prId}`;
  const data = await ado('GET', `${projectUrl(c)}/_apis/policy/evaluations?artifactId=${enc(artifact)}&api-version=${API}-preview.1`);
  return data.value.map((evaluation) => ({
    evaluationId: evaluation.evaluationId,
    name: evaluation.configuration?.settings?.displayName || evaluation.configuration?.type?.displayName,
    type: evaluation.configuration?.type?.displayName ?? null,
    isBlocking: !!evaluation.configuration?.isBlocking,
    status: evaluation.status,
    buildId: evaluation.context?.buildId ?? null,
    isExpired: evaluation.context?.isExpired ?? null,
  }));
}

const commands = {
  async context(c) {
    const self = await me(c);
    return { org: c.org, project: c.project, repo: c.repo, prId: c.prId ?? null, prWebUrl: c.prId ? prWebUrl(c) : null, repoWebUrl: repoWebUrl(c), me: self };
  },

  async find(c, _pos, opts) {
    if (typeof opts.branch !== 'string') throw new UsageError('find needs --branch <name>');
    const ref = opts.branch.startsWith('refs/') ? opts.branch : `refs/heads/${opts.branch}`;
    const data = await ado('GET', `${repoApi(c)}/pullrequests?searchCriteria.sourceRefName=${enc(ref)}&searchCriteria.status=active&api-version=${API}`);
    return data.value.map((pr) => ({ id: pr.pullRequestId, title: pr.title, isDraft: !!pr.isDraft, webUrl: prWebUrl({ ...c, prId: pr.pullRequestId }) }));
  },

  async show(c) {
    requirePr(c);
    const [pr, self] = await Promise.all([ado('GET', `${prApi(c)}?api-version=${API}`), me(c)]);
    return summarizePr(c, pr, self);
  },

  async threads(c, _pos, opts) {
    requirePr(c);
    const threads = await readThreads(c, await me(c));
    return opts.all ? threads : threads.filter((thread) => thread.kind !== 'system');
  },

  async 'thread-create'(c, _pos, opts) {
    requirePr(c);
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    if (key) {
      const existing = (await readThreads(c, await me(c))).find((thread) => thread.key === key);
      if (existing) return { existing: true, id: existing.id, status: existing.status, url: existing.url };
    }
    const payload = {
      comments: [{ parentCommentId: 0, content: key ? `${body}\n\n${keyMarker(key)}` : body, commentType: 1 }],
      status: checkStatus(typeof opts.status === 'string' ? opts.status : 'active'),
    };
    if (typeof opts.file === 'string') {
      const line = Number(opts.line ?? 1);
      const endLine = Number(opts['end-line'] ?? line);
      if (!Number.isInteger(line) || line < 1 || !Number.isInteger(endLine) || endLine < line) throw new UsageError('--line and --end-line must be positive line numbers, end >= start');
      payload.threadContext = {
        filePath: opts.file.startsWith('/') ? opts.file : `/${opts.file}`,
        rightFileStart: { line, offset: 1 },
        rightFileEnd: { line: endLine, offset: 1 },
      };
    }
    const thread = await ado('POST', `${prApi(c)}/threads?api-version=${API}`, payload);
    return { existing: false, id: thread.id, status: thread.status, url: `${prWebUrl(c)}?discussionId=${thread.id}` };
  },

  async reply(c, pos, opts) {
    requirePr(c);
    const threadId = Number(pos[1]);
    if (!threadId) throw new UsageError('reply needs <pr> <threadId>');
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    const status = typeof opts.status === 'string' ? checkStatus(opts.status) : null;
    if (key) {
      const thread = await ado('GET', `${prApi(c)}/threads/${threadId}?api-version=${API}`);
      if ((thread.comments ?? []).some((comment) => !comment.isDeleted && (comment.content ?? '').includes(keyMarker(key)))) {
        if (status && thread.status !== status) await ado('PATCH', `${prApi(c)}/threads/${threadId}?api-version=${API}`, { status });
        return { existing: true, threadId, status: status ?? thread.status };
      }
    }
    const comment = await ado('POST', `${prApi(c)}/threads/${threadId}/comments?api-version=${API}`, {
      content: key ? `${body}\n\n${keyMarker(key)}` : body,
      parentCommentId: 1,
      commentType: 1,
    });
    if (status) await ado('PATCH', `${prApi(c)}/threads/${threadId}?api-version=${API}`, { status });
    return { existing: false, threadId, commentId: comment.id, status };
  },

  async 'set-status'(c, pos) {
    requirePr(c);
    const threadId = Number(pos[1]);
    const status = checkStatus(pos[2]);
    if (!threadId) throw new UsageError('set-status needs <pr> <threadId> <status>');
    const thread = await ado('PATCH', `${prApi(c)}/threads/${threadId}?api-version=${API}`, { status });
    return { threadId, status: thread.status };
  },

  async 'set-description'(c, _pos, opts) {
    requirePr(c);
    const description = readBody(opts);
    if (description.length > DESCRIPTION_LIMIT) {
      throw new UsageError(`description is ${description.length} characters; Azure DevOps keeps at most ${DESCRIPTION_LIMIT}. Shorten it and move detail into a thread.`);
    }
    await ado('PATCH', `${prApi(c)}?api-version=${API}`, { description });
    return { id: c.prId, length: description.length };
  },

  async publish(c) {
    requirePr(c);
    const pr = await ado('PATCH', `${prApi(c)}?api-version=${API}`, { isDraft: false });
    return { id: c.prId, isDraft: !!pr.isDraft };
  },

  async policies(c) {
    requirePr(c);
    const pr = await ado('GET', `${prApi(c)}?api-version=${API}`);
    return policyEvaluations(c, pr.repository.project.id);
  },

  async 'requeue-policy'(c, pos) {
    requirePr(c);
    const evaluationId = pos[1];
    if (!evaluationId) throw new UsageError('requeue-policy needs <pr> <evaluationId>');
    const evaluation = await ado('PATCH', `${projectUrl(c)}/_apis/policy/evaluations/${enc(evaluationId)}?api-version=${API}-preview.1`);
    return { evaluationId, status: evaluation.status };
  },

  async 'build-failures'(c, pos, opts) {
    const buildId = Number(pos[0]);
    if (!buildId) throw new UsageError('build-failures needs <buildId>');
    const tail = Number(opts.tail ?? 80);
    const base = `${projectUrl(c)}/_apis/build/builds/${buildId}`;
    const [build, timeline] = await Promise.all([ado('GET', `${base}?api-version=${API}`), ado('GET', `${base}/timeline?api-version=${API}`)]);
    const failed = (timeline?.records ?? []).filter((record) => record.result === 'failed' && record.type === 'Task');
    const tasks = [];
    for (const record of failed) {
      let logTail = '';
      if (record.log?.url) logTail = (await ado('GET', record.log.url, undefined, 'text/plain')).split(/\r?\n/).slice(-tail).join('\n');
      tasks.push({ name: record.name, issues: (record.issues ?? []).map((issue) => issue.message), logTail });
    }
    return { buildId, status: build.status, result: build.result ?? null, sourceVersion: build.sourceVersion, url: build._links?.web?.href ?? null, failedTasks: tasks };
  },

  async autocomplete(c, _pos, opts) {
    requirePr(c);
    const strategy = typeof opts.strategy === 'string' ? opts.strategy : 'noFastForward';
    if (!MERGE_STRATEGIES.includes(strategy)) throw new UsageError(`unknown merge strategy "${strategy}"; use ${MERGE_STRATEGIES.join(', ')}`);
    const self = await me(c);
    const completionOptions = { mergeStrategy: strategy, deleteSourceBranch: !opts['keep-source-branch'], transitionWorkItems: true };
    if (typeof opts.message === 'string') completionOptions.mergeCommitMessage = opts.message;
    const pr = await ado('PATCH', `${prApi(c)}?api-version=${API}`, { autoCompleteSetBy: { id: self.id }, completionOptions });
    return { id: c.prId, autoComplete: person(pr.autoCompleteSetBy), completionOptions: pr.completionOptions };
  },

  async 'cancel-autocomplete'(c) {
    requirePr(c);
    const pr = await ado('PATCH', `${prApi(c)}?api-version=${API}`, { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } });
    return { id: c.prId, autoComplete: person(pr.autoCompleteSetBy) };
  },

  async watch(c, _pos, opts) {
    requirePr(c);
    const interval = Math.max(15, Number(opts.interval ?? 60)) * 1000;
    const self = await me(c);
    let previous = null;
    const seenComments = new Set();
    for (let first = true; ; first = false) {
      try {
        const pr = await ado('GET', `${prApi(c)}?api-version=${API}`);
        const [evaluations, threads] = await Promise.all([policyEvaluations(c, pr.repository.project.id), readThreads(c, self)]);
        const state = {
          status: pr.status,
          mergeStatus: pr.mergeStatus ?? 'unknown',
          autoComplete: pr.autoCompleteSetBy ? 'set' : 'off',
          draft: pr.isDraft ? 'yes' : 'no',
          ...Object.fromEntries(evaluations.map((e) => [`policy "${e.name}"`, `${e.status}${e.buildId ? ` build=${e.buildId}` : ''}`])),
        };
        const humanComments = threads
          .filter((thread) => thread.kind === 'human')
          .flatMap((thread) => thread.comments.filter((comment) => comment.type !== 'system').map((comment) => ({ thread, comment })));
        if (first) {
          console.log(`watching PR ${c.prId}: ${Object.entries(state).map(([k, v]) => `${k}=${v}`).join(', ')}`);
          humanComments.forEach(({ comment }) => seenComments.add(comment.id));
        } else {
          for (const [key, value] of Object.entries(state)) {
            if (previous[key] !== value) console.log(`${key}: ${previous[key] ?? 'none'} -> ${value}`);
          }
          for (const { thread, comment } of humanComments) {
            if (seenComments.has(comment.id)) continue;
            seenComments.add(comment.id);
            const where = thread.file ? ` at ${thread.file}:${thread.line}` : '';
            console.log(`new comment by ${comment.author} on thread ${thread.id}${where}`);
          }
        }
        previous = state;
        if (pr.status !== 'active') {
          console.log(`pr finished: ${pr.status}`);
          return undefined;
        }
      } catch (error) {
        console.log(`watch error, retrying: ${error.message.slice(0, 200)}`);
      }
      await sleep(interval);
    }
  },
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const handler = commands[command];
  if (!handler) throw new UsageError(`unknown command "${command}"`);
  const { pos, opts } = parseArgs(rest);
  const prArg = command === 'build-failures' || command === 'find' ? undefined : pos[0];
  const c = resolveContext(prArg, opts);
  const result = await handler(c, pos, opts);
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error.message);
  process.exit(1);
});
