# Review rounds

`<babysit>` = `node <base>/scripts/babysit.mjs`, `<checks>` = `node <base>/../setup-repo/scripts/checks.mjs`.
babysit.mjs does the bookkeeping: it reads the PR back, builds the round's inputs, and posts everything the
round leaves on the PR, with its key and status. You do what needs judgment: run the round, brief the
fixer, check its work, ask the user, push. Never post by hand what babysit.mjs posts.

Every command takes `--pr <id> --repo <worktree>`; the round commands also `--round <n> --scratch <scratch>`.
Its files live in the scratch directory: `round-<n>-args.json`, `round-<n>-result.json`,
`round-<n>-fixer*.json`, `round-<n>-checks.json`, `round-<n>-choices.json`.

## Contents

1. Starting a round
2. Recording findings
3. Fixing, pushing, replying
4. Asking the user
5. Closing a round
6. What is on the PR afterwards

## 1. Starting a round

1. `<babysit> state` says what comes next (`next.action`): `round`, `round-limit`,
   `fix-build`, `fix`, `await-decisions`, `close`, `report` or `merge-gate`, and why. Follow it; it applies
   SKILL.md's stop rule.
2. `<babysit> args --target origin/<target> [--tier <tier> --tier-reason "<why>"]` writes
   `round-<n>-args.json` and prints the round, its scope and why. Pass `--tier` only when the refreshed
   signals lifted the score into a higher tier (it refuses to go down). A PR triaged before version 4.1
   has no intent on its triage thread: pass `--intent-file <scratch>/intent.txt`. It picks the scope:
   - `full`, the tier's lenses over the whole PR: round 1, after the tier went up, and after commits this
     review did not write (no `Refs: pr-babysit` trailer, not the nits commit, not a merge) landed;
   - `delta`, a follow-up round: the tier's `followUpLenses` over only the commits since the last
     reviewed head. Every other round, and every later round in review-only mode.

   `ask: true` marks a second full round, which costs as much as the first: ask the user before you
   start it (Another round, style.md). Follow-up rounds never ask. Once the review is done, `args`
   refuses a new round unless someone else pushed or a person waits for an answer.
