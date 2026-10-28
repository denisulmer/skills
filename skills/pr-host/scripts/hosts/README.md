# Host adapters

One file per platform. `pr-host.mjs` picks the adapter and passes it a context; `lib.mjs` holds what they
share. `azure-devops.mjs` is the reference: copy its shapes.

## Exports

```js
export const platform = 'github';                    // the --platform name
export function fromRemote(url, { forced, opts, remote }) // remote URL -> context, or null when not this host
                                                     // (forced: the user said it is this host; accept any URL)
export function fromPrUrl(url, { forced, opts })     // PR web URL -> { ...context, prId }, or null
export const commands = { context, find, show, ... } // (c, pos, opts) => JSON-able result
```

`c` is the context plus `prId` (a number or undefined) and `remote`. `pos[0]` is the PR argument,
`pos[1..]` the rest. A command a host cannot do is left out of `commands`; pr-host then says so.

## Shapes every adapter returns

- **show:** `platform, id, title, description, status (active | completed | abandoned), isDraft, author
  {id,name}, isMine, sourceBranch, targetBranch, sourceCommit, targetCommit, mergeCommit, mergeStatus
  (ok | conflicts | checking | unknown), mergeStatusRaw, autoMerge (null | {by, strategy, deleteSourceBranch}),
  reviewers [{name, vote, isRequired}], limits {description: number | null}, webUrl, repoWebUrl, me`.
- **threads:** `[{ id, kind (bot | human | system), key, status, file, line, url, comments [{ id, author,
  isMine, type, key, content, published }], updated }]`. `kind: bot` when the first comment carries a key.
  `file` is repo-relative (Azure DevOps prefixes `/`).
- **thread-create:** `{ existing, id, status, url }`. **reply:** `{ existing, threadId, commentId, status }`.
- **checks:** `[{ id, name, kind (build | review | other), isBlocking, status (queued | running | passed |
  failed | skipped), raw, runId, url }]`. `id` is what `rerun-check` takes, `runId` what `check-failures` takes.
- **check-failures:** `{ runId, status, result, commit, url, failedSteps [{ name, issues, logTail }] }`.
- **watch:** `watchLoop` from lib.mjs with a snapshot built by `watchState` and `peopleComments`.

## Statuses on hosts that only resolve

GitHub and GitLab threads are resolved or not. Keep the exact status in the marker
(`withMarker(body, { key, status })`) of the comment that set it, resolve the thread natively for
`RESOLVED_STATUSES`, and read it back with `deriveStatus(comments, resolved)`, which takes the latest
marker. So `set-status` without a reply edits the marker of the latest comment of ours that carries a
status (else our first comment), and only resolves or reopens natively when the thread has no comment of
ours.

A host without threaded replies (GitHub's conversation comments) groups by marker: a reply carries
`reply-to=<threadId>` and joins that thread.

## Rehearsal

`request()` logs writes instead of sending them under `PR_HOST_DRY_RUN`. A POST that only reads
(GraphQL queries) passes `write: false`. Anything that writes without `request()` (git in `local`) checks
`isDryRun()` and logs with `logDryRun()`.
