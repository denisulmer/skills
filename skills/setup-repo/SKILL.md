---
name: setup-repo
description: Write or calibrate the repository profile the PR skills use - what is dangerous where, which checks a fix must pass, how the repository merges. Use when the user says "set up the PR skills", "create / update / calibrate the repo profile" or "teach the risk scorer about this repo".
---

# Set up a repository for the PR skills

`<pr-host>` = `node <base>/../pr-host/scripts/pr-host.mjs`, `<signals>` = `node <base>/../score-pr/scripts/signals.mjs`,
`<draft>` = `node <base>/scripts/draft.mjs`, `<checks>` = `node <base>/scripts/checks.mjs`.
Run everything from the repository (any worktree of it works the same).

There are two ways in. **Quick setup** is what another skill runs when it meets a repository without a
profile: no questions, best-effort defaults, and one message that says what was assumed and how to improve
it. **Full setup** is what the user asks for: the same draft, completed with them and calibrated.

## Quick setup (no questions)

1. `<pr-host> context` names the platform and the signed-in user. A sign-in error is the one thing that
   stops here: tell the user the one command that fixes it (pr-host's sign-in table) and wait.
2. `<draft> --repo <repo> --out <scratch>/pr-profile.md` writes a first profile from what the repository's
   files show: the checks its build files name and the merge strategy its history shows. Its `assumed`
   list says what it took from where.
3. Make the draft true from the agent guides (`AGENTS.md`, `CLAUDE.md`) and the CI configuration: each
   check's command matches how CI runs it, and anything obviously special that the defaults miss (a public
   API, deployment manifests under an unusual name) gets a danger-map rule. Done when every check matches
   a CI step or a documented command; what you are unsure of stays out.
4. Run every fast check once: `<checks> run --base origin/<default branch> --all --profile <scratch>/pr-profile.md`.
   Drop each one that fails on a clean branch: a check that does not run is worse than none.
5. Save it as the user's profile: copy it to `~/.claude/pr-profiles/<name>.md` (`<draft> --save` does this
   for an unedited draft). It keeps `calibrated: false`, which every skill reports until the full setup
   has run.
6. Tell the user, in two lines, and go on with what you were doing:
   `No profile for this repository yet, so I drafted one: <file>. It assumes <checks>, <merge strategy>, and nothing dangerous beyond the defaults.`
   `To improve it: /setup-repo calibrates it against your last 20 merges and adds what is risky here.`

## Full setup

### 1. Platform and sign-in

1. `<pr-host> context`. It names the platform and the signed-in user.
2. Self-hosted GitHub or GitLab under a host name pr-host does not recognise comes out as `local`: set
   `git config prhost.platform github` (or `gitlab`) in the repo and run `context` again. The setting is
   shared by every worktree of the repo.
3. A sign-in error: tell the user the one command that fixes it, from the sign-in table in
   `<base>/../pr-host/SKILL.md`, and wait. Sign-in is theirs to do; never type a token or password
   yourself.

4. Tools: `node --version` 18 or newer, `git --version` 2.38 or newer. babysit-pr uses Claude Code's
   Workflow tool when it is there and parallel agents when it is not; merge-pr uses Monitor.
5. Tickets: `node <base>/../sync-ticket/scripts/ticket.mjs transport` says how a Jira description is
   written from this machine, and what would improve it. Say both in one line.

### 2. Existing profile

`<signals> --which-profile --base origin/<default branch>` (the branch itself when there is no remote).
When one applies, show its name, `source` (user or repo), whether it is calibrated, and its danger-map rule
ids. A draft (`calibrated: false`) is the starting point for step 3. For a calibrated one ask: keep it,
update it, or replace it; keeping it ends the setup. A profile without a ```` ```json checks ```` block
still works, but the checks are then prose the agents interpret: offer to add the block (step 3's Checks
bullet) as the one update worth making.

### 3. Draft

Read [references/profile-format.md](references/profile-format.md) first. Start from `<draft> --repo <repo>
--out <scratch>/pr-profile.md` when there is no profile yet. Then read the repository, not just its file
names: agent guides (`AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`), the README, ADRs, `CODEOWNERS`, the CI
configuration and the scripts it calls.

- **Danger map.** Find where these live and write one rule each, with a reason a reviewer understands
  without opening the profile: authentication and authorization; schema and data migrations; public
  contracts (HTTP APIs, generated clients, events, CLI flags, file formats, anything another team or a
  customer calls); shared libraries everything builds on; deployment manifests and infrastructure; CI and
  release tooling; and the opposite, code that is not live (prototypes, docs sites, local tooling), as
  caps or negative adjustments. Reuse a default's id only to replace it.
- **Judgment notes.** This repository's one-way doors, its costly two-way doors, and blast-radius words
  in its own domain language.
- **Checks.** A ```` ```json checks ```` block ([the fields](references/profile-format.md#check-fields)):
  `fast` checks per area, each with the globs that make it apply, so a change runs only what it touches;
  one `full` check that matches what the PR pipeline runs; a `smoke` check if a live one exists. Take the
  commands from package scripts, Makefiles, `scripts/` and the CI steps. Then run every fast check once:
  `<checks> run --base origin/<default branch> --all --profile <scratch>/pr-profile.md`.
  Fix or drop any that fails on a clean branch; a check that does not run is worse than none.
- **Conventions a fix must keep.** Changelog or release-note fragments, generated code to regenerate,
  translations, anything CI enforces that a quick fix would miss.
- **Merge.** The strategy the history shows (`git log --first-parent`): merge commits → `merge`; one
  commit per PR with a `(#123)`-style subject → `squash`; a linear history → `rebase`. Ask when it is
  mixed. Whether the source branch is deleted after the merge.
- **Tickets.** Where this repository's work is tracked and what the skills may do there, when it differs
  from sync-ticket's defaults (one sub-task per acceptance criterion; sub-tasks are closed, the ticket
  itself is never moved).

Write the draft to `<scratch>/pr-profile.md`.

### 4. Calibrate

`node <base>/scripts/calibrate.mjs --profile <scratch>/pr-profile.md --branch origin/<default branch> --count 20`
prints the last 20 merged changes with the floor, cap and adjustment the draft gives each, and the rules
behind them. Show the table and ask the user which rows look wrong: a change they consider routine with a
high floor, a risky one capped low, a rule that never fires. Fix the rules and run it again until they
agree. Bounds are not scores: when the user wants to see a full score, run the score-pr skill on one or
two of the changes, not all twenty. Once they agree, take `calibrated: false` out of the front matter.

### 5. Save

Ask where it goes:

- **For the team:** `.claude/pr-profile.md`, committed, without `remotes` or `paths`. score-pr reads it from
  the PR's target branch, so it applies once merged; propose committing it on a branch with a PR, or
  commit it directly when the user says so.
- **Just for the user:** `~/.claude/pr-profiles/<name>.md`, with `remotes` (each remote URL's host and
  path, without user name or `.git`) or, for a repo without a remote, `paths` (the main checkout: the
  parent of `git rev-parse --path-format=absolute --git-common-dir`). It overrides a team profile.

Then confirm it is found: `<signals> --which-profile --base <ref>` names it (for an unmerged team profile,
pass the branch it is committed on as `<ref>`).

### 6. Report

Two lines: platform and who is signed in; the profile's name, where it lives and what it guards. Then
say score-pr, babysit-pr and merge-pr are ready for this repository.
