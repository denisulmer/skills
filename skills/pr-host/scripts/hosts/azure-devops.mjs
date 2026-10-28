// Azure DevOps over the REST API. Auth: AZURE_DEVOPS_EXT_PAT or ADO_PAT (Basic), otherwise a token from
// the signed-in Azure CLI.

import {
  UsageError, checkStatus, enc, lineRange, normalizeStrategy, optionalStatus, peopleComments, readBody,
  readMarker, request, requirePr, sh, watchLoop, watchState, withMarker,
} from '../lib.mjs';

export const platform = 'azure-devops';

const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const API = '7.1';
const DESCRIPTION_LIMIT = 4000;
const VOTES = { 10: 'approved', 5: 'approved-with-suggestions', 0: 'none', [-5]: 'waiting-for-author', [-10]: 'rejected' };
const TO_ADO_STRATEGY = { merge: 'noFastForward', squash: 'squash', rebase: 'rebase', 'rebase-merge': 'rebaseMerge' };
const CHECK_STATUS = { queued: 'queued', running: 'running', approved: 'passed', rejected: 'failed', broken: 'failed', notApplicable: 'skipped' };
const MERGE_STATUS = { succeeded: 'ok', conflicts: 'conflicts', queued: 'checking' };

// ---------------------------------------------------------------------------------------------
// Context

