// GitHub (github.com and GitHub Enterprise Server) over the REST and GraphQL APIs. Auth: GH_TOKEN or
// GITHUB_TOKEN on github.com, GH_ENTERPRISE_TOKEN or GITHUB_ENTERPRISE_TOKEN on another host, otherwise a
// token from the signed-in GitHub CLI.
//
// Threads are three kinds of GitHub conversation in one list: review threads on diff lines (id = the
// GraphQL node id, resolvable), conversation comments (ic-<commentId>) and review bodies (rv-<reviewId>).
// The last two have neither replies nor resolution: a reply is a new conversation comment whose marker
// says reply-to=<threadId>, and their status lives only in markers.

import { execFileSync } from 'node:child_process';
import {
  RESOLVED_STATUSES, UsageError, checkStatus, deriveStatus, enc, lineRange, normalizeStrategy, optionalStatus,
  peopleComments, readBody, readMarker, request, requirePr, sleep, watchLoop, watchState, withMarker,
} from '../lib.mjs';

export const platform = 'github';

const DESCRIPTION_LIMIT = 65536;
const VOTES = { APPROVED: 'approved', CHANGES_REQUESTED: 'waiting-for-author' };
const FROM_GH_STRATEGY = { MERGE: 'merge', SQUASH: 'squash', REBASE: 'rebase' };
const MERGEABLE_STATES = ['clean', 'blocked', 'behind', 'unstable', 'has_hooks'];
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const FAILED_JOB = ['failure', 'timed_out', 'startup_failure'];
const STATUS_STATE = { SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', PENDING: 'running', EXPECTED: 'queued' };
const REVIEW_DECISION = { APPROVED: 'passed', CHANGES_REQUESTED: 'failed', REVIEW_REQUIRED: 'queued' };
const HOST = /^[a-z0-9.-]+(:\d+)?$/i;

// ---------------------------------------------------------------------------------------------
// Context

function toContext(host, owner, repo) {
  const name = host.toLowerCase().replace(/^(www|ssh)\.github\.com$/, 'github.com');
  return HOST.test(name) && owner && repo ? { host: name, owner, repo } : null;
}

// https://[user@]host/o/r[.git], ssh://[user@]host[:port]/o/r[.git] and the scp form [user@]host:o/r[.git].
function parse(url) {
  const text = (url ?? '').trim();
  const match =
    text.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    text.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    text.match(/^(?:[^@/:]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? toContext(match[1], match[2], match[3]) : null;
}

export function fromRemote(url, { forced }) {
  const parsed = parse(url);
  if (parsed && (forced || parsed.host === 'github.com')) return parsed;
  if (!forced) return null;
  throw new UsageError('cannot tell the owner and repository: pass a PR URL or run inside a checkout whose remote is on GitHub');
}

export function fromPrUrl(url) {
  const match = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/);
  const parsed = match && toContext(match[1], match[2], match[3]);
  return parsed ? { ...parsed, prId: Number(match[4]) } : null;
}

const apiUrl = (c) => (c.host === 'github.com' ? 'https://api.github.com' : `https://${c.host}/api/v3`);
const graphqlUrl = (c) => (c.host === 'github.com' ? 'https://api.github.com/graphql' : `https://${c.host}/api/graphql`);
const repoApi = (c) => `${apiUrl(c)}/repos/${enc(c.owner)}/${enc(c.repo)}`;
const repoWebUrl = (c) => `https://${c.host}/${c.owner}/${c.repo}`;
const prWebUrl = (c) => `${repoWebUrl(c)}/pull/${c.prId}`;

// ---------------------------------------------------------------------------------------------
// HTTP

let token;
function auth(c) {
  if (token) return token;
  const names = c.host === 'github.com' ? ['GH_TOKEN', 'GITHUB_TOKEN'] : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  token = names.map((name) => process.env[name]).find(Boolean);
  if (token) return token;
  try {
    token = execFileSync('gh', ['auth', 'token', '--hostname', c.host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const reason = String(error.stderr || error.message).trim().split('\n')[0];
    throw new Error(`no GitHub credentials for ${c.host}: run "gh auth login --hostname ${c.host}" or set ${names[0]} (${reason})`);
  }
  return token;
}

const headers = (c) => ({ Authorization: `Bearer ${auth(c)}`, 'User-Agent': 'pr-host' });

// `path` is relative to the repository API, or a full URL.
const gh = (c, method, path, body) => request(method, path.startsWith('https://') ? path : `${repoApi(c)}${path}`, { headers: headers(c), body });

async function paged(c, path, key) {
  const items = [];
  for (let page = 1; ; page++) {
    const data = await gh(c, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = key ? data[key] : data;
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

// Queries pass write: false so they run under PR_HOST_DRY_RUN; a rehearsed mutation answers { dryRun: true }.
async function graphql(c, query, variables, { write = false } = {}) {
  const response = await request('POST', graphqlUrl(c), { headers: headers(c), body: { query, variables }, write });
  if (response?.dryRun) return { dryRun: true };
  if (response.errors?.length) throw new Error(`GitHub GraphQL: ${response.errors.map((error) => error.message).join('; ')}`);
  return response.data;
}

const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved path line originalLine
        comments(first: 100) { nodes { databaseId body author { login } createdAt updatedAt url } } } } } } }`;

const CHECKS = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
          checkSuite { workflowRun { databaseId workflow { name } } } }
        ... on StatusContext { context state targetUrl isRequired(pullRequestNumber: $number) } } } } } } } } } }`;

const SETTINGS = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { autoMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod } }`;

const RESOLVE = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }';
const REOPEN = 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }';
const READY = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
const ENABLE_AUTO_MERGE = `mutation($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) { pullRequest { autoMergeRequest { mergeMethod } } } }`;
const DISABLE_AUTO_MERGE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { autoMergeRequest { mergeMethod } } } }`;