3. Start `Workflow` with the file's object as `args` (not stringified). Try `scriptPath:
   <base>/workflows/review-round.js` first. If the tool refuses the path as unreadable (a plugin install
   directory often is), pass the file's contents once as `script`, and for every later round use the
   `scriptPath` that launch returned, so the script enters this conversation only once.
4. If the Workflow tool is unavailable, tell the user, read the workflow file and run the same reviewers
   and skeptics as parallel Agent calls with its prompts, keeping its rules: only the adversary builds or
   runs tests, reports of one defect are merged into one finding before the skeptics see it, and
   findings share skeptics in batches.

**Reading the result.** Save the returned object verbatim to `round-<n>-result.json`; don't open the
agents' transcripts. When it says `valid: false`, post nothing from it and record the metrics with
`node <base>/../measure-prs/scripts/measure.mjs round` (flags in its header). Then find out why the agents
got no answer: the notification or your own last error says it; when neither does, search the run's
transcript directory for `limit` and read nothing else there.

- **A 5-hour usage limit** (it names a reset time within hours): tell the user in one line when the
  round resumes (Round failed, style.md), wait in the background until a few minutes after the reset (a
  background command that sleeps until then; chain two when the reset is more than two hours away), then
  start the same round again with `resumeFromRunId: <its run id>`, without asking. The agents that
  finished are not paid for twice. When the limit stopped you as well and the user's next message is what
  wakes you, retry at once if the reset has passed. One automatic retry per round: a second failure goes
  to the user.
- **A weekly limit, or any other cause:** tell the user its `reason` and `failed` list in one message
  (Round failed), send the notification, and stop. On their **retry**, resume the same way.

Resuming works in the same session only; in a new session, rerun `args` and the round.

## 2. Recording findings

`<babysit> record` puts the round's findings on the log (the triage thread) as one reply, and answers each
person's thread (Confirmed, Refuted or Answered). It creates no thread for a finding: in owner mode a
finding gets one only when it turns out to need a person (§3). A confirmed comment from a person is a
finding from here on; it is fixed like the others, and its replies go on that person's own thread. Nits
and disproved findings go into the round summary. Rerunning `record` posts nothing twice.

In review-only mode `record` also opens one thread per finding (status `active`), because the author has
to see each at its line.

A red build from SKILL.md's Green build step comes before `args`: save the `check-failures` output (one
object or a list, each with `check` added) and run `<babysit> record --round <n> --build-failures <file>`,
with `<n>` the round about to start. It posts `R<n>-B<k>` threads, and `state` says `fix-build` until each is
resolved: the fixer handles them like findings, `reply` closes them, and then `args` builds the round on the
fixed head. Build threads show in the round's summary but never make a round unclean.

## 3. Fixing, pushing, replying

1. Spawn one fixer with the Agent tool: `model` and `effort` = the tier's `model` and `effort` (not
   the session's: a fix with a failing test is well-scoped work, and the tier already sizes the model for
   it), description `fixer: round <n>` (`fixer: round <n> decisions` for the second pass; the
   metrics group agents by it). Prompt: "Read <base>/references/fixer.md and follow it", then the inputs
   it lists. Save its JSON block to `round-<n>-fixer.json` (`round-<n>-fixer-decisions.json` for the second
   pass).
2. Push without rewriting anything: `git -C <wt> push origin HEAD:refs/heads/<source>`. If it is rejected
   because the branch moved, `git -C <wt> fetch origin <source>`, `git -C <wt> merge origin/<source>`, and
   push again.
3. Run the checks yourself on the pushed head; never take the fixer's word for them:
   `<checks> run --base <mergeBase> --target origin/<target> --repo <wt> > <scratch>/round-<n>-checks.json`.
   A failure goes back to the fixer, one effort level higher (never above `high`): effort comes before a
   bigger model. Exit code 3 means the profile has no checks block: run its Checks section's fast check
   by hand and write `{"status":"none"}` to the file.
4. `<babysit> reply --fixer <scratch>/round-<n>-fixer.json --checks <scratch>/round-<n>-checks.json` records
   every outcome on the log and posts only what a person has to see:
   - **fixed with proof:** nothing of its own. It is a row in the round summary, and its commit says the
     rest. (A finding that came from a person's comment gets its Fixed reply on their thread.)
   - **declined:** one thread at the code line, resolved, with the verdict and the finding in one comment.
     It goes on the 👀 list.
   - **escalated:** one thread at the code line, status `pending`, with the ask, the finding and the
     options in one comment. It prints these in `decisions`, each with its thread's URL.

   It refuses while the checks failed or ran on another head. It lists in `unproven` every `fixed` whose
   commit does not exist or has no proof, and records nothing for those: send them back to the fixer once,
   then run `reply` again with `--escalate-unproven`, which turns them into questions for the user.

## 4. Asking the user

Put the round's `decisions` into one chat message (Decisions template): numbered, each with its options,
what each costs, and your recommendation, answerable in one line like `1A 2B`. Send a push notification,
then end the turn. Fixes that don't depend on the answers are already pushed by then.

When the user answers, write their choice per finding to `round-<n>-choices.json`, with the option's
letter so the metrics can tell whether the recommendation was taken:

```json
{ "R2-F3": { "option": "A", "text": "keep the route one more release" } }
```

Run a second fixer pass for the decided findings only, push, run the checks again, and `<babysit> reply
--fixer <…-fixer-decisions.json> --checks <…> --choices <scratch>/round-<n>-choices.json`, which posts the
Decided reply on each decision's thread and resolves it.

## 5. Closing a round

`<babysit> summary` records the round's metrics (tokens and their price from this session's transcripts,
findings, outcomes, whether recommendations were taken; measure-prs reads them), then adds the round
summary to the log: every finding with its outcome, what the skeptics disproved, the nits, the reviewed
commit, and the hidden state and metrics markers. Its `next` says what comes after; `--print` shows the
summary without posting or recording anything. A metrics failure never blocks the summary; mention it in
one line.

When the PR ends, record it once: `node <base>/../measure-prs/scripts/measure.mjs pr --repo <wt> --pr <id>
--pr-url <webUrl> --tier <tier> --score <score> --outcome merged|accepted|stopped|abandoned --started <the
triage's published time from state> --scratch <scratch> [--merge-commit <sha> [--commits <n>]]`. Post its
marker as a reply on the log thread (`state` → `log.id`): `🤖 Review metrics recorded.` and the marker,
`--key pr-babysit:metrics`.

## 6. What is on the PR afterwards

babysit.mjs sets all of this; the table is for reading a PR.

| On the PR | Key | Status |
|---|---|---|
| the log: triage, then per round its findings, outcomes and summary, then the report and the metrics, as replies | `pr-babysit:triage` | `closed` |
| a decision waiting for the user | `pr-babysit:R<n>-F<k>` | `pending`, then `fixed` or `closed` once decided |
| a declined finding: false positive | `pr-babysit:R<n>-F<k>` | `closed` |
| a declined finding: by design | `pr-babysit:R<n>-F<k>` | `byDesign` |
| a declined finding: real but out of scope (say where it is tracked) | `pr-babysit:R<n>-F<k>` | `wontFix` |
| a red build before a round | `pr-babysit:R<n>-B<k>` | `active`, then `fixed` |
| a person's thread: claim confirmed and not fixed yet | theirs | `active` |
| a person's thread: fixed, refuted or answered | theirs | `fixed` or `closed` |
| review-only mode: every finding | `pr-babysit:R<n>-F<k>` | `active`, for the author |

A PR reviewed before version 4.6 has one thread per finding, one per round summary and a report thread;
`state` reads both layouts, and a later round on such a PR continues in the new one.
