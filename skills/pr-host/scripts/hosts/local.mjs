// Plain git, no PR host: a repository without a remote, or whose remote is on a host without an adapter
// (Bitbucket, Gitea, a bare repository on a server). A review is a JSON record in the repository's common
// git directory, shared by every worktree and never committed, plus a Markdown page rendered from it after
// every write so a person can read the review:
//
//   <git-common-dir>/pr-host/<id>.json   title, description, branches, status, threads
//   <git-common-dir>/pr-host/<id>.md     the page webUrl points to, one anchor per thread
//
// Records are replaced atomically and rewritten under a lock file, so several sessions and worktrees can
// work on one review. Branches are <remote>/<branch> when the repository has the remote, else local
// branches. There is no CI (checks is empty) and nothing merges by itself.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  UsageError, checkStatus, git, isDryRun, lineRange, logDryRun, normalizeStrategy, optionalStatus, peopleComments,
  readBody, readMarker, requirePr, sleep, tryGit, watchLoop, watchState, withMarker,
} from '../lib.mjs';

export const platform = 'local';

// A write holds the lock for milliseconds, so an older lock was left by a process that died, and a waiter
// outlasts it.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// Context

// The fallback host: any remote, or none. The repository is the one around the current directory.
export function fromRemote(url, { opts, remote }) {
  if (!url && typeof opts.remote === 'string') throw new UsageError(`no remote named "${remote}" in this repository`);
  return { remoteUrl: url ?? '', remote };
}

export const fromPrUrl = () => null;

// Worktrees of the repository, the main one first: [{ path, branch (refs/heads/... or null), prunable }].
function worktrees() {
  return (tryGit(['worktree', 'list', '--porcelain']) ?? '').split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    const field = (name) => lines.find((line) => line === name || line.startsWith(`${name} `))?.slice(name.length + 1);
    return { path: field('worktree'), branch: field('branch') ?? null, prunable: field('prunable') !== undefined };
  });
}

// The common git directory is shared by every worktree; reviews live in its pr-host/.
let cachedRepo;
function repo() {
  if (cachedRepo) return cachedRepo;
  const commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) throw new Error('not inside a git repository: run pr-host from a checkout or worktree of the repository under review');
  cachedRepo = { commonDir, dir: join(commonDir, 'pr-host') };
  return cachedRepo;
}

let cachedMe;
function me() {
  if (cachedMe) return cachedMe;
  const name = tryGit(['config', 'user.name']) || null;
  const email = tryGit(['config', 'user.email']) || null;
  const login = process.env.USERNAME || process.env.USER || 'unknown';
  cachedMe = { id: email ?? name ?? login, name: name ?? email ?? login, uniqueName: email };
  return cachedMe;
}

const recordPath = (r, id) => join(r.dir, `${id}.json`);
const pagePath = (r, id) => join(r.dir, `${id}.md`);
const pageUrl = (r, id) => pathToFileURL(pagePath(r, id)).href;
const threadUrl = (r, id, threadId) => `${pageUrl(r, id)}#thread-${threadId}`;

const hasRemote = (c) => !!c.remoteUrl;
const branchName = (name) => name.replace(/^refs\/heads\//, '');
const branchRef = (c, branch) => (hasRemote(c) ? `refs/remotes/${c.remote}/${branch}` : `refs/heads/${branch}`);
const branchLabel = (c, branch) => (hasRemote(c) ? `${c.remote}/${branch}` : branch);
const commitOf = (ref) => tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

function defaultTarget(c) {
  if (hasRemote(c)) {
    const head = tryGit(['symbolic-ref', '--quiet', `refs/remotes/${c.remote}/HEAD`]);
    if (head) return head.replace(`refs/remotes/${c.remote}/`, '');
  }
  return ['main', 'master'].find((branch) => commitOf(branchRef(c, branch))) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Records

const now = () => new Date().toISOString();
const nextId = (items) => Math.max(0, ...items.map((item) => item.id)) + 1;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function load(r, id) {
  let text;
  try {
    text = readFileSync(recordPath(r, id), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`no review ${id} in ${r.dir}; start one with: open --source <branch>`);
    throw error;
  }
  return JSON.parse(text);
}

function list(r) {
  let names = [];
  try {
    names = readdirSync(r.dir);
  } catch {
    // no review yet
  }
  return names.filter((name) => /^\d+\.json$/.test(name)).map((name) => load(r, Number.parseInt(name, 10))).sort((a, b) => a.id - b.id);
}

// Readers never take the lock, so a file is written next to its place and renamed over it.
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      // Windows refuses to replace a file another program holds open for a moment (a viewer, a scanner).
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        rmSync(temp, { force: true });
        throw error;
      }
      pause(50);
    }
  }
}

