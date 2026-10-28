// GitLab (gitlab.com and self-managed) over the REST API v4. Auth: GITLAB_TOKEN or GITLAB_PRIVATE_TOKEN
// (sent only to GITLAB_HOST, default gitlab.com, as glab does), otherwise the token glab stores for the host.
// Without a token, reads of public projects still work; writes refuse.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  RESOLVED_STATUSES, UsageError, checkStatus, deriveStatus, enc, lineRange, normalizeStrategy, optionalStatus,
  peopleComments, readBody, readMarker, request, requirePr, watchLoop, watchState, withMarker,
} from '../lib.mjs';

export const platform = 'gitlab';

const DESCRIPTION_LIMIT = 1048576;
const STATE = { opened: 'active', merged: 'completed', closed: 'abandoned', locked: 'abandoned' };
const CONFLICTS = ['conflict', 'broken_status', 'cannot_be_merged'];
const CHECKING = ['checking', 'unchecked', 'preparing', 'cannot_be_merged_recheck'];
const REVIEW_VOTES = { approved: 'approved', requested_changes: 'waiting-for-author' };
const CHECK_STATUS = {
  created: 'queued', pending: 'queued', waiting_for_resource: 'queued', preparing: 'queued', scheduled: 'queued', manual: 'queued',
  running: 'running', waiting_for_callback: 'running', success: 'passed', failed: 'failed', canceled: 'failed', canceling: 'failed', skipped: 'skipped',
};
const FINISHED = ['success', 'failed', 'canceled', 'skipped'];
// GitLab fixes merge commit vs. rebase per project (merge_method); a strategy can only match it.
const MERGE_METHOD = { rebase: 'ff', 'rebase-merge': 'rebase_merge' };
const METHOD_STRATEGY = { merge: 'merge', rebase_merge: 'rebase-merge', ff: 'rebase' };
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-|\[wip\]|wip:)\s*/i;

// ---------------------------------------------------------------------------------------------
// Context

// https://[user[:token]@]host[:port]/path, ssh://[user@]host[:port]/path, user@host:path. The project path
// is everything after the host (nested groups); the port only matters for https.
function parseRemote(url) {
  const text = (url ?? '').trim();
  const match = text.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/)
    ?? text.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/)
    ?? text.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
  const projectPath = match?.[2].replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
  return projectPath?.includes('/') ? { host: match[1].toLowerCase(), projectPath } : null;
}

const isGitLabHost = (host) => /gitlab/i.test(host) && !/\.visualstudio\.com$/i.test(host);

