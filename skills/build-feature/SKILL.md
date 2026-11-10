---
name: build-feature
description: Build an approved spec (a ticket's Specification section or docs/specs/) one acceptance criterion at a time - failing test, pass, one commit each - then open a draft PR for babysit-pr. Use when the user says "build the spec" or "implement <ticket>", after spec-feature's approval, or to resume a half-built spec. Not for code without an approved spec.
---

# Build a feature from its spec

```
build-feature <ticket> | <spec path>
 1 Set up     the approved spec, worktree on the feature branch, profile, target
 2 Build      one builder agent, AC by AC: failing test → pass → checks → one commit per AC
 3 Verify     acmap: every AC has its commit and test; checks.mjs on the head yourself
 4 Amend      spec problems go to the user in one message; approved amendments go into the spec
 5 Open       push, draft PR; the ticket's sub-tasks closed and its status line naming the PR
 6 Review     babysit-pr takes it from here to the merge question
```

`<pr-host>` = `node <base>/../pr-host/scripts/pr-host.mjs`, `<checks>` = `node <base>/../setup-repo/scripts/checks.mjs`,
`<acmap>` = `node <base>/scripts/acmap.mjs`, `<measure>` = `node <base>/../measure-prs/scripts/measure.mjs`.
The spec's shape is [spec-feature's spec-format.md](../spec-feature/references/spec-format.md). With a
ticket, the sync-ticket skill (`<base>/../sync-ticket/SKILL.md`) reads and writes it.

## 1. Set up

1. **Spec.** From a ticket: read it as sync-ticket's Reading a ticket says; the spec is then
   `<scratch>/spec.md`. From a path: that file, or the one `docs/specs/*.md` added on the current branch.
   Its `status` must be `approved`; a `draft` goes back to spec-feature. Note the time: the build phase's
   metrics start here.
2. **Worktree.** The one spec-feature made (`<repo>/../<repo name>-<slug>` on the spec's `branch`), or
   create it the same way. It must be clean.
3. **Profile and target.** `node <base>/../score-pr/scripts/signals.mjs --which-profile --base origin/<default branch> --repo <worktree>`;
   its Checks and Conventions sections go to the builder. None: run setup-repo's quick setup first. Target
   = the default branch, unless the spec says otherwise.
4. **Resume.** `<acmap> --spec <spec> --base origin/<target> --repo <worktree>`: ACs with a commit are built;
   build the rest.
5. **Scratch.** A directory `build-<slug>` in the session scratchpad.

Tell the user in one line what you build from and with what:

`Building SHOP-228 (6 acceptance criteria, 2 already built) · medium tier: the builder runs on Opus at medium effort · checks: backend, web-lint.`

## 2. Build

Spawn one builder with the Agent tool: `model` and `effort` = the forecast tier's `model` and `effort`
from `<base>/../babysit-pr/references/tiers.json` (the spec's `risk:`), description `builder: <slug>`. Prompt:
"Read <base>/references/builder.md and follow it", then the inputs it lists, with the commit trailer
written out: `Refs: <KEY> AC<n>` for a ticket, `Refs: spec <slug> AC<n>` for a spec file. Save its JSON
block to `<scratch>/build-<n>.json` (n counts passes). It runs in the foreground of this step; wait for it.

## 3. Verify

Never take the builder's word for it:

1. `<acmap> --spec <spec> --base origin/<target> --repo <worktree>`: every AC verified by `test` has a test
   carrying its id, and every AC has a commit with its trailer. Anything listed in `missingTests` or
   `missingCommits` that the builder did not report as blocked goes back to it once; after that, it is an
   amendment question (step 4).
2. `<checks> run --base origin/<target> --target origin/<target> --repo <worktree>`: a failure goes back to
   the builder. Exit code 3: run the profile's prose fast check yourself.
3. Read each commit's diff against its AC. Done when every test asserts the AC's observable outcome and
   every change stays inside its AC; a commit that fails either goes back to the builder.

With a ticket, close the sub-task of every AC that passed all three, with its one-line comment
(sync-ticket's Sub-tasks, step 3).

## 4. Amend

Put every blocked AC's amendment, and anything step 3 could not settle, into one chat message with
AskUserQuestion: each problem in a sentence, its options with costs, your recommendation. Send a push
notification (`<slug>: N spec questions need you`) and keep building what doesn't depend on the answers.

An approved amendment changes the spec: edit the ACs and decisions to match and add a dated line under
Amendments with the user's name. With a ticket, write the section again and bring the sub-tasks in line
(sync-ticket); with a spec file, commit `docs(spec): amend <what>` (trailer `Refs: spec <slug>`). Then run
step 2 again for the affected ACs. A rejected amendment leaves the spec as it is; the builder tries the
option the user chose.

## 5. Open

When every AC is done, verified and the checks pass:

1. `git -C <worktree> push -u origin <branch>`.
2. `<pr-host> context` gives `limits.description`, the most characters the host keeps. Write the PR
   description within it to `<scratch>/pr-body.md`: the spec's Why, the ACs each with its test (from
   acmap), what a person verifies by hand, plan changes, and a link to the ticket or the spec file.
   babysit-pr rewrites it as the review's cover page later.
3. `<pr-host> open --source <branch> --target <target> --title "<KEY>: <spec title>" --body-file <scratch>/pr-body.md --draft`
   (the title without the key when there is no ticket). It returns the PR, or the one already open for
   the branch.
4. Fill in the spec's `pr: <webUrl>`. With a ticket, write the section again so its status line names the
   PR; with a spec file, commit `docs(spec): link the PR` (trailer `Refs: spec <slug>`) and push, before
   the review starts, so no later push resets anything.
5. Record the phase: `<measure> phase --name build --repo <worktree> --branch <branch> --pr <id> --started <step 1's time> --scratch <scratch>`.
   Best-effort: a failure is one line to the user.

## 6. Review

Run the **babysit-pr** skill on the PR with the worktree, and pass it the ticket (or the spec's path): the
reviewers judge the change against the spec, and the chain carries on to the merge question.