function save(r, review) {
  review.updated = now();
  mkdirSync(r.dir, { recursive: true });
  writeAtomic(recordPath(r, review.id), `${JSON.stringify(review, null, 2)}\n`);
  writeAtomic(pagePath(r, review.id), render(review));
}

async function withLock(r, name, fn) {
  mkdirSync(r.dir, { recursive: true });
  const lock = join(r.dir, `${name}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age > LOCK_STALE_MS) rmSync(lock, { force: true });
    else if (Date.now() > deadline) throw new Error(`${lock} is held by another pr-host process; retry, or delete it if none is running`);
    else await sleep(50);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

// One change to a review. apply(review) answers without a change ({ result }: a key that already exists),
// or changes the review it is given and returns { result, entry }, entry describing the change for the
// dry-run log. Under PR_HOST_DRY_RUN the change is applied to a copy, logged and not saved.
async function change(r, id, action, apply) {
  if (isDryRun()) {
    const { result, entry } = apply(load(r, id));
    if (!entry) return result;
    logDryRun({ method: 'local', action, review: id, file: recordPath(r, id), ...entry });
    return { ...result, dryRun: true };
  }
  return withLock(r, id, () => {
    const review = load(r, id);
    const { result, entry } = apply(review);
    if (entry) save(r, review);
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Page

const stamp = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '');
const quote = (text) => text.split(/\r?\n/).map((line) => (line ? `> ${line}` : '>')).join('\n');
const span = (thread) => (thread.endLine && thread.endLine !== thread.line ? `${thread.line}-${thread.endLine}` : `${thread.line}`);

function render(review) {
  const out = [
    `<!-- Written by pr-host from ${review.id}.json after every change; edits here are overwritten. -->`,
    '',
    `# Review ${review.id}: ${review.title}`,
    '',
    `\`${review.sourceBranch}\` into \`${review.targetBranch}\` · ${review.status}${review.isDraft ? ' · draft' : ''} · opened by ${review.author.name} ${stamp(review.created)}`,
  ];
  if (review.merged) {
    const commit = review.mergeCommit ? ` as \`${review.mergeCommit.slice(0, 12)}\`` : '';
    out.push('', `Merged${commit} (${review.merged.strategy}) by ${review.merged.by} ${stamp(review.merged.at)}`);
  }
  out.push('', '## Description', '', review.description || '_No description._', '', `## Threads (${review.threads.length})`);
  for (const thread of review.threads) {
    const where = thread.file ? ` · \`${thread.file}:${span(thread)}\`` : '';
    out.push('', `### <a id="thread-${thread.id}"></a>Thread ${thread.id} · ${thread.status}${where}`);
    for (const comment of thread.comments) out.push('', `**${comment.author}** · ${stamp(comment.published)}`, '', quote(comment.content));
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Shapes

const firstLines = (error) => (error.stderr?.toString().trim() || error.message).split(/\r?\n/).slice(0, 8).join('\n');

// git merge-tree merges without a worktree: exit 0 is clean, 1 has conflicts.
function mergeCheck(target, source) {
  try {
    git(['merge-tree', '--write-tree', '--name-only', '--no-messages', target, source]);
    return { status: 'ok', raw: 'clean', files: [] };
  } catch (error) {
    if (error.status !== 1) return { status: 'unknown', raw: firstLines(error), files: [] };
    const files = String(error.stdout ?? '').trim().split(/\r?\n/).slice(1).filter(Boolean);
    return { status: 'conflicts', raw: `conflicts in ${files.join(', ')}`, files };
  }
}

function branchState(c, review) {
  if (review.merged) {
    return { sourceCommit: review.merged.sourceCommit, targetCommit: review.merged.targetCommit, mergeStatus: 'ok', mergeStatusRaw: 'merged' };
  }
  const sourceCommit = commitOf(branchRef(c, review.sourceBranch));
  const targetCommit = commitOf(branchRef(c, review.targetBranch));
  const missing = [!sourceCommit && review.sourceBranch, !targetCommit && review.targetBranch].filter(Boolean);
  const check = missing.length
    ? { status: 'unknown', raw: `${missing.map((branch) => branchLabel(c, branch)).join(' and ')} not found` }
    : mergeCheck(targetCommit, sourceCommit);
  return { sourceCommit, targetCommit, mergeStatus: check.status, mergeStatusRaw: check.raw };
}

function summarize(c, r, review, self) {
  const { sourceCommit, targetCommit, mergeStatus, mergeStatusRaw } = branchState(c, review);
  return {
    platform,
    id: review.id,
    title: review.title,
    description: review.description ?? '',
    status: review.status,
    isDraft: !!review.isDraft,
    author: review.author,
    isMine: true,
    sourceBranch: review.sourceBranch,
    targetBranch: review.targetBranch,
    sourceCommit,
    targetCommit,
    mergeCommit: review.mergeCommit ?? null,
    mergeStatus,
    mergeStatusRaw,
    autoMerge: null,
    reviewers: [],
    limits: { description: null },
    webUrl: pageUrl(r, review.id),
    repoWebUrl: null,
    me: self,
  };
}

const threadKey = (thread) => readMarker(thread.comments[0]?.content).key;

function summarizeThread(r, review, thread, self) {
  const comments = thread.comments.map((comment) => ({
    id: comment.id,
    author: comment.author,
    isMine: comment.authorId === self.id,
    type: comment.type,
    key: readMarker(comment.content).key,
    content: comment.content,
    published: comment.published,
  }));
  const key = comments[0]?.key ?? null;
  const isSystem = comments.length > 0 && comments.every((comment) => comment.type === 'system');
  return {
    id: thread.id,
    kind: isSystem ? 'system' : key ? 'bot' : 'human',
    key,
    status: thread.status,
    file: thread.file,
    line: thread.line,
    url: threadUrl(r, review.id, thread.id),
    comments,
    updated: thread.updated,
  };
}

const readThreads = (r, review, self) => review.threads.map((thread) => summarizeThread(r, review, thread, self));

function findThread(review, threadId) {
  const thread = review.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`review ${review.id} has no thread ${threadId}`);
  return thread;
}

// Comment ids are unique across the review, not per thread, so watch tells every comment apart.
const newComment = (review, self, body, key) => ({
  id: nextId(review.threads.flatMap((thread) => thread.comments)),
  author: self.name,
  authorId: self.id,
  type: 'text',
  content: withMarker(body, { key }),
  published: now(),
});

// ---------------------------------------------------------------------------------------------
// Merge. The result is built in a temporary detached worktree, so no checkout changes under anyone, then
// lands: pushed to the remote; or, without one, fast-forwarded in the worktree that has the target checked
// out (only when it is clean), or moved with update-ref when no worktree has it.

// git, or under PR_HOST_DRY_RUN only a log line of the command it would have run.
function run(args, cwd) {
  if (isDryRun()) {
    logDryRun({ method: 'git', args, cwd: cwd ?? process.cwd() });
    return '';
  }
  return git(args, cwd);
}

const conflictError = (files) =>
  new Error(`merge conflicts in ${files.join(', ')}; resolve them on the source branch (merge or rebase the target into it), then merge again`);

// Builds the merge in `dir`, a detached worktree at the target, and returns the commit to land.
function combine(dir, strategy, { sourceSha, targetSha, message }) {
  const step = (args, abort) => {
    try {
      run(args, dir);
    } catch (error) {
      const files = (tryGit(['diff', '--name-only', '--diff-filter=U'], dir) ?? '').split(/\r?\n/).filter(Boolean);
      tryGit(abort, dir);
      throw files.length ? conflictError(files) : new Error(`git ${args[0]} failed: ${firstLines(error)}`);
    }
  };
  const head = () => (isDryRun() ? '<merged commit>' : git(['rev-parse', 'HEAD'], dir));
  if (strategy === 'merge') {
    step(['merge', '--no-ff', '--no-edit', '-m', message, sourceSha], ['merge', '--abort']);
    return head();
  }
  if (strategy === 'squash') {
    step(['merge', '--squash', sourceSha], ['reset', '--hard', '--quiet']);
    // Nothing staged means the target has every change already; HEAD stays at the target.
    if (isDryRun() || tryGit(['diff', '--cached', '--quiet'], dir) === null) step(['commit', '--quiet', '-m', message], ['reset', '--hard', '--quiet']);
    return head();
  }
  // rebase and rebase-merge replay the source onto the target, never moving a branch along with it.
  step(['rebase', '--quiet', '--no-update-refs', '--no-autosquash', targetSha, sourceSha], ['rebase', '--abort']);
  if (strategy === 'rebase') return head();
  const rebased = head();
  run(['switch', '--quiet', '--detach', targetSha], dir);
  step(['merge', '--no-ff', '--no-edit', '-m', message, rebased], ['merge', '--abort']);
  return head();
}

function land(c, review, { dir, newSha, targetSha, checkout }) {
  const target = review.targetBranch;
  if (hasRemote(c)) {
    try {
      run(['push', '--quiet', c.remote, `HEAD:refs/heads/${target}`], dir);
    } catch (error) {
      // Rejected as not a fast-forward, or the remote's ref changed while the push ran.
      if (/\[rejected\]|non-fast-forward|fetch first|incorrect old value/.test(String(error.stderr))) {
        throw new Error(`push rejected: ${target} on ${c.remote} moved since the fetch; run merge again`);
      }
      throw new Error(`git push failed: ${firstLines(error)}`);
    }
  } else if (checkout) {
    try {
      run(['merge', '--ff-only', '--quiet', newSha], checkout.path);
    } catch (error) {
      throw new Error(`could not fast-forward ${target} in ${checkout.path} (it moved, or files there are in the way); run merge again: ${firstLines(error)}`);
    }
  } else {
    try {
      run(['update-ref', '-m', `pr-host: merge review ${review.id}`, `refs/heads/${target}`, newSha, targetSha]);
    } catch (error) {
      throw new Error(`${target} moved during the merge; run merge again (${firstLines(error)})`);
    }
  }
}

function removeWorktree(dir) {
  if (isDryRun()) return void run(['worktree', 'remove', '--force', dir]);
  if (tryGit(['worktree', 'remove', '--force', dir]) !== null) return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  tryGit(['worktree', 'prune']);
}

// Deletes the merged source branch; returns why it was kept, or null once deleted.
function deleteSource(c, review, sourceSha) {
  const source = review.sourceBranch;
  if (hasRemote(c)) {
    try {
      // The lease refuses when someone pushed to the branch since the fetch: those commits were not merged.
      run(['push', '--quiet', `--force-with-lease=refs/heads/${source}:${sourceSha}`, c.remote, `:refs/heads/${source}`]);
      return null;
    } catch (error) {
      return `${c.remote}/${source} was not deleted: ${firstLines(error)}`;
    }
  }
  const holder = worktrees().find((worktree) => worktree.branch === `refs/heads/${source}`);
  if (holder) return `${source} is checked out in ${holder.path}, so it was kept`;
  if (commitOf(`refs/heads/${source}`) !== sourceSha) return `${source} moved during the merge, so it was kept`;
  try {
    run(['branch', '--quiet', '-D', source]);
    return null;
  } catch (error) {
    return `${source} was not deleted: ${firstLines(error)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

export const commands = {
  context(c) {
    const r = repo();
    return {
      platform,
      repo: resolve(worktrees()[0]?.path ?? r.commonDir),
      remote: hasRemote(c) ? c.remote : null,
      remoteUrl: c.remoteUrl || null,
      reviews: r.dir,
      prId: c.prId ?? null,
      prWebUrl: c.prId ? pageUrl(r, c.prId) : null,
      repoWebUrl: null,
      me: me(),
    };
  },

  async open(c, _pos, opts) {
    if (typeof opts.source !== 'string') throw new UsageError('open needs --source <branch>');
    const r = repo();
    const self = me();
    const source = branchName(opts.source);
    const target = typeof opts.target === 'string' ? branchName(opts.target) : defaultTarget(c);
    if (!target) throw new UsageError(`cannot tell the target branch (no ${hasRemote(c) ? `${c.remote}/HEAD, ` : ''}main or master): pass --target <branch>`);
    if (source === target) throw new UsageError(`source and target are both ${source}`);
    for (const branch of [source, target]) {
      if (!commitOf(branchRef(c, branch))) {
        throw new Error(`${branchLabel(c, branch)} not found${hasRemote(c) ? `: push the branch (or fetch ${c.remote}) first` : ''}`);
      }
    }
    const description = typeof opts.body === 'string' || typeof opts['body-file'] === 'string' ? readBody(opts) : '';
    const create = () => {
      const reviews = list(r);
      const existing = reviews.find((review) => review.status === 'active' && review.sourceBranch === source);
      if (existing) return { existing: true, review: existing };
      const at = now();
      const review = {
        version: 1,
        id: nextId(reviews),
        title: typeof opts.title === 'string' ? opts.title : source,
        description,
        status: 'active',
        isDraft: opts.draft === true,
        author: self,
        sourceBranch: source,
        targetBranch: target,
        created: at,
        updated: at,
        mergeCommit: null,
        merged: null,
        threads: [],
      };
      return { existing: false, review };
    };
    let outcome;
    if (isDryRun()) {
      outcome = create();
      if (!outcome.existing) logDryRun({ method: 'local', action: 'open', review: outcome.review.id, file: recordPath(r, outcome.review.id), record: outcome.review });
    } else {
      outcome = await withLock(r, 'open', () => {
        const created = create();
        if (!created.existing) save(r, created.review);
        return created;
      });
    }
    const dryRun = isDryRun() && !outcome.existing ? { dryRun: true } : {};
    return { existing: outcome.existing, ...summarize(c, r, outcome.review, self), ...dryRun };
  },

  find(c, _pos, opts) {
    if (typeof opts.branch !== 'string') throw new UsageError('find needs --branch <name>');
    const r = repo();
    const branch = branchName(opts.branch);
    return list(r)
      .filter((review) => review.status === 'active' && review.sourceBranch === branch)
      .map((review) => ({ id: review.id, title: review.title, isDraft: !!review.isDraft, webUrl: pageUrl(r, review.id) }));
  },

  show(c) {
    requirePr(c);
    const r = repo();
    return summarize(c, r, load(r, c.prId), me());
  },

  threads(c, _pos, opts) {
    requirePr(c);
    const r = repo();
    const threads = readThreads(r, load(r, c.prId), me());
    return opts.all ? threads : threads.filter((thread) => thread.kind !== 'system');
  },

  async 'thread-create'(c, _pos, opts) {
    requirePr(c);
    const r = repo();
    const self = me();
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    const status = optionalStatus(opts) ?? 'active';
    const place = typeof opts.file === 'string'
      ? { file: opts.file.replace(/\\/g, '/').replace(/^(\.?\/)+/, ''), ...lineRange(opts) }
      : { file: null, line: null, endLine: null };
    return change(r, c.prId, 'thread-create', (review) => {
      const existing = key && review.threads.find((thread) => threadKey(thread) === key);
      if (existing) return { result: { existing: true, id: existing.id, status: existing.status, url: threadUrl(r, review.id, existing.id) } };
      const comment = newComment(review, self, body, key);
      const thread = { id: nextId(review.threads), status, ...place, comments: [comment], updated: comment.published };
      review.threads.push(thread);
      return { result: { existing: false, id: thread.id, status, url: threadUrl(r, review.id, thread.id) }, entry: { thread } };
    });
  },

  async reply(c, pos, opts) {
    requirePr(c);
    const threadId = Number(pos[1]);
    if (!threadId) throw new UsageError('reply needs <pr> <threadId>');
    const r = repo();
    const self = me();
    const body = readBody(opts);
    const key = typeof opts.key === 'string' ? opts.key : null;
    const status = optionalStatus(opts);
    return change(r, c.prId, 'reply', (review) => {
      const thread = findThread(review, threadId);
      const existing = key && thread.comments.find((comment) => readMarker(comment.content).key === key);
      if (existing) {
        const result = { existing: true, threadId, commentId: existing.id, status: status ?? thread.status };
        if (!status || status === thread.status) return { result };
        thread.status = status;
        thread.updated = now();
        return { result, entry: { threadId, status } };
      }
      const comment = newComment(review, self, body, key);
      thread.comments.push(comment);
      if (status) thread.status = status;
      thread.updated = comment.published;
      return { result: { existing: false, threadId, commentId: comment.id, status: thread.status }, entry: { threadId, comment, status } };
    });
  },

  async 'set-status'(c, pos) {
    requirePr(c);
    const threadId = Number(pos[1]);
    if (!threadId) throw new UsageError('set-status needs <pr> <threadId> <status>');
    const status = checkStatus(pos[2]);
    return change(repo(), c.prId, 'set-status', (review) => {
      const thread = findThread(review, threadId);
      if (thread.status === status) return { result: { threadId, status } };
      thread.status = status;
      thread.updated = now();
      return { result: { threadId, status }, entry: { threadId, status } };
    });
  },

  // No length limit: the record holds any description (show reports limits.description null).
  async 'set-description'(c, _pos, opts) {
    requirePr(c);
    const description = readBody(opts);
    return change(repo(), c.prId, 'set-description', (review) => {
      review.description = description;
      return { result: { id: review.id, length: description.length }, entry: { description } };
    });
  },

  async publish(c) {
    requirePr(c);
    return change(repo(), c.prId, 'publish', (review) => {
      if (!review.isDraft) return { result: { id: review.id, isDraft: false } };
      review.isDraft = false;
      return { result: { id: review.id, isDraft: false }, entry: { isDraft: false } };
    });
  },

  // No CI here: the skills run the repository's own checks.
  checks(c) {
    requirePr(c);
    const r = repo();
    load(r, c.prId);
    return [];
  },

  async merge(c, _pos, opts) {
    requirePr(c);
    const strategy = normalizeStrategy(opts.strategy);
    const r = repo();
    const self = me();
    const review = load(r, c.prId);
    if (review.status !== 'active') throw new Error(`review ${review.id} is ${review.status}; only an active review merges`);
    if (review.isDraft) throw new Error(`review ${review.id} is a draft: publish it first`);
    const { sourceBranch: source, targetBranch: target } = review;

    if (hasRemote(c)) {
      process.env.GIT_TERMINAL_PROMPT ??= '0';
      try {
        run(['fetch', '--quiet', c.remote, `+refs/heads/${source}:refs/remotes/${c.remote}/${source}`, `+refs/heads/${target}:refs/remotes/${c.remote}/${target}`]);
      } catch (error) {
        throw new Error(`git fetch ${c.remote} failed: ${firstLines(error)}`);
      }
    }
    const sourceSha = commitOf(branchRef(c, source));
    const targetSha = commitOf(branchRef(c, target));
    if (!sourceSha || !targetSha) throw new Error(`${branchLabel(c, sourceSha ? target : source)} not found`);
    const notes = [];
    let checkout = null;
    if (hasRemote(c)) {
      const local = commitOf(`refs/heads/${source}`);
      if (local && tryGit(['merge-base', '--is-ancestor', local, sourceSha]) === null) {
        notes.push(`local ${source} has commits that ${c.remote}/${source} lacks; they were not merged`);
      }
    } else {
      checkout = worktrees().find((worktree) => worktree.branch === `refs/heads/${target}` && !worktree.prunable) ?? null;
      if (checkout && git(['status', '--porcelain'], checkout.path)) {
        throw new Error(`${target} is checked out in ${checkout.path} with uncommitted changes; commit or stash them there (or switch that worktree to another branch), then merge again`);
      }
    }

    let mergeCommit = null;
    if (tryGit(['merge-base', '--is-ancestor', sourceSha, targetSha]) !== null) {
      notes.push(`${branchLabel(c, target)} already contains ${branchLabel(c, source)}; nothing new was merged`);
    } else {
      // A rebase replays commit by commit and can apply cleanly where a single 3-way merge would not.
      if (!strategy.startsWith('rebase')) {
        const check = mergeCheck(targetSha, sourceSha);
        if (check.status === 'conflicts') throw conflictError(check.files);
      }
      const message = typeof opts.message === 'string'
        ? opts.message
        : strategy === 'squash' ? `${review.title} (#${review.id})` : `Merge branch '${source}' into ${target}\n\n${review.title} (#${review.id})`;
      const dir = isDryRun() ? join(tmpdir(), 'pr-host-merge-XXXXXX') : mkdtempSync(join(tmpdir(), 'pr-host-merge-'));
      try {
        try {
          run(['worktree', 'add', '--quiet', '--detach', dir, targetSha]);
        } catch (error) {
          throw new Error(`could not create a temporary worktree: ${firstLines(error)}`);
        }
        const newSha = combine(dir, strategy, { sourceSha, targetSha, message });
        if (newSha === targetSha) throw new Error(`nothing to merge: ${branchLabel(c, target)} already has every change of ${branchLabel(c, source)}`);
        land(c, review, { dir, newSha, targetSha, checkout });
        mergeCommit = isDryRun() ? null : newSha;
      } finally {
        removeWorktree(dir);
      }
    }

    // The merge has landed: record it before the source branch goes, so a failure there loses nothing.
    const recorded = await change(r, review.id, 'merge', (current) => {
      current.status = 'completed';
      current.mergeCommit = mergeCommit;
      current.merged = { strategy, sourceCommit: sourceSha, targetCommit: targetSha, by: self.name, at: now() };
      return { result: { id: current.id, status: current.status, mergeCommit, strategy }, entry: { status: current.status, mergeCommit, merged: current.merged } };
    });
    const kept = opts['keep-source-branch'] ? 'kept: --keep-source-branch' : deleteSource(c, review, sourceSha);
    if (kept && !opts['keep-source-branch']) notes.push(kept);
    return { ...recorded, sourceBranchDeleted: !kept, notes };
  },

  async watch(c, _pos, opts) {
    requirePr(c);
    const r = repo();
    const self = me();
    load(r, c.prId);
    // The branches' heads now, not the commits a completed review recorded, so the merge itself shows.
    const head = (branch) => commitOf(branchRef(c, branch))?.slice(0, 7) ?? 'none';
    return watchLoop(c.prId, opts.interval, () => {
      // Others push to the remote from their own clones; fetch so their moves show up here.
      if (hasRemote(c)) {
        process.env.GIT_TERMINAL_PROMPT ??= '0';
        tryGit(['fetch', '--quiet', c.remote]);
      }
      const review = load(r, c.prId);
      const summary = summarize(c, r, review, self);
      return {
        status: summary.status,
        state: { ...watchState(summary, []), source: head(review.sourceBranch), target: head(review.targetBranch) },
        comments: peopleComments(readThreads(r, review, self)),
      };
    });
  },
};