export function fromRemote(url, { forced, opts }) {
  const parsed = parseRemote(url);
  if (!forced && !(parsed && isGitLabHost(parsed.host))) return null;
  const host = typeof opts.host === 'string' ? opts.host.replace(/^\w+:\/\//, '').replace(/\/+$/, '').toLowerCase() : parsed?.host;
  const c = { host, projectPath: typeof opts.project === 'string' ? opts.project.replace(/^\/+|\/+$/g, '') : parsed?.projectPath };
  if (!c.host || !c.projectPath) {
    throw new UsageError('cannot tell the GitLab host and project: pass a merge-request URL, run inside a GitLab checkout, or pass --host <host> --project <group/project>');
  }
  return c;
}

// https://<host>/<group>/.../<project>/-/merge_requests/<iid>, on any host: the path is GitLab's own.
export function fromPrUrl(url) {
  const match = url.match(/^https?:\/\/(?:[^@/]+@)?([^/?#]+)\/(.+?)\/(?:-\/)?merge_requests\/(\d+)(?:[/?#]|$)/);
  return match ? { host: match[1].toLowerCase(), projectPath: match[2], prId: Number(match[3]) } : null;
}

const apiUrl = (c) => `https://${c.host}/api/v4`;
const projectApi = (c, project = c.projectPath) => `${apiUrl(c)}/projects/${enc(project)}`;
const mrApi = (c) => `${projectApi(c)}/merge_requests/${c.prId}`;
const repoWebUrl = (c) => `https://${c.host}/${c.projectPath}`;
const prWebUrl = (c) => `${repoWebUrl(c)}/-/merge_requests/${c.prId}`;
const noteUrl = (c, noteId) => (noteId ? `${prWebUrl(c)}#note_${noteId}` : prWebUrl(c));

// Pipelines and jobs outside the MR's target project (a fork's pipeline, a downstream pipeline elsewhere)
// carry their project in the id: "<projectId>:<id>". checks hands these out; rerun-check and
// check-failures take them back.
const runRef = (projectId, id, home) => (projectId && projectId !== home ? `${projectId}:${id}` : id);
function parseRunRef(value) {
  const match = String(value ?? '').match(/^(?:(\d+):)?(\d+)$/);
  return match ? { project: match[1] ?? null, id: match[2] } : null;
}

// ---------------------------------------------------------------------------------------------
// HTTP

function envHost() {
  const value = process.env.GITLAB_HOST || process.env.GL_HOST || process.env.GITLAB_URI || 'gitlab.com';
  return value.replace(/^\w+:\/\//, '').split('/')[0].toLowerCase();
}

let cachedToken;
function token(c) {
  if (cachedToken !== undefined) return cachedToken;
  const fromEnv = process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN;
  if (fromEnv && c.host === envHost()) {
    cachedToken = fromEnv;
    return cachedToken;
  }
  try {
    cachedToken = execFileSync('glab', ['config', 'get', 'token', '--host', c.host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim() || null;
  } catch {
    cachedToken = null; // glab is not installed, or not signed in to this host
  }
  return cachedToken;
}

function signInHint(c) {
  const withheld = (process.env.GITLAB_TOKEN || process.env.GITLAB_PRIVATE_TOKEN) && c.host !== envHost();
  return withheld
    ? `GITLAB_TOKEN is only sent to ${envHost()}: set GITLAB_HOST=${c.host} or run "glab auth login --hostname ${c.host}"`
    : `set GITLAB_TOKEN or run "glab auth login --hostname ${c.host}"`;
}

function requireToken(c) {
  if (!token(c)) throw new Error(`no GitLab token for ${c.host}: ${signInHint(c)}`);
}

async function gl(c, method, url, body, accept) {
  const bearer = token(c);
  try {
    return await request(method, url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, body, accept });
  } catch (error) {
    if (!bearer && [401, 403, 404].includes(error.status)) error.message += ` (sent without a token; ${signInHint(c)})`;
    throw error;
  }
}

// GitLab answers 404 or 403 for endpoints an edition or version lacks; treat those as absent.
const optional = (promise) => promise.catch((error) => {
  if (error.status === 403 || error.status === 404) return null;
  throw error;
});

// Pages until a short page (request() does not expose the x-next-page header), at most 10,000 items.
async function paginate(c, url) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await gl(c, 'GET', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Shapes

const person = (user) => (user ? { id: user.id, name: user.name, uniqueName: user.username ?? null } : null);

let cachedMe;
async function me(c) {
  if (cachedMe !== undefined) return cachedMe;
  cachedMe = token(c) ? person(await gl(c, 'GET', `${apiUrl(c)}/user`)) : null;
  return cachedMe;
}

let cachedProject;
async function project(c) {
  cachedProject ??= await gl(c, 'GET', projectApi(c));
  return cachedProject;
}

const autoMergeSet = (mr) => !!(mr.merge_when_pipeline_succeeds || mr.auto_merge);

function reviewerVotes(mr, approvals, reviewers) {
  const approved = (approvals?.approved_by ?? []).map((approval) => approval.user);
  const listed = reviewers ?? (mr.reviewers ?? []).map((user) => ({ user, state: null }));
  const votes = listed.map(({ user, state }) => ({
    name: user.name,
    vote: approved.some((approver) => approver.id === user.id) ? 'approved' : REVIEW_VOTES[state] ?? 'none',
    isRequired: false,
  }));
  const others = approved.filter((approver) => !listed.some(({ user }) => user.id === approver.id));
  return [...votes, ...others.map((approver) => ({ name: approver.name, vote: 'approved', isRequired: false }))];
}

function summarizePr(c, mr, { approvals, reviewers, projectInfo } = {}, self) {
  const raw = mr.detailed_merge_status ?? mr.merge_status ?? null;
  const squash = mr.squash_on_merge ?? mr.squash;
  return {
    platform,
    id: mr.iid,
    title: mr.title,
    description: mr.description ?? '',
    status: STATE[mr.state] ?? mr.state,
    isDraft: !!(mr.draft ?? mr.work_in_progress),
    author: person(mr.author),
    isMine: !!self && mr.author?.id === self.id,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    sourceCommit: mr.sha ?? null,
    targetCommit: mr.diff_refs?.base_sha ?? null,
    // A fast-forward merge makes no commit of its own: the source head is then the merge.
    mergeCommit: mr.merge_commit_sha ?? mr.squash_commit_sha ?? (mr.state === 'merged' ? mr.sha : null) ?? null,
    mergeStatus: mr.has_conflicts || CONFLICTS.includes(raw) ? 'conflicts' : CHECKING.includes(raw) ? 'checking' : raw ? 'ok' : 'unknown',
    mergeStatusRaw: raw,
    autoMerge: autoMergeSet(mr)
      ? { by: person(mr.merge_user), strategy: squash ? 'squash' : METHOD_STRATEGY[projectInfo?.merge_method] ?? 'merge', deleteSourceBranch: !!(mr.should_remove_source_branch || mr.force_remove_source_branch) }
      : null,
    reviewers: reviewerVotes(mr, approvals, reviewers),
    limits: { description: DESCRIPTION_LIMIT },
    webUrl: mr.web_url ?? prWebUrl(c),
    repoWebUrl: repoWebUrl(c),
    me: self,
  };
}

// true / false for a resolvable discussion, null for one that cannot be resolved (a single comment).
function resolvedFlag(discussion) {
  const resolvable = (discussion.notes ?? []).filter((note) => note.resolvable);
  return resolvable.length ? resolvable.every((note) => note.resolved) : null;
}

function summarizeThread(c, discussion, self) {
  const notes = discussion.notes ?? [];
  const comments = notes.map((note) => ({
    id: note.id,
    author: note.author?.name ?? null,
    isMine: !!self && note.author?.id === self.id,
    type: note.system ? 'system' : 'text',
    key: readMarker(note.body).key,
    content: note.body ?? '',
    published: note.created_at,
  }));
  const position = notes[0]?.position;
  const start = position?.line_range?.start; // a range is anchored on its last line; report its first
  const key = comments[0]?.key ?? null;
  const isSystem = comments.length > 0 && comments.every((comment) => comment.type === 'system');
  return {
    id: discussion.id,
    kind: isSystem ? 'system' : key ? 'bot' : 'human',
    key,
    status: deriveStatus(comments, resolvedFlag(discussion)),
    file: position ? (position.new_line == null && position.old_line != null ? position.old_path : position.new_path) ?? null : null,
    line: (start ? start.new_line ?? start.old_line : position?.new_line ?? position?.old_line) ?? null,
    url: noteUrl(c, comments[0]?.id),
    comments,
    updated: notes.map((note) => note.updated_at ?? note.created_at).sort().at(-1) ?? null,
  };
}

// Without a token GitLab refuses the discussions API even on public projects; GraphQL still answers.
// The result is shaped like the REST discussions.
const DISCUSSIONS_QUERY = `query($path: ID!, $iid: String!, $after: String) { project(fullPath: $path) { mergeRequest(iid: $iid) {
  discussions(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id resolvable resolved
    notes(first: 100) { nodes { id body system createdAt updatedAt author { id name username }
      position { newPath newLine oldPath oldLine } } } } } } } }`;

async function publicDiscussions(c) {
  const lastPart = (gid) => gid?.split('/').pop();
  const discussions = [];
  for (let after = null; ;) {
    const { data, errors } = await request('POST', `https://${c.host}/api/graphql`, {
      body: { query: DISCUSSIONS_QUERY, variables: { path: c.projectPath, iid: String(c.prId), after } },
      write: false,
    });
    if (errors?.length) throw new Error(`GitLab GraphQL: ${errors.map((error) => error.message).join('; ')}`);
    const page = data?.project?.mergeRequest?.discussions;
    if (!page) throw new Error(`merge request !${c.prId} of ${c.projectPath} not found without a token (${signInHint(c)})`);
    for (const discussion of page.nodes) {
      discussions.push({
        id: lastPart(discussion.id),
        notes: discussion.notes.nodes.map((note) => ({
          id: Number(lastPart(note.id)),
          body: note.body,
          system: note.system,
          created_at: note.createdAt,
          updated_at: note.updatedAt,
          resolvable: discussion.resolvable,
          resolved: discussion.resolved,
          author: note.author && { id: Number(lastPart(note.author.id)), name: note.author.name, username: note.author.username },
          position: note.position && { new_path: note.position.newPath, new_line: note.position.newLine, old_path: note.position.oldPath, old_line: note.position.oldLine },
        })),
      });
    }
    if (!page.pageInfo.hasNextPage) return discussions;
    after = page.pageInfo.endCursor;
  }
}

async function readThreads(c, self) {
  const discussions = token(c) ? await paginate(c, `${mrApi(c)}/discussions`) : await publicDiscussions(c);
  return discussions.map((discussion) => summarizeThread(c, discussion, self));
}

function discussionId(value, usage) {
  if (!/^[0-9a-f]+$/i.test(value ?? '')) throw new UsageError(usage);
  return value;
}

// The exact status lives in the marker of the thread's latest status-carrying comment (deriveStatus reads
// that one), or of its first comment when none carries one yet; it is edited only when that comment is
// ours. The discussion is resolved natively for RESOLVED_STATUSES. Returns the status threads now reports.
async function applyStatus(c, discussion, status, self) {
  const notes = discussion.notes.filter((note) => !note.system);
  const holder = [...notes].reverse().find((note) => readMarker(note.body).status) ?? notes[0];
  const ours = !!holder && !!self && holder.author?.id === self.id;
  if (ours && readMarker(holder.body).status !== status) {
    holder.body = withMarker(holder.body, { ...readMarker(holder.body), status });
    await gl(c, 'PUT', `${mrApi(c)}/notes/${holder.id}`, { body: holder.body });
  }
  const resolved = resolvedFlag(discussion);
  if (resolved === null && !ours) {
    throw new Error(`thread ${discussion.id} cannot be resolved and its status marker is not yours, so its status cannot change`);
  }
  const target = RESOLVED_STATUSES.includes(status);
  if (resolved !== null && resolved !== target) {
    await gl(c, 'PUT', `${mrApi(c)}/discussions/${discussion.id}`, { resolved: target });
    for (const note of discussion.notes) if (note.resolvable) note.resolved = target;
  }
  return deriveStatus(discussion.notes.map((note) => ({ content: note.body })), resolvedFlag(discussion));
}

async function readDiffs(c) {
  try {
    return await paginate(c, `${mrApi(c)}/diffs`);
  } catch (error) {
    if (error.status !== 404) throw error;
    return (await gl(c, 'GET', `${mrApi(c)}/changes`)).changes; // GitLab before 15.7
  }
}

// Where head-version line `target` sits in a file's unified diff: an added line, or an unchanged one and
// its old line number (inside a hunk, or between hunks by the offset the hunks above it left).
// oldLine is GitLab's old-side counter at that line, which its line codes use for added lines too.
function locate(diff, target) {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of diff.replace(/\n$/, '').split('\n')) {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      if (Number(header[2]) > target) break;
      [oldLine, newLine, inHunk] = [Number(header[1]), Number(header[2]), true];
      continue;
    }
    if (!inHunk || text.startsWith('\\')) continue;
    if (text.startsWith('-')) {
      oldLine++;
      continue;
    }
    if (newLine === target) return { oldLine, added: text.startsWith('+') };
    newLine++;
    if (!text.startsWith('+')) oldLine++;
  }
  return { oldLine: target - (newLine - oldLine), added: false };
}

// An inline position on the head version. A range is anchored on its last line, as GitLab's UI does, and
// carries line codes (sha1 of the path, old line, new line) for both ends.
async function inlinePosition(c, file, { line, endLine }) {
  const [mr, diffs] = await Promise.all([gl(c, 'GET', mrApi(c)), readDiffs(c)]);
  const entry = diffs.find((diff) => diff.new_path === file) ?? diffs.find((diff) => diff.old_path === file);
  if (!entry || entry.deleted_file) {
    throw new UsageError(`${file} is ${entry ? 'deleted' : 'not changed'} in merge request !${c.prId}; GitLab takes inline comments only on files in the diff`);
  }
  const refs = mr.diff_refs ?? {};
  const position = {
    position_type: 'text', base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
    old_path: entry.old_path, new_path: entry.new_path, new_line: endLine,
  };
  if (!entry.diff) return position; // GitLab withheld the diff (too large): anchor on the line alone
  const end = locate(entry.diff, endLine);
  if (!end.added) position.old_line = end.oldLine;
  if (endLine > line) {
    const code = createHash('sha1').update(entry.new_path).digest('hex');
    const point = (n, { oldLine, added }) =>
      (added ? { line_code: `${code}_${oldLine}_${n}`, type: 'new', new_line: n } : { line_code: `${code}_${oldLine}_${n}`, old_line: oldLine, new_line: n });
    position.line_range = { start: point(line, locate(entry.diff, line)), end: point(endLine, end) };
  }
  return position;
}

// The MR's latest pipeline, one check per job and per trigger job (its runId is the downstream
// pipeline), plus the approval rules as one review check.
async function readChecks(c, mr) {
  const [pipelines, approvals] = await Promise.all([gl(c, 'GET', `${mrApi(c)}/pipelines`), optional(gl(c, 'GET', `${mrApi(c)}/approvals`))]);
  const pipeline = pipelines[0];
  const home = mr.target_project_id;
  const checks = [];
  if (pipeline) {
    const base = `${apiUrl(c)}/projects/${pipeline.project_id}/pipelines/${pipeline.id}`;
    const [jobs, bridges] = await Promise.all([paginate(c, `${base}/jobs?include_retried=false`), optional(paginate(c, `${base}/bridges`))]);
    for (const job of [...jobs, ...(bridges ?? [])].sort((a, b) => a.id - b.id)) {
      const downstream = job.downstream_pipeline;
      checks.push({
        id: runRef(pipeline.project_id, job.id, home),
        name: job.name,
        kind: 'build',
        isBlocking: !job.allow_failure,
        status: CHECK_STATUS[job.status] ?? job.status,
        raw: job.status,
        runId: downstream ? runRef(downstream.project_id, downstream.id, home) : runRef(pipeline.project_id, pipeline.id, home),
        url: job.web_url ?? downstream?.web_url ?? pipeline.web_url,
      });
    }
    // A pipeline can fail without a failing job (configuration errors, refused creation).
    if (CHECK_STATUS[pipeline.status] === 'failed' && !checks.some((check) => check.status === 'failed' && check.isBlocking)) {
      const runId = runRef(pipeline.project_id, pipeline.id, home);
      checks.push({ id: 'pipeline', name: 'pipeline', kind: 'build', isBlocking: true, status: 'failed', raw: pipeline.status, runId, url: pipeline.web_url });
    }
  }
  if (approvals) {
    checks.push({
      id: 'approval',
      name: 'approvals',
      kind: 'review',
      isBlocking: (approvals.approvals_required ?? 0) > 0,
      status: approvals.approved ? 'passed' : 'queued',
      raw: approvals.approved ? 'approved' : `approvals_left=${approvals.approvals_left ?? '?'}`,
      runId: null,
      url: mr.web_url ?? prWebUrl(c),
    });
  }
  return checks;
}

// Runner logs: drop the timestamp prefixes newer runners write, section markers and ANSI escapes, and keep
// only what a carriage return left visible.
const LOG_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z [0-9a-f]{2}[OE][ +]?/;
const LOG_SECTION = /section_(?:start|end):\d+:\S*\r(?:\x1b\[0K)?/g;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function cleanLog(text) {
  const lines = [];
  for (const raw of text.replace(/\s+$/, '').split('\n')) {
    const stamped = raw.replace(LOG_STAMP, '');
    const line = stamped.replace(LOG_SECTION, '');
    if (line !== stamped && !line.replace(ANSI, '').trim()) continue; // only opened or closed a section
    lines.push((line.replace(ANSI, '').split('\r').filter(Boolean).at(-1) ?? '').trimEnd());
  }
  return lines;
}

async function jobLog(c, projectId, job) {
  if (token(c)) return gl(c, 'GET', `${apiUrl(c)}/projects/${projectId}/jobs/${job.id}/trace`, undefined, 'text/plain');
  return request('GET', `${job.web_url}/raw`, { accept: 'text/plain' }); // the API refuses logs without a token
}

async function mergeOptions(c, mr, opts) {
  const strategy = normalizeStrategy(opts.strategy);
  if (MERGE_METHOD[strategy]) {
    const method = (await project(c)).merge_method;
    if (method !== MERGE_METHOD[strategy]) {
      throw new UsageError(`GitLab sets merge commit vs. rebase per project, and ${c.projectPath} uses merge method "${method ?? 'unknown'}" (${METHOD_STRATEGY[method] ?? 'unknown'}): pass --strategy merge or squash, or change the project's merge method`);
    }
  }
  const options = { should_remove_source_branch: !opts['keep-source-branch'], squash: strategy === 'squash', sha: mr.sha };
  if (typeof opts.message === 'string') {
    options.merge_commit_message = opts.message;
    if (strategy === 'squash') options.squash_commit_message = opts.message;
  }
  return { strategy, options };
}

async function putMerge(c, mr, payload) {
  try {
    return await gl(c, 'PUT', `${mrApi(c)}/merge`, payload);
  } catch (error) {
    if ([405, 406, 409, 422].includes(error.status)) {
      error.message += ` (GitLab refused: detailed_merge_status=${mr.detailed_merge_status ?? mr.merge_status}, has_conflicts=${!!mr.has_conflicts})`;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

export const commands = {
  async context(c) {
    const self = await me(c);
    return { platform, host: c.host, projectPath: c.projectPath, prId: c.prId ?? null, prWebUrl: c.prId ? prWebUrl(c) : null, repoWebUrl: repoWebUrl(c), me: self };
  },

  async find(c, _pos, opts) {
    if (typeof opts.branch !== 'string') throw new UsageError('find needs --branch <name>');
    const branch = opts.branch.replace(/^refs\/heads\//, '');
    const mrs = await gl(c, 'GET', `${projectApi(c)}/merge_requests?source_branch=${enc(branch)}&state=opened&per_page=100`);
    return mrs.map((mr) => ({ id: mr.iid, title: mr.title, isDraft: !!mr.draft, webUrl: mr.web_url }));
  },

  async show(c) {
    requirePr(c);
    const [mr, approvals, reviewers, self] = await Promise.all([
      gl(c, 'GET', mrApi(c)),
      optional(gl(c, 'GET', `${mrApi(c)}/approvals`)),
      optional(gl(c, 'GET', `${mrApi(c)}/reviewers`)),
      me(c),
    ]);
    const projectInfo = autoMergeSet(mr) ? await optional(project(c)) : null;
    return summarizePr(c, mr, { approvals, reviewers, projectInfo }, self);
  },

  async threads(c, _pos, opts) {
    requirePr(c);
    const threads = await readThreads(c, await me(c));
    return opts.all ? threads : threads.filter((thread) => thread.kind !== 'system');
  },

  async 'thread-create'(c, _pos, opts) {
    requirePr(c);
    requireToken(c);
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    const status = optionalStatus(opts);
    if (key) {
      const existing = (await readThreads(c, await me(c))).find((thread) => thread.key === key);
      if (existing) return { existing: true, id: existing.id, status: existing.status, url: existing.url };
    }
    const payload = { body: withMarker(body, { key, status }) };
    if (typeof opts.file === 'string') payload.position = await inlinePosition(c, opts.file.replace(/\\/g, '/').replace(/^\/+/, ''), lineRange(opts));
    const discussion = await gl(c, 'POST', `${mrApi(c)}/discussions`, payload);
    if (status && RESOLVED_STATUSES.includes(status)) await gl(c, 'PUT', `${mrApi(c)}/discussions/${discussion.id}`, { resolved: true });
    return { existing: false, id: discussion.id, status: status ?? 'active', url: noteUrl(c, discussion.notes?.[0]?.id) };
  },

  async reply(c, pos, opts) {
    requirePr(c);
    const threadId = discussionId(pos[1], 'reply needs <pr> <threadId>');
    requireToken(c);
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    const status = optionalStatus(opts);
    const discussion = key || status ? await gl(c, 'GET', `${mrApi(c)}/discussions/${threadId}`) : null;
    if (key && discussion.notes.some((note) => readMarker(note.body).key === key)) {
      const current = deriveStatus(discussion.notes.map((note) => ({ content: note.body })), resolvedFlag(discussion));
      return { existing: true, threadId, status: status && status !== current ? await applyStatus(c, discussion, status, await me(c)) : current };
    }
    const note = await gl(c, 'POST', `${mrApi(c)}/discussions/${threadId}/notes`, { body: withMarker(body, { key, status }) });
    if (status) {
      // A reply turns a single comment into a resolvable thread.
      const target = RESOLVED_STATUSES.includes(status);
      const resolved = resolvedFlag(discussion);
      if ((resolved ?? false) !== target && (resolved !== null || discussion.individual_note)) {
        await gl(c, 'PUT', `${mrApi(c)}/discussions/${threadId}`, { resolved: target });
      }
    }
    return { existing: false, threadId, commentId: note.id, status };
  },

  async 'set-status'(c, pos) {
    requirePr(c);
    const threadId = discussionId(pos[1], 'set-status needs <pr> <threadId> <status>');
    const status = checkStatus(pos[2]);
    requireToken(c);
    const [discussion, self] = await Promise.all([gl(c, 'GET', `${mrApi(c)}/discussions/${threadId}`), me(c)]);
    return { threadId, status: await applyStatus(c, discussion, status, self) };
  },

  async 'set-description'(c, _pos, opts) {
    requirePr(c);
    const description = readBody(opts);
    if (description.length > DESCRIPTION_LIMIT) {
      throw new UsageError(`description is ${description.length} characters; GitLab keeps at most ${DESCRIPTION_LIMIT}. Shorten it and move detail into a thread.`);
    }
    requireToken(c);
    await gl(c, 'PUT', mrApi(c), { description });
    return { id: c.prId, length: description.length };
  },

  // GitLab derives draft from the title prefix.
  async publish(c) {
    requirePr(c);
    requireToken(c);
    const mr = await gl(c, 'GET', mrApi(c));
    let title = mr.title;
    while (DRAFT_PREFIX.test(title)) title = title.replace(DRAFT_PREFIX, '');
    if (title === mr.title) return { id: c.prId, isDraft: !!mr.draft, title };
    const updated = await gl(c, 'PUT', mrApi(c), { title });
    return { id: c.prId, isDraft: !!updated.draft, title };
  },

  async checks(c) {
    requirePr(c);
    return readChecks(c, await gl(c, 'GET', mrApi(c)));
  },

  async 'rerun-check'(c, pos) {
    requirePr(c);
    const ref = parseRunRef(pos[1]);
    if (!ref) throw new UsageError(`rerun-check needs <pr> <checkId>, the id of a job check (the approval and pipeline checks cannot be re-run)`);
    requireToken(c);
    const projectId = ref.project ?? enc(c.projectPath);
    const job = await gl(c, 'POST', `${apiUrl(c)}/projects/${projectId}/jobs/${ref.id}/retry`);
    return { checkId: pos[1], newCheckId: ref.project ? `${ref.project}:${job.id}` : job.id, status: CHECK_STATUS[job.status] ?? job.status };
  },

  async 'check-failures'(c, pos, opts) {
    const ref = parseRunRef(pos[0]);
    if (!ref) throw new UsageError('check-failures needs <runId> (the runId of a build check: a pipeline id)');
    const tail = Number(opts.tail ?? 80);
    const projectId = ref.project ?? enc(c.projectPath);
    const base = `${apiUrl(c)}/projects/${projectId}/pipelines/${ref.id}`;
    const [pipeline, jobs, bridges] = await Promise.all([
      gl(c, 'GET', base),
      paginate(c, `${base}/jobs?scope[]=failed&include_retried=false`),
      optional(paginate(c, `${base}/bridges?scope[]=failed`)),
    ]);
    const home = ref.project ? null : pipeline.project_id; // the context project's numeric id, when known
    const steps = pipeline.yaml_errors ? [{ id: null, name: 'pipeline configuration', url: pipeline.web_url, issues: [pipeline.yaml_errors], logTail: '' }] : [];
    for (const job of jobs.sort((a, b) => a.id - b.id)) {
      const issues = [job.failure_reason && `failure_reason: ${job.failure_reason}`, job.allow_failure && 'allowed to fail'].filter(Boolean);
      let logTail = '';
      try {
        logTail = cleanLog(await jobLog(c, projectId, job)).slice(-tail).join('\n');
      } catch (error) {
        issues.push(`log not readable: ${error.message.split('\n')[0].slice(0, 200)}`);
      }
      steps.push({ id: runRef(pipeline.project_id, job.id, home), name: `${job.stage}: ${job.name}`, url: job.web_url, issues, logTail });
    }
    for (const bridge of bridges ?? []) {
      const downstream = bridge.downstream_pipeline;
      const issues = [downstream ? `downstream pipeline ${downstream.status}: check-failures ${runRef(downstream.project_id, downstream.id, home)}` : 'no downstream pipeline'];
      steps.push({ id: runRef(pipeline.project_id, bridge.id, home), name: `${bridge.stage}: ${bridge.name}`, url: downstream?.web_url ?? null, issues, logTail: '' });
    }
    const finished = FINISHED.includes(pipeline.status);
    return { runId: ref.project ? pos[0] : Number(ref.id), status: finished ? 'completed' : pipeline.status, result: finished ? pipeline.status : null, commit: pipeline.sha, url: pipeline.web_url, failedSteps: steps };
  },

  async 'auto-merge'(c, _pos, opts) {
    requirePr(c);
    requireToken(c);
    const mr = await gl(c, 'GET', mrApi(c));
    const { strategy, options } = await mergeOptions(c, mr, opts);
    const result = await putMerge(c, mr, { ...options, auto_merge: true, merge_when_pipeline_succeeds: true });
    const mergedNow = result.state === 'merged';
    return { id: c.prId, autoMerge: !mergedNow && autoMergeSet(result), mergedNow, strategy, deleteSourceBranch: options.should_remove_source_branch };
  },

  async 'cancel-auto-merge'(c) {
    requirePr(c);
    requireToken(c);
    const mr = await gl(c, 'POST', `${mrApi(c)}/cancel_merge_when_pipeline_succeeds`);
    return { id: c.prId, autoMerge: autoMergeSet(mr) };
  },

  async merge(c, _pos, opts) {
    requirePr(c);
    requireToken(c);
    const mr = await gl(c, 'GET', mrApi(c));
    const { options } = await mergeOptions(c, mr, opts);
    const result = await putMerge(c, mr, options);
    return { id: c.prId, status: STATE[result.state] ?? null, mergeCommit: result.merge_commit_sha ?? result.squash_commit_sha ?? null };
  },

  async watch(c, _pos, opts) {
    requirePr(c);
    const self = await me(c);
    return watchLoop(c.prId, opts.interval, async () => {
      const mr = await gl(c, 'GET', mrApi(c));
      const [checks, threads] = await Promise.all([readChecks(c, mr), readThreads(c, self)]);
      const summary = summarizePr(c, mr, {}, self);
      return { status: summary.status, state: watchState(summary, checks), comments: peopleComments(threads) };
    });
  },
};