function parse(url) {
  const patterns = [
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/,
    /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/,
    /([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/,
  ];
  for (const pattern of patterns) {
    const match = (url ?? '').match(pattern);
    if (match) return { org: match[1], project: decodeURIComponent(match[2]), repo: decodeURIComponent(match[3]) };
  }
  return null;
}

export function fromRemote(url, { forced, opts }) {
  const parsed = parse(url);
  if (!parsed && !forced && !(opts.org && opts.project && opts.repo)) return null;
  const c = { org: opts.org ?? parsed?.org, project: opts.project ?? parsed?.project, repo: opts.repo ?? parsed?.repo };
  if (!c.org || !c.project || !c.repo) {
    throw new UsageError('cannot tell the organization, project and repository: pass a PR URL, run inside an Azure Repos checkout, or pass --org --project --repo');
  }
  return c;
}

export function fromPrUrl(url) {
  const parsed = parse(url);
  const prId = url.match(/pullrequest\/(\d+)/i)?.[1];
  return parsed && prId ? { ...parsed, prId: Number(prId) } : null;
}

const orgUrl = (c) => `https://dev.azure.com/${enc(c.org)}`;
const projectUrl = (c) => `${orgUrl(c)}/${enc(c.project)}`;
const repoApi = (c) => `${projectUrl(c)}/_apis/git/repositories/${enc(c.repo)}`;
const prApi = (c) => `${repoApi(c)}/pullRequests/${c.prId}`;
const repoWebUrl = (c) => `${projectUrl(c)}/_git/${enc(c.repo)}`;
const prWebUrl = (c) => `${repoWebUrl(c)}/pullrequest/${c.prId}`;

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

const ado = (method, url, body, accept) => request(method, url, { headers: { Authorization: auth() }, body, accept });

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
    platform,
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
    mergeStatus: MERGE_STATUS[pr.mergeStatus] ?? 'unknown',
    mergeStatusRaw: pr.mergeStatus ?? null,
    autoMerge: pr.autoCompleteSetBy
      ? { by: person(pr.autoCompleteSetBy), strategy: normalizeStrategy(pr.completionOptions?.mergeStrategy), deleteSourceBranch: !!pr.completionOptions?.deleteSourceBranch }
      : null,
    reviewers: (pr.reviewers ?? []).map((r) => ({ name: r.displayName, vote: VOTES[r.vote] ?? r.vote, isRequired: !!r.isRequired })),
    limits: { description: DESCRIPTION_LIMIT },
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
      author: comment.author?.displayName ?? null,
      isMine: comment.author?.id === self.id,
      type: comment.commentType,
      key: readMarker(comment.content).key,
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

async function readChecks(c, projectId) {
  const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId}/${c.prId}`;
  const data = await ado('GET', `${projectUrl(c)}/_apis/policy/evaluations?artifactId=${enc(artifact)}&api-version=${API}-preview.1`);
  return data.value.map((evaluation) => {
    const type = evaluation.configuration?.type?.displayName ?? null;
    const runId = evaluation.context?.buildId ?? null;
    return {
      id: evaluation.evaluationId,
      name: evaluation.configuration?.settings?.displayName || type,
      kind: runId || /build/i.test(type ?? '') ? 'build' : /review/i.test(type ?? '') ? 'review' : 'other',
      isBlocking: !!evaluation.configuration?.isBlocking,
      status: CHECK_STATUS[evaluation.status] ?? evaluation.status,
      raw: evaluation.status,
      runId,
      url: runId ? `${projectUrl(c)}/_build/results?buildId=${runId}` : null,
    };
  });
}

function completionOptions(opts) {
  const options = { mergeStrategy: TO_ADO_STRATEGY[normalizeStrategy(opts.strategy)], deleteSourceBranch: !opts['keep-source-branch'], transitionWorkItems: true };
  if (typeof opts.message === 'string') options.mergeCommitMessage = opts.message;
  return options;
}

// ---------------------------------------------------------------------------------------------
// Commands

export const commands = {
  async context(c) {
    const self = await me(c);
    return { platform, org: c.org, project: c.project, repo: c.repo, prId: c.prId ?? null, prWebUrl: c.prId ? prWebUrl(c) : null, repoWebUrl: repoWebUrl(c), me: self };
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
      comments: [{ parentCommentId: 0, content: withMarker(body, { key }), commentType: 1 }],
      status: optionalStatus(opts) ?? 'active',
    };
    if (typeof opts.file === 'string') {
      const { line, endLine } = lineRange(opts);
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
    const status = optionalStatus(opts);
    if (key) {
      const thread = await ado('GET', `${prApi(c)}/threads/${threadId}?api-version=${API}`);
      if ((thread.comments ?? []).some((comment) => !comment.isDeleted && readMarker(comment.content).key === key)) {
        if (status && thread.status !== status) await ado('PATCH', `${prApi(c)}/threads/${threadId}?api-version=${API}`, { status });
        return { existing: true, threadId, status: status ?? thread.status };
      }
    }
    const comment = await ado('POST', `${prApi(c)}/threads/${threadId}/comments?api-version=${API}`, {
      content: withMarker(body, { key }),
      parentCommentId: 1,
      commentType: 1,
    });
    if (status) await ado('PATCH', `${prApi(c)}/threads/${threadId}?api-version=${API}`, { status });
    return { existing: false, threadId, commentId: comment.id, status };
  },

  async 'set-status'(c, pos) {
    requirePr(c);
    const threadId = Number(pos[1]);
    if (!threadId) throw new UsageError('set-status needs <pr> <threadId> <status>');
    const thread = await ado('PATCH', `${prApi(c)}/threads/${threadId}?api-version=${API}`, { status: checkStatus(pos[2]) });
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

  async checks(c) {
    requirePr(c);
    const pr = await ado('GET', `${prApi(c)}?api-version=${API}`);
    return readChecks(c, pr.repository.project.id);
  },

  async 'rerun-check'(c, pos) {
    requirePr(c);
    const evaluationId = pos[1];
    if (!evaluationId) throw new UsageError('rerun-check needs <pr> <checkId>');
    const evaluation = await ado('PATCH', `${projectUrl(c)}/_apis/policy/evaluations/${enc(evaluationId)}?api-version=${API}-preview.1`);
    return { checkId: evaluationId, status: CHECK_STATUS[evaluation.status] ?? evaluation.status };
  },

  async 'check-failures'(c, pos, opts) {
    const buildId = Number(pos[0]);
    if (!buildId) throw new UsageError('check-failures needs <runId> (the buildId of a build check)');
    const tail = Number(opts.tail ?? 80);
    const base = `${projectUrl(c)}/_apis/build/builds/${buildId}`;
    const [build, timeline] = await Promise.all([ado('GET', `${base}?api-version=${API}`), ado('GET', `${base}/timeline?api-version=${API}`)]);
    const failed = (timeline?.records ?? []).filter((record) => record.result === 'failed' && record.type === 'Task');
    const steps = [];
    for (const record of failed) {
      let logTail = '';
      if (record.log?.url) logTail = (await ado('GET', record.log.url, undefined, 'text/plain')).split(/\r?\n/).slice(-tail).join('\n');
      steps.push({ name: record.name, issues: (record.issues ?? []).map((issue) => issue.message), logTail });
    }
    return { runId: buildId, status: build.status, result: build.result ?? null, commit: build.sourceVersion, url: build._links?.web?.href ?? null, failedSteps: steps };
  },

  async 'auto-merge'(c, _pos, opts) {
    requirePr(c);
    const self = await me(c);
    const pr = await ado('PATCH', `${prApi(c)}?api-version=${API}`, { autoCompleteSetBy: { id: self.id }, completionOptions: completionOptions(opts) });
    return { id: c.prId, autoMerge: !!pr.autoCompleteSetBy, completionOptions: pr.completionOptions };
  },

  async 'cancel-auto-merge'(c) {
    requirePr(c);
    const pr = await ado('PATCH', `${prApi(c)}?api-version=${API}`, { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } });
    return { id: c.prId, autoMerge: !!pr.autoCompleteSetBy };
  },

  async merge(c, _pos, opts) {
    requirePr(c);
    const current = await ado('GET', `${prApi(c)}?api-version=${API}`);
    const pr = await ado('PATCH', `${prApi(c)}?api-version=${API}`, {
      status: 'completed',
      lastMergeSourceCommit: current.lastMergeSourceCommit,
      completionOptions: completionOptions(opts),
    });
    return { id: c.prId, status: pr.status, mergeCommit: pr.lastMergeCommit?.commitId ?? null };
  },

  async watch(c, _pos, opts) {
    requirePr(c);
    const self = await me(c);
    return watchLoop(c.prId, opts.interval, async () => {
      const pr = await ado('GET', `${prApi(c)}?api-version=${API}`);
      const [checks, threads] = await Promise.all([readChecks(c, pr.repository.project.id), readThreads(c, self)]);
      const summary = summarizePr(c, pr, self);
      return { status: summary.status, state: watchState(summary, checks), comments: peopleComments(threads) };
    });
  },
};