// ---------------------------------------------------------------------------------------------
// Shapes

const person = (user) => (user ? { id: user.id, name: user.login } : null);

let cachedMe;
async function me(c) {
  if (cachedMe) return cachedMe;
  const user = await gh(c, 'GET', `${apiUrl(c)}/user`);
  cachedMe = { id: user.id, name: user.login };
  return cachedMe;
}

// Read by everyone through GraphQL; REST shows these only to people who can push.
let cachedSettings;
async function settings(c) {
  cachedSettings ??= (await graphql(c, SETTINGS, { owner: c.owner, repo: c.repo })).repository;
  return cachedSettings;
}

function mergeStatus(pr) {
  if (pr.state !== 'open') return 'unknown';
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') return 'conflicts';
  if (pr.mergeable === null || pr.mergeable_state === 'unknown') return 'checking';
  return MERGEABLE_STATES.includes(pr.mergeable_state) || pr.mergeable ? 'ok' : 'unknown';
}

// Requested reviewers wait; a review's verdict stands until the same person approves, requests changes
// or is dismissed (a later plain comment does not change it). The author's own replies are reviews too.
function reviewers(c, pr, reviews) {
  const votes = new Map();
  for (const user of pr.requested_reviewers ?? []) votes.set(user.login, 'none');
  for (const team of pr.requested_teams ?? []) votes.set(`${c.owner}/${team.slug}`, 'none');
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login || login === pr.user?.login || review.state === 'PENDING') continue;
    if (review.state === 'COMMENTED' && votes.has(login)) continue;
    votes.set(login, VOTES[review.state] ?? 'none');
  }
  return [...votes].map(([name, vote]) => ({ name, vote, isRequired: false }));
}

