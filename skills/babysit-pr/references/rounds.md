# Review rounds

`<babysit>` = `node <base>/scripts/babysit.mjs`, `<checks>` = `node <base>/../setup-repo/scripts/checks.mjs`.
babysit.mjs does the bookkeeping: it reads the PR back, builds the round's inputs, and posts every comment
in [style.md](style.md)'s templates with its key and status. You do what needs judgment: run the round,
brief the fixer, check its work, ask the user, push. Never post a comment babysit.mjs posts by hand.

Every command takes `--pr <id> --repo <worktree>`; the round commands also `--round <n> --scratch <scratch>`.
Its files live in the scratch directory: `round-<n>-args.json`, `round-<n>-result.json`,
`round-<n>-threads.json`, `round-<n>-fixer*.json`, `round-<n>-choices.json`.

## Contents

1. Starting a round
2. Recording findings
3. Fixing, pushing, resolving
4. Asking the user
5. Closing a round
6. Thread statuses

## 1. Starting a round

1. `<babysit> state` says what comes next (`next.action`): `round`, `ask-another`, `round-limit`,
   `fix-build`, `fix`, `await-decisions`, `close`, `report` or `merge-gate`, and why. Follow it; it applies
   SKILL.md's stop rule.
2. `<babysit> args --target origin/<target> [--tier <tier> --tier-reason "<why>"]` writes
   `round-<n>-args.json` and prints the round, its scope and why. Pass `--tier` only when the refreshed
   signals lifted the score into a higher tier (it refuses to go down). A PR triaged before version 4.1
   has no intent on its triage thread: pass `--intent-file <scratch>/intent.txt`. It picks the scope:
   - `full`, the tier's lenses over the whole PR: round 1, after the tier went up, and after commits this
     review did not write (no `Refs: pr-babysit` trailer, not the nits commit, not a merge) landed;
   - `delta`, the tier's `followUpLenses` over the commits since the last reviewed head: every other
     round, and every later round in review-only mode.
3. Start `Workflow` with the file's object as `args` (not stringified). Try `scriptPath:
   <base>/workflows/review-round.js` first. If the tool refuses the path as unreadable (a plugin install
   directory often is), pass the file's contents once as `script`, and for every later round use the
   `scriptPath` that launch returned, so the script enters this conversation only once.
4. If the Workflow tool is unavailable, tell the user, read the workflow file and run the same reviewers
   and skeptics as parallel Agent calls with its prompts, keeping its rules: only the adversary builds or
   runs tests, and minor findings share one skeptic.

**Reading the result.** Save the returned object verbatim to `round-<n>-result.json`; don't open the
agents' transcripts. When it says `valid: false`, post nothing from it: record the metrics with
`node <base>/../measure-prs/scripts/measure.mjs round` (flags in its header), tell the user its `reason` and
`failed` list in one message (Round failed), send the notification, and stop. A usage limit is the usual
cause. To retry, start the same round again with `resumeFromRunId: <its run id>`, so the agents that
finished are not paid for twice (same session only; in a new session, rerun `args` and the round).

## 2. Recording findings

`<babysit> record` posts one inline thread per finding (status `active`) and a reply on each person's
thread (Confirmed, Refuted or Answered). It writes `round-<n>-threads.json`, which maps each finding to its
thread. A confirmed comment is now a finding: it is fixed like the others, and its replies go on the
person's own thread. Nits and disproved findings get no thread; they go into the round summary. Rerunning
`record` posts nothing twice.

A red build from SKILL.md's Green build step comes before `args`: save the `check-failures` output (one
object or a list, each with `check` added) and run `<babysit> record --round <n> --build-failures <file>`,
with `<n>` the round about to start. It posts `R<n>-B<k>` threads, and `state` says `fix-build` until each is
resolved: the fixer handles them like findings, `reply` closes them, and then `args` builds the round on the
fixed head. Build threads show in the round's summary but never make a round unclean.

## 3. Fixing, pushing, resolving

1. Spawn one fixer with the Agent tool: `model` omitted (session model), `effort` = the tier's
   `fixerEffort`, description `fixer: round <n>` (`fixer: round <n> decisions` for the second pass; the
   metrics group agents by it). Prompt: "Read <base>/references/fixer.md and follow it", then the inputs
   it lists. Save its JSON block to `round-<n>-fixer.json` (`round-<n>-fixer-decisions.json` for the second
   pass).
2. Push without rewriting anything: `git -C <wt> push origin HEAD:refs/heads/<source>`. If it is rejected
   because the branch moved, `git -C <wt> fetch origin <source>`, `git -C <wt> merge origin/<source>`, and
   push again.
3. Run the checks yourself on the pushed head; never take the fixer's word for them:
   `<checks> run --base <mergeBase> --target origin/<target> --repo <wt> > <scratch>/round-<n>-checks.json`.
   A failure goes back to the fixer. Exit code 3 means the profile has no checks block: run its Checks
   section's fast check by hand and write `{"status":"none"}` to the file.
4. `<babysit> reply --fixer <scratch>/round-<n>-fixer.json --checks <scratch>/round-<n>-checks.json` posts
   the Fixed, Declined and Needs replies and sets each status. It refuses while the checks failed or ran on
   another head. It lists in `unproven` every `fixed` whose commit does not exist or has no proof, and posts
   nothing for those: send them back to the fixer once, then run `reply` again with `--escalate-unproven`,
   which turns them into questions for the user.

## 4. Asking the user

`reply` has already posted a Needs reply on every escalated thread and set it `pending`; it prints their
ids in `decisions`. Put them into one chat message (Decisions template): numbered, each with its options,
what each costs, and your recommendation, answerable in one line like `1A 2B`. Send a push notification,
then end the turn. Fixes that don't depend on the answers are already pushed by then.

When the user answers, write their choice per finding to `round-<n>-choices.json`
(`{ "R2-F3": "keep the route one more release (option A)" }`), run a second fixer pass for the decided
findings only, push, run the checks again, and `<babysit> reply --fixer <…-fixer-decisions.json> --checks
<…> --choices <scratch>/round-<n>-choices.json`, which posts the Decided replies.

## 5. Closing a round

`<babysit> summary` records the round's metrics (tokens from this session's transcripts, findings,
outcomes; measure-prs reads them), then posts the round summary with every outcome, what the skeptics
disproved, the nits, the reviewed commit, and the hidden state and metrics markers. Its `next` says what
comes after; `--print` shows the summary without posting or recording anything. A metrics failure never
blocks the summary; mention it in one line.

When the PR ends, record it once: `node <base>/../measure-prs/scripts/measure.mjs pr --repo <wt> --pr <id>
--pr-url <webUrl> --tier <tier> --score <score> --outcome merged|accepted|stopped|abandoned --started <the
triage's published time from state> --scratch <scratch>`. Post its marker as a reply on the report thread
(or, without one, on the triage thread): `🤖 Review metrics recorded.` and the marker,
`--key pr-babysit:metrics`, status `closed`.

## 6. Thread statuses

babysit.mjs sets these; the table is for reading a PR.

| Outcome | Status |
|---|---|
| finding posted, or a person's claim confirmed and not fixed yet | `active` |
| waiting for the user's decision | `pending` |
| fixed, or decided and done | `fixed` |
| declined as a false positive, a person's claim refuted, a question answered, decided without a change | `closed` |
| declined as by design | `byDesign` |
| declined as real but out of scope (say where it is tracked) | `wontFix` |
| triage, round summaries, report | `closed` |
