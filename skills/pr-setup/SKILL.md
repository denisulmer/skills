---
name: pr-setup
description: Set up a repository for the PR skills (pr-host, pr-risk, pr-babysit, pr-merge) - detect its platform (GitHub, GitLab, Azure DevOps or plain git), check the tools and the sign-in, then draft, calibrate against recent merges and save the repository profile that tells pr-risk where the dangerous code is, which checks a fix must pass and how the repository merges. Use when the user says "set up the PR skills", "set up pr-babysit for this repo", "create / update the repo profile", "teach the risk scorer about this repo", when pr-risk or pr-babysit report that no profile matched, or before the first pr-babysit run in a new repository.
---

# Set up a repository for the PR skills

`<pr-host>` = `node <base>/../pr-host/scripts/pr-host.mjs`, `<signals>` = `node <base>/../pr-risk/scripts/signals.mjs`.
Run everything from the repository (any worktree of it works the same).

## 1. Platform and sign-in

1. `<pr-host> context`. It names the platform and the signed-in user.
2. Self-hosted GitHub or GitLab under a host name pr-host does not recognise comes out as `local`: set
   `git config prhost.platform github` (or `gitlab`) in the repo and run `context` again. The setting is
   shared by every worktree of the repo.
3. A sign-in error: tell the user the one command that fixes it and wait. Sign-in is theirs to do; never
   type a token or password yourself.

   | Platform | Sign in |
   |---|---|
   | github | `gh auth login` (or `GH_TOKEN`) |
   | gitlab | `glab auth login --hostname <host>` (or `GITLAB_TOKEN` with scope `api`; for a self-managed host also `GITLAB_HOST=<host>`, since the token is only sent there) |
   | azure-devops | `az login` (or `AZURE_DEVOPS_EXT_PAT`) |
   | local | nothing: reviews live in the repo's git directory, merges are local merges plus a push |

4. Tools: `node --version` 18 or newer, `git --version` 2.38 or newer. pr-babysit uses Claude Code's
   Workflow tool when it is there and parallel agents when it is not; pr-merge uses Monitor.

## 2. Existing profile

`<signals> --which-profile --base origin/<default branch>` (the branch itself when there is no remote).
When one applies, show its name, `source` (user or repo) and danger-map rule ids, and ask: keep it,
update it, or replace it. Keeping it ends the setup.

## 3. Draft

Read [references/profile-format.md](references/profile-format.md) first. Then read the repository, not
just its file names: agent guides (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`), the README, ADRs, `CODEOWNERS`,
the CI configuration and the scripts it calls.

- **Danger map.** Find where these live and write one rule each, with a reason a reviewer understands
  without opening the profile: authentication and authorization; schema and data migrations; public
  contracts (HTTP APIs, generated clients, events, CLI flags, file formats, anything another team or a
  customer calls); shared libraries everything builds on; deployment manifests and infrastructure; CI and
  release tooling; and the opposite, code that is not live (prototypes, docs sites, local tooling), as
  caps or negative adjustments. Reuse a default's id only to replace it.
- **Judgment notes.** This repository's one-way doors, its costly two-way doors, and blast-radius words
  in its own domain language.
- **Checks.** The real commands for a fast check, per area, everything, and a live smoke test if one
  exists, from package scripts, Makefiles, `scripts/` and the CI steps. Run the fast check once; a check
  that does not run is worse than none.
- **Conventions a fix must keep.** Changelog or release-note fragments, generated code to regenerate,
  translations, anything CI enforces that a quick fix would miss.
- **Merge.** The strategy the history shows (`git log --first-parent`): merge commits → `merge`; one
  commit per PR with a `(#123)`-style subject → `squash`; a linear history → `rebase`. Ask when it is
  mixed. Whether the source branch is deleted after the merge.

Write the draft to `<scratch>/pr-profile.md`.

## 4. Calibrate

`node <base>/scripts/calibrate.mjs --profile <scratch>/pr-profile.md --branch origin/<default branch> --count 20`
prints the last 20 merged changes with the floor, cap and adjustment the draft gives each, and the rules
behind them. Show the table and ask the user which rows look wrong: a change they consider routine with a
high floor, a risky one capped low, a rule that never fires. Fix the rules and run it again until they
agree. Bounds are not scores: when the user wants to see a full score, run the pr-risk skill on one or
two of the changes, not all twenty.

## 5. Save

Ask where it goes:

- **For the team:** `.claude/pr-profile.md`, committed, without `remotes` or `paths`. pr-risk reads it from
  the PR's target branch, so it applies once merged; propose committing it on a branch with a PR, or
  commit it directly when the user says so.
- **Just for the user:** `~/.claude/pr-profiles/<name>.md`, with `remotes` (each remote URL's host and
  path, without user name or `.git`) or, for a repo without a remote, `paths` (the main checkout: the
  parent of `git rev-parse --path-format=absolute --git-common-dir`). It overrides a team profile.

Then confirm it is found: `<signals> --which-profile --base <ref>` names it (for an unmerged team profile,
pass the branch it is committed on as `<ref>`).

## 6. Report

Two lines: platform and who is signed in; the profile's name, where it lives and what it guards. Then
say pr-risk, pr-babysit and pr-merge are ready for this repository.