function summarizePr(c, pr, reviews, self, repo) {
  return {
    platform,
    id: pr.number,
    title: pr.title,
    description: pr.body ?? '',
    status: pr.state === 'open' ? 'active' : pr.merged_at ? 'completed' : 'abandoned',
    isDraft: !!pr.draft,
    author: person(pr.user),
    isMine: pr.user?.login === self.name,
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    sourceCommit: pr.head.sha,
    targetCommit: pr.base.sha,
    mergeCommit: pr.merge_commit_sha ?? null,
    mergeStatus: mergeStatus(pr),
    mergeStatusRaw: pr.mergeable_state ?? null,
    autoMerge: pr.auto_merge
      ? { by: person(pr.auto_merge.enabled_by), strategy: pr.auto_merge.merge_method, deleteSourceBranch: !!repo?.deleteBranchOnMerge }
      : null,
    reviewers: reviewers(c, pr, reviews),
    limits: { description: DESCRIPTION_LIMIT },
    webUrl: pr.html_url,
    repoWebUrl: repoWebUrl(c),
    me: self,
  };
}

const kindOf = (threadId) => (threadId.startsWith('ic-') ? 'comment' : threadId.startsWith('rv-') ? 'review' : 'inline');

const comment = (self, id, login, body, published, type = 'text') => ({
  id,
  author: login ?? null,
  isMine: !!login && login === self.name,
  type,
  key: readMarker(body).key,
  content: body ?? '',
  published,
});

const latest = (...dates) => dates.filter(Boolean).sort().at(-1) ?? null;

function summarizeThread(id, comments, { resolved = null, file = null, line = null, url = null, updated }) {
  const key = comments[0]?.key ?? null;
  return { id, kind: key ? 'bot' : 'human', key, status: deriveStatus(comments, resolved), file, line, url, comments, updated };
}

async function readReviewThreads(c, self) {
  const threads = [];
  let after = null;
  do {
    const data = await graphql(c, REVIEW_THREADS, { owner: c.owner, repo: c.repo, number: c.prId, after });
    const page = data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const nodes = node.comments.nodes;
      threads.push(summarizeThread(node.id, nodes.map((n) => comment(self, n.databaseId, n.author?.login, n.body, n.createdAt)), {
        resolved: node.isResolved,
        file: node.path,
        line: node.line ?? node.originalLine ?? null,
        url: nodes[0]?.url ?? null,
        updated: latest(...nodes.map((n) => n.updatedAt)),
      }));
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return threads;
}

const readReviews = (c) => paged(c, `/pulls/${c.prId}/reviews`);

// Review bodies and conversation comments; a comment marked reply-to=<threadId> joins that thread.
async function readConversation(c, self, reviews) {
  const [issueComments, allReviews] = await Promise.all([paged(c, `/issues/${c.prId}/comments`), reviews ?? readReviews(c)]);
  const threads = new Map();
  for (const review of allReviews) {
    if (!review.body?.trim() || review.state === 'PENDING') continue;
    const first = comment(self, review.id, review.user?.login, review.body, review.submitted_at, 'review');
    threads.set(`rv-${review.id}`, { comments: [first], url: review.html_url, updated: review.submitted_at });
  }
  for (const item of issueComments) {
    const entry = comment(self, item.id, item.user?.login, item.body, item.created_at);
    const thread = threads.get(readMarker(item.body).replyTo);
    if (thread) {
      thread.comments.push(entry);
      thread.updated = latest(thread.updated, item.updated_at);
    } else {
      threads.set(`ic-${item.id}`, { comments: [entry], url: item.html_url, updated: item.updated_at });
    }
  }
  return [...threads].map(([id, thread]) => summarizeThread(id, thread.comments, thread));
}

async function readThreads(c, self, reviews) {
  const [inline, conversation] = await Promise.all([readReviewThreads(c, self), readConversation(c, self, reviews)]);
  const started = (thread) => thread.comments[0]?.published ?? '';
  return [...inline, ...conversation].sort((a, b) => started(a).localeCompare(started(b)));
}

async function findThread(c, self, threadId) {
  const threads = kindOf(threadId) === 'inline' ? await readReviewThreads(c, self) : await readConversation(c, self);
  const thread = threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`PR ${c.prId} has no thread ${threadId}; "threads" lists their ids`);
  return thread;
}

