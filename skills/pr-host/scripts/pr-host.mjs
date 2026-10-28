#!/usr/bin/env node
// Pull-request operations shaped for agents, with one interface over GitHub, GitLab, Azure DevOps and
// plain git (`local`: no PR host; the review lives in the repository's git directory).
//
// The platform comes from --platform, PR_HOST_PLATFORM, `git config prhost.platform`, a PR URL, or the
// host name of the `origin` remote; anything unrecognised is `local`. Adapters live in hosts/ and share
// lib.mjs. Every command prints JSON on stdout, except `watch`, which prints one plain line per event for
// Monitor. Failures print to stderr and exit 1.

import { UsageError, parseArgs, tryGit } from './lib.mjs';
import * as azureDevops from './hosts/azure-devops.mjs';
import * as github from './hosts/github.mjs';
import * as gitlab from './hosts/gitlab.mjs';
import * as local from './hosts/local.mjs';

const HOSTS = { github, gitlab, 'azure-devops': azureDevops, local };

const USAGE = `pr-host <command> [args]

  context [pr]                         platform, repository, signed-in user, PR web URL
  find --branch <name>                 open PRs whose source branch is <name>
  show <pr>                            PR summary: author, isMine, branches, commits, mergeStatus, autoMerge, limits
  threads <pr> [--all]                 comment threads; kind = bot (has a key), human, or system (--all)
  thread-create <pr> --body-file F [--key K] [--file P --line N [--end-line M]] [--status S]
  reply <pr> <threadId> --body-file F [--key K] [--status S]
  set-status <pr> <threadId> <status>  status: active | pending | fixed | wontFix | byDesign | closed
  set-description <pr> --body-file F   fails above the host's limit (show -> limits.description)
  publish <pr>                         draft -> ready for review
  checks <pr>                          CI and policy checks: status queued | running | passed | failed | skipped
  rerun-check <pr> <checkId>           re-run one failed check (e.g. a flaky build)
  check-failures <runId> [--tail N]    failed steps of a check run with the last N log lines (default 80)
  auto-merge <pr> [--strategy S] [--keep-source-branch] [--message M]
                                       merge once checks pass; strategy: merge | squash | rebase | rebase-merge
  cancel-auto-merge <pr>
  merge <pr> [--strategy S] [--keep-source-branch] [--message M]
                                       merge now
  watch <pr> [--interval SECONDS]      poll and print one line per change; exits when the PR is no longer active
  open --source <branch> [--target <branch>] [--title T] [--body-file F] [--draft]
                                       local only: start a review of a branch (other hosts: open the PR there)

  <pr> is a pull-request id or URL. --body-file - reads stdin; --body "text" passes text inline.
  --key makes a create or reply idempotent: a thread or comment that already carries the key is returned, not posted again.
  --platform github|gitlab|azure-devops|local overrides detection; --remote <name> reads another remote than origin.
  PR_HOST_DRY_RUN=<dir> logs every write to <dir>/requests.jsonl instead of sending it; reads stay live.`;

const NO_PR_ARG = new Set(['find', 'check-failures', 'open']);

function resolve(command, prArg, opts) {
  const forcedName = opts.platform ?? process.env.PR_HOST_PLATFORM ?? tryGit(['config', '--get', 'prhost.platform']) ?? null;
  if (forcedName && !HOSTS[forcedName]) throw new UsageError(`unknown platform "${forcedName}"; use ${Object.keys(HOSTS).join(', ')}`);
  const forced = forcedName ? HOSTS[forcedName] : null;

  // origin, or the only remote when the repository has exactly one under another name.
  const remotes = (tryGit(['remote']) ?? '').split('\n').filter(Boolean);
  const remote = typeof opts.remote === 'string' ? opts.remote : remotes.length === 1 ? remotes[0] : 'origin';
  if (prArg && /^https?:\/\//.test(prArg)) {
    for (const host of forced ? [forced] : [github, gitlab, azureDevops]) {
      const c = host.fromPrUrl(prArg, { forced: !!forced, opts });
      if (c) return { host, c: { ...c, remote } };
    }
    throw new UsageError(`not a pull-request URL of a known host: ${prArg} (pass --platform when the host name does not tell)`);
  }
  if (prArg !== undefined && !/^\d+$/.test(prArg)) throw new UsageError(`not a pull-request id or URL: ${prArg}`);

  const remoteUrl = tryGit(['remote', 'get-url', remote]) ?? '';
  let host = forced;
  let c = forced?.fromRemote(remoteUrl, { forced: true, opts, remote });
  if (!host) {
    for (const candidate of [github, gitlab, azureDevops, local]) {
      c = candidate.fromRemote(remoteUrl, { forced: false, opts, remote });
      if (c) {
        host = candidate;
        break;
      }
    }
  }
  return { host, c: { ...c, remote, prId: prArg === undefined ? undefined : Number(prArg) } };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }
  const { pos, opts } = parseArgs(rest);
  const { host, c } = resolve(command, NO_PR_ARG.has(command) ? undefined : pos[0], opts);
  const handler = host.commands[command];
  if (!handler) {
    if (Object.values(HOSTS).some((h) => h.commands[command])) throw new UsageError(`"${command}" is not available on ${host.platform}`);
    throw new UsageError(`unknown command "${command}"`);
  }
  const result = await handler(c, pos, opts);
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error.message);
  process.exit(1);
});
