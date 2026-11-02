---
name: build-feature
description: Build an approved spec (docs/specs/<date>-<slug>.md from spec-feature) acceptance criterion by acceptance criterion - one builder agent writes each AC's failing test, makes it pass and commits it - check every AC is covered and the checks pass, put spec problems found while building to the user as amendments, then open a draft PR and hand it to babysit-pr. Use when the user says "build the spec", "implement docs/specs/…", after spec-feature's approval, or to resume a half-built spec. Not for code without an approved spec.
---

# Build a feature from its spec

```
build-feature <spec path>
 1 Set up     approved spec, worktree on feature/<slug>, profile, target
 2 Build      one builder agent, AC by AC: failing test → pass → checks → one commit per AC
 3 Verify     acmap: every AC has its commit and test; checks.mjs on the head yourself
 4 Amend      spec problems go to the user in one message; approved amendments go into the spec
 5 Open       push, draft PR with the spec linked, the PR linked in the spec
 6 Review     babysit-pr takes it from here to the merge question
```

`<pr-host>` = `node <base>/../pr-host/scripts/pr-host.mjs`, `<checks>` = `node <base>/../setup-repo/scripts/checks.mjs`,
`<acmap>` = `node <base>/scripts/acmap.mjs`, `<measure>` = `node <base>/../measure-prs/scripts/measure.mjs`.
The spec's shape is [spec-feature's spec-format.md](../spec-feature/references/spec-format.md).

## 1. Set up

1. **Spec.** The path from the argument, or the one `docs/specs/*.md` added on the current branch. Its
   `status` must be `approved` (with `pr:` filled in when resuming after the PR exists); a `draft` goes back
   to spec-feature. Note the time: the build phase's metrics start here.
2. **Worktree.** The one spec-feature made (`<repo>/../<repo name>-<slug>` on `feature/<slug>`), or create
   it the same way from the spec's `branch`. It must be clean.
3. **Profile and target.** `node <base>/../score-pr/scripts/signals.mjs --which-profile --base origin/<default branch> --repo <worktree>`;
   its Checks and Conventions sections go to the builder. Target = the default branch, unless the spec says otherwise.
4. **Resume.** `<acmap> --spec <spec> --base origin/<target> --repo <worktree>`: ACs with a commit are built;
   build the rest.
5. **Scratch.** A directory `build-<slug>` in the session scratchpad.

## 2. Build

Spawn one builder with the Agent tool: `model` omitted (session model), `effort` = the forecast tier's
`fixerEffort` from `<base>/../babysit-pr/references/tiers.json`, description `builder: <slug>`. Prompt:
"Read <base>/references/builder.md and follow it", then the inputs it lists. Save its JSON block to
`<scratch>/build-<n>.json` (n counts passes). It runs in the foreground of this step; wait for it.

## 3. Verify

Never take the builder's word for it:

1. `<acmap> --spec <spec> --base origin/<target> --repo <worktree>`: every AC verified by `test` has a test
   carrying its id, and every AC has a commit with its `Refs: spec <slug> AC<n>` trailer. Anything listed
   in `missingTests` or `missingCommits` that the builder did not report as blocked goes back to it once;
   after that, it is an amendment question (step 4).
2. `<checks> run --base origin/<target> --target origin/<target> --repo <worktree>`: a failure goes back to
   the builder. Exit code 3: run the profile's prose fast check yourself.
3. Read each commit's diff briefly against its AC: a test that asserts nothing, or a change that does more
   than the AC asks, goes back to the builder.

## 4. Amend

Put every blocked AC's amendment, and anything step 3 could not settle, into one chat message with
AskUserQuestion: each problem in a sentence, its options with costs, your recommendation. Send a push
notification (`<slug>: N spec questions need you`) and keep building what doesn't depend on the answers.

An approved amendment changes the spec: edit the ACs and decisions to match, add a dated line under
Amendments with the user's name, commit `docs(spec): amend <what>` (trailer `Refs: spec <slug>`), and run
step 2 again for the affected ACs. A rejected one leaves the spec as it is; the builder tries the option the
user chose.

## 5. Open

When every AC is done, verified and the checks pass:

1. `git -C <worktree> push -u origin feature/<slug>`.
2. Write the PR description to `<scratch>/pr-body.md`: the spec's Why, the ACs each with its test (from
   acmap), what a person verifies by hand, plan changes, and a link to the spec file on the branch.
   babysit-pr rewrites it as a review report later.
3. `<pr-host> open --source feature/<slug> --target <target> --title "<spec title>" --body-file <scratch>/pr-body.md --draft`.
   It returns the PR (or the one already open for the branch).
4. Fill in the spec's `pr: <webUrl>`, commit `docs(spec): link the PR` (trailer `Refs: spec <slug>`), and
   push, before the review starts, so no later push resets anything.
5. Record the phase: `<measure> phase --name build --repo <worktree> --branch feature/<slug> --pr <id> --started <step 1's time> --scratch <scratch>`.
   A failing metrics script never blocks; say so in one line.

## 6. Review

Run the **babysit-pr** skill on the PR with the worktree, and write the spec's Why plus its AC list as the
intent babysit-pr's triage asks for. The reviewers judge the change against the spec (babysit-pr finds it in
the diff), and the chain carries on to the merge question.