function editComment(c, thread, target, body) {
  const kind = kindOf(thread.id);
  if (kind === 'inline') return gh(c, 'PATCH', `/pulls/comments/${target.id}`, { body });
  if (kind === 'review' && target === thread.comments[0]) return gh(c, 'PUT', `/pulls/${c.prId}/reviews/${target.id}`, { body });
  return gh(c, 'PATCH', `/issues/comments/${target.id}`, { body });
}

// The comment whose marker holds the status of one of our threads: our latest comment that set a
// status, else the first. Someone else's thread has none.
function statusCarrier(thread) {
  if (!thread.comments[0]?.isMine) return null;
  return thread.comments.findLast((entry) => entry.isMine && readMarker(entry.content).status) ?? thread.comments[0];
}

// Write the exact status into the carrier's marker (when there is one) and resolve or reopen a review
// thread natively. For review threads the current resolution follows from the status (deriveStatus).
async function applyStatus(c, thread, status, carrier) {
  const marker = carrier && readMarker(carrier.content);
  if (carrier && marker.status !== status) {
    const content = withMarker(carrier.content, { ...marker, status });
    await editComment(c, thread, carrier, content);
    carrier.content = content;
  }
  if (kindOf(thread.id) !== 'inline') return deriveStatus(thread.comments, null);
  const resolved = RESOLVED_STATUSES.includes(status);
  if (resolved !== RESOLVED_STATUSES.includes(thread.status)) await graphql(c, resolved ? RESOLVE : REOPEN, { id: thread.id }, { write: true });
  return deriveStatus(thread.comments, resolved);
}

async function threadOfComment(c, self, commentId) {
  for (let attempt = 1; ; attempt++) {
    const thread = (await readReviewThreads(c, self)).find((candidate) => candidate.comments[0]?.id === commentId);
    if (thread) return thread;
    if (attempt === 3) throw new Error(`posted comment ${commentId}, but its review thread did not show up; "threads" will list it`);
    await sleep(1000 * attempt);
  }
}

function checkRunStatus(run) {
  if (run.status !== 'COMPLETED') return run.status === 'IN_PROGRESS' ? 'running' : 'queued';
  if (run.conclusion === 'SUCCESS') return 'passed';
  return FAILED.includes(run.conclusion) ? 'failed' : 'skipped';
}

function summarizeCheck(node) {
  if (node.__typename === 'StatusContext') {
    return { id: node.context, name: node.context, kind: 'other', isBlocking: !!node.isRequired, status: STATUS_STATE[node.state] ?? 'queued', raw: node.state, runId: null, url: node.targetUrl ?? null };
  }
  const run = node.checkSuite?.workflowRun;
  return {
    id: node.databaseId,
    name: run?.workflow?.name ? `${run.workflow.name} / ${node.name}` : node.name,
    kind: 'build',
    isBlocking: !!node.isRequired,
    status: checkRunStatus(node),
    raw: node.conclusion ?? node.status,
    runId: run?.databaseId ?? null,
    url: node.detailsUrl ?? null,
  };
}

// Check runs and commit statuses on the head commit, plus the review decision as a check named "review".
async function readChecks(c) {
  const checks = [];
  let after = null;
  let decision = null;
  do {
    const data = await graphql(c, CHECKS, { owner: c.owner, repo: c.repo, number: c.prId, after });
    const pr = data.repository.pullRequest;
    decision = pr.reviewDecision;
    const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
    checks.push(...(contexts?.nodes ?? []).filter((node) => node.__typename).map(summarizeCheck));
    after = contexts?.pageInfo.hasNextPage ? contexts.pageInfo.endCursor : null;
  } while (after);
  checks.push({ id: 'review', name: 'review', kind: 'review', isBlocking: decision !== null, status: REVIEW_DECISION[decision] ?? 'skipped', raw: decision, runId: null, url: prWebUrl(c) });
  return checks;
}

// The logs endpoint redirects to a signed URL on another host: follow it by hand, without the token.
async function jobLog(c, jobId) {
  try {
    const first = await fetch(`${repoApi(c)}/actions/jobs/${jobId}/logs`, { headers: headers(c), redirect: 'manual' });
    const location = first.headers.get('location');
    const response = first.status >= 300 && first.status < 400 && location ? await fetch(location) : first;
    if (!response.ok) return `(log unavailable: HTTP ${response.status})`;
    return await response.text();
  } catch (error) {
    return `(log unavailable: ${error.message})`;
  }
}

// A job log as lines tagged with their second, without timestamps or terminal escapes.
function logLines(log) {
  let second = '';
  return log.replace(/\s+$/, '').split(/\r?\n/).map((raw) => {
    const stamp = raw.match(/^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z ?/);
    if (stamp) second = stamp[1];
    return { second, text: raw.slice(stamp ? stamp[0].length : 0).replace(/\x1b\[[0-?]*[ -\/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g, '') };
  });
}

// The end of one failed step's output: the lines stamped within its seconds, cut after its last ##[error]
// (post-job cleanup can start in the same second). The whole log when the step cannot be placed.
function stepTail(lines, step, tail) {
  const [from, to] = [step?.started_at?.slice(0, 19), step?.completed_at?.slice(0, 19)];
  let own = from && to ? lines.filter((line) => line.second >= from && line.second <= to) : [];
  if (!own.length) own = lines;
  const end = own.findLastIndex((line) => line.text.startsWith('##[error]'));
  return (end >= 0 ? own.slice(0, end + 1) : own).slice(-tail).map((line) => line.text).join('\n');
}

function pickStrategy(opts, repo) {
  const strategy = normalizeStrategy(opts.strategy, FROM_GH_STRATEGY[repo.viewerDefaultMergeMethod] ?? 'merge');
  if (strategy === 'rebase-merge') throw new UsageError('GitHub has no rebase-merge (rebase, then a merge commit); use merge, squash or rebase');
  return strategy;
}

// --message: the first line is the commit title, the rest its body.
function commitMessage(opts) {
  if (typeof opts.message !== 'string') return {};
  const [title, ...rest] = opts.message.split(/\r?\n/);
  return { title: title.trim() || undefined, body: rest.join('\n').trim() || undefined };
}

// After a merge this command did. Kept when asked, when the branch is in a fork, or when open PRs target it
// (deleting it would close them); GitHub deletes it itself when the repository says so.
async function deleteSourceBranch(c, pr, repo, opts) {
  const name = pr.head.ref;
  if (opts['keep-source-branch']) return { name, deleted: false, note: repo.deleteBranchOnMerge ? 'GitHub deletes merged branches in this repository' : null };
  if (pr.head.repo?.full_name !== pr.base.repo.full_name) return { name, deleted: false, note: 'kept: the branch is in a fork' };
  if (repo.deleteBranchOnMerge) return { name, deleted: true, note: 'GitHub deletes merged branches in this repository' };
  try {
    const dependents = await gh(c, 'GET', `/pulls?state=open&base=${enc(name)}&per_page=100`);
    if (dependents.length) return { name, deleted: false, note: `kept: open PRs ${dependents.map((p) => `#${p.number}`).join(', ')} target it` };
    await gh(c, 'DELETE', `/git/refs/heads/${name.split('/').map(enc).join('/')}`);
    return { name, deleted: true, note: null };
  } catch (error) {
    if (error.status === 422) return { name, deleted: true, note: 'already deleted' }; // GitHub: "Reference does not exist"
    return { name, deleted: false, note: `could not delete it: ${error.message.slice(0, 200)}` };
  }
}

async function mergeNow(c, pr, repo, strategy, opts) {
  const { title, body } = commitMessage(opts);
  const payload = { merge_method: strategy, sha: pr.head.sha };
  if (title && strategy !== 'rebase') payload.commit_title = title;
  if (body && strategy !== 'rebase') payload.commit_message = body;
  const result = await gh(c, 'PUT', `/pulls/${c.prId}/merge`, payload);
  return { status: 'completed', strategy, mergeCommit: result.dryRun ? null : result.sha, sourceBranch: await deleteSourceBranch(c, pr, repo, opts) };
}

// ---------------------------------------------------------------------------------------------
// Commands

export const commands = {
  async context(c) {
    const self = await me(c);
    return { platform, host: c.host, owner: c.owner, repo: c.repo, prId: c.prId ?? null, prWebUrl: c.prId ? prWebUrl(c) : null, repoWebUrl: repoWebUrl(c), me: self };
  },

  async find(c, _pos, opts) {
    if (typeof opts.branch !== 'string') throw new UsageError('find needs --branch <name>');
    const branch = opts.branch.replace(/^refs\/heads\//, '');
    const pulls = await paged(c, `/pulls?state=open&head=${enc(branch.includes(':') ? branch : `${c.owner}:${branch}`)}`);
    return pulls.map((pr) => ({ id: pr.number, title: pr.title, isDraft: !!pr.draft, webUrl: pr.html_url }));
  },

  async show(c) {
    requirePr(c);
    const [pr, reviews, self] = await Promise.all([gh(c, 'GET', `/pulls/${c.prId}`), readReviews(c), me(c)]);
    return summarizePr(c, pr, reviews, self, pr.auto_merge ? await settings(c) : null);
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
    const status = optionalStatus(opts);
    const range = typeof opts.file === 'string' ? lineRange(opts) : null;
    const self = await me(c);
    if (key) {
      const existing = (await readThreads(c, self)).find((thread) => thread.key === key);
      if (existing) return { existing: true, id: existing.id, status: existing.status, url: existing.url };
    }
    const content = withMarker(body, { key, status });
    if (!range) {
      const created = await gh(c, 'POST', `/issues/${c.prId}/comments`, { body: content });
      return { existing: false, id: `ic-${created.id}`, status: status ?? 'active', url: created.html_url ?? null };
    }
    const pr = await gh(c, 'GET', `/pulls/${c.prId}`);
    const payload = { body: content, commit_id: pr.head.sha, path: opts.file.replace(/\\/g, '/').replace(/^\//, ''), line: range.endLine, side: 'RIGHT' };
    if (range.endLine > range.line) Object.assign(payload, { start_line: range.line, start_side: 'RIGHT' });
    const created = await gh(c, 'POST', `/pulls/${c.prId}/comments`, payload);
    const thread = created.dryRun
      ? { id: `dry-run-${created.id}`, status: 'active', comments: [{ content }] }
      : await threadOfComment(c, self, created.id);
    return { existing: false, id: thread.id, status: status ? await applyStatus(c, thread, status, null) : thread.status, url: created.html_url ?? null };
  },

  async reply(c, pos, opts) {
    requirePr(c);
    const threadId = pos[1];
    if (!threadId) throw new UsageError('reply needs <pr> <threadId>');
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    const status = optionalStatus(opts);
    const thread = await findThread(c, await me(c), threadId);
    const existing = key && thread.comments.find((entry) => entry.key === key);
    if (existing) {
      const current = status ? await applyStatus(c, thread, status, existing.isMine ? existing : null) : thread.status;
      return { existing: true, threadId, commentId: existing.id, status: current };
    }
    const inline = kindOf(threadId) === 'inline';
    const content = withMarker(body, { key, status, replyTo: inline ? null : threadId });
    const created = inline
      ? await gh(c, 'POST', `/pulls/${c.prId}/comments/${thread.comments[0].id}/replies`, { body: content })
      : await gh(c, 'POST', `/issues/${c.prId}/comments`, { body: content });
    if (!status) return { existing: false, threadId, commentId: created.id, status: null };
    const withReply = { ...thread, comments: [...thread.comments, { content, isMine: true }] };
    return { existing: false, threadId, commentId: created.id, status: await applyStatus(c, withReply, status, null) };
  },

  async 'set-status'(c, pos) {
    requirePr(c);
    const threadId = pos[1];
    if (!threadId) throw new UsageError('set-status needs <pr> <threadId> <status>');
    const status = checkStatus(pos[2]);
    const thread = await findThread(c, await me(c), threadId);
    const carrier = statusCarrier(thread);
    if (!carrier && kindOf(threadId) !== 'inline') {
      return { threadId, status: thread.status, note: 'GitHub cannot resolve a conversation comment or a review, and this one is someone else\'s: reply with --status to record a status' };
    }
    const result = { threadId, status: await applyStatus(c, thread, status, carrier) };
    if (result.status !== status) result.note = `GitHub only resolves or reopens someone else's thread, so it reads as ${result.status}; reply with --status ${status} to record the exact status`;
    return result;
  },

  async 'set-description'(c, _pos, opts) {
    requirePr(c);
    const description = readBody(opts);
    if (description.length > DESCRIPTION_LIMIT) {
      throw new UsageError(`description is ${description.length} characters; GitHub keeps at most ${DESCRIPTION_LIMIT}. Shorten it and move detail into a thread.`);
    }
    await gh(c, 'PATCH', `/pulls/${c.prId}`, { body: description });
    return { id: c.prId, length: description.length };
  },

  async publish(c) {
    requirePr(c);
    const pr = await gh(c, 'GET', `/pulls/${c.prId}`);
    if (!pr.draft) return { id: c.prId, isDraft: false };
    const data = await graphql(c, READY, { id: pr.node_id }, { write: true });
    return { id: c.prId, isDraft: !data.dryRun && !!data.markPullRequestReadyForReview.pullRequest.isDraft };
  },

  async checks(c) {
    requirePr(c);
    return readChecks(c);
  },

  async 'rerun-check'(c, pos) {
    requirePr(c);
    const checkId = pos[1];
    if (!checkId) throw new UsageError('rerun-check needs <pr> <checkId>');
    if (checkId === 'review') throw new UsageError('the review check is the review decision; it cannot be rerun');
    if (!/^\d+$/.test(checkId)) throw new UsageError(`"${checkId}" is a commit status that an outside service reports; GitHub cannot rerun it. Rerun it in that service (checks gives its url).`);
    const run = await gh(c, 'GET', `/check-runs/${checkId}`);
    if (run.app?.slug === 'github-actions') {
      // An Actions check run is a job: rerun the failed jobs of its workflow run.
      const job = await gh(c, 'GET', `/actions/jobs/${checkId}`);
      await gh(c, 'POST', `/actions/runs/${job.run_id}/rerun-failed-jobs`);
      return { checkId: Number(checkId), runId: job.run_id, status: 'queued' };
    }
    await gh(c, 'POST', `/check-runs/${checkId}/rerequest`);
    return { checkId: Number(checkId), runId: null, status: 'queued' };
  },

  async 'check-failures'(c, pos, opts) {
    const runId = Number(pos[0]);
    if (!runId) throw new UsageError('check-failures needs <runId> (the runId of a check)');
    const tail = Number(opts.tail ?? 80);
    const [run, jobs] = await Promise.all([gh(c, 'GET', `/actions/runs/${runId}`), paged(c, `/actions/runs/${runId}/jobs?filter=latest`, 'jobs')]);
    const steps = [];
    for (const job of jobs.filter((candidate) => FAILED_JOB.includes(candidate.conclusion))) {
      const [annotations, log] = await Promise.all([gh(c, 'GET', `/check-runs/${job.id}/annotations?per_page=100`).catch(() => []), jobLog(c, job.id)]);
      const issues = annotations.filter((annotation) => annotation.annotation_level === 'failure').map((annotation) => annotation.message);
      const lines = logLines(log);
      const failed = (job.steps ?? []).filter((step) => FAILED_JOB.includes(step.conclusion));
      for (const step of failed.length ? failed : [null]) {
        steps.push({ name: step ? `${job.name} / ${step.name}` : job.name, issues, logTail: stepTail(lines, step, tail) });
      }
    }
    return { runId, status: run.status, result: run.conclusion ?? null, commit: run.head_sha, url: run.html_url, failedSteps: steps };
  },

  async 'auto-merge'(c, _pos, opts) {
    requirePr(c);
    const [pr, repo] = await Promise.all([gh(c, 'GET', `/pulls/${c.prId}`), settings(c)]);
    const strategy = pickStrategy(opts, repo);
    if (pr.merged) return { id: c.prId, autoMerge: false, mergedNow: false, status: 'completed', note: 'already merged' };
    if (pr.state !== 'open') throw new Error(`PR ${c.prId} is closed; reopen it first`);
    const enabled = () => {
      const result = { id: c.prId, autoMerge: true, mergedNow: false, strategy, deleteSourceBranch: !!repo.deleteBranchOnMerge };
      if (!opts['keep-source-branch'] && !repo.deleteBranchOnMerge) result.note = 'GitHub keeps merged branches in this repository: delete the source branch after the merge';
      return result;
    };
    if (pr.auto_merge?.merge_method === strategy) return enabled();
    let reason = 'the repository does not allow auto-merge';
    if (repo.autoMergeAllowed) {
      const { title, body } = commitMessage(opts);
      const input = { pullRequestId: pr.node_id, mergeMethod: strategy.toUpperCase() };
      if (title && strategy !== 'rebase') input.commitHeadline = title;
      if (body && strategy !== 'rebase') input.commitBody = body;
      try {
        await graphql(c, ENABLE_AUTO_MERGE, { input }, { write: true });
        return enabled();
      } catch (error) {
        // GitHub refuses auto-merge when branch protection leaves nothing to wait for.
        const refused = error.message.match(/is in (clean|has_hooks|unstable) status|auto.?merge is not allowed/i);
        if (!refused) throw error;
        reason = refused[1] ? `GitHub refuses auto-merge on a PR in ${refused[1]} status` : 'the repository does not allow auto-merge';
      }
    }
    // Merge now instead, but not over failing or unfinished checks: the caller asked to wait for them.
    const waiting = (await readChecks(c)).filter((check) => check.kind !== 'review' && !['passed', 'skipped'].includes(check.status));
    if (waiting.length) {
      const names = waiting.map((check) => `${check.name} (${check.status})`).join(', ');
      return { id: c.prId, autoMerge: false, mergedNow: false, reason: `${reason}, and these checks are not green: ${names}. Watch them, then merge.` };
    }
    return { id: c.prId, autoMerge: false, mergedNow: true, reason, ...(await mergeNow(c, pr, repo, strategy, opts)) };
  },

  async 'cancel-auto-merge'(c) {
    requirePr(c);
    const pr = await gh(c, 'GET', `/pulls/${c.prId}`);
    if (!pr.auto_merge) return { id: c.prId, autoMerge: false };
    const data = await graphql(c, DISABLE_AUTO_MERGE, { id: pr.node_id }, { write: true });
    return { id: c.prId, autoMerge: !data.dryRun && !!data.disablePullRequestAutoMerge.pullRequest.autoMergeRequest };
  },

  async merge(c, _pos, opts) {
    requirePr(c);
    const [pr, repo] = await Promise.all([gh(c, 'GET', `/pulls/${c.prId}`), settings(c)]);
    const strategy = pickStrategy(opts, repo);
    if (pr.merged) return { id: c.prId, status: 'completed', mergeCommit: pr.merge_commit_sha ?? null, note: 'already merged' };
    if (pr.state !== 'open') throw new Error(`PR ${c.prId} is closed; reopen it first`);
    return { id: c.prId, ...(await mergeNow(c, pr, repo, strategy, opts)) };
  },

  async watch(c, _pos, opts) {
    requirePr(c);
    const self = await me(c);
    return watchLoop(c.prId, opts.interval, async () => {
      const [pr, reviews] = await Promise.all([gh(c, 'GET', `/pulls/${c.prId}`), readReviews(c)]);
      const [checks, threads] = await Promise.all([readChecks(c), readThreads(c, self, reviews)]);
      const summary = summarizePr(c, pr, reviews, self, pr.auto_merge ? await settings(c) : null);
      return { status: summary.status, state: watchState(summary, checks), comments: peopleComments(threads) };
    });
  },
};
