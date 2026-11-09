---
name: spec-feature
description: Turn a feature idea into an approved spec through a conversation - one question at a time until every open point is settled - with numbered, testable acceptance criteria, the user's decisions (one-way doors decided up front), a plan, and a risk forecast, saved as docs/specs/<date>-<slug>.md on a new feature branch; once the user approves it, build-feature builds it and babysit-pr takes it to the merge gate. Use when the user wants to build, add or change a feature and it isn't specified yet, says "spec this", "let's plan X", "I want to build", "write a spec", or starts the feature-to-merge pipeline. Not for a bug fix with an obvious cause or a change already specified.
---

# Spec a feature

```
spec-feature "<idea>"
 1 Explore    read the code, the domain words, the profile; ask nothing the code answers
 2 Grill      one question at a time until no open point is left
 3 Draft      docs/specs/<date>-<slug>.md on feature/<slug>: ACs, non-goals, decisions, plan
 4 Forecast   score-pr on the plan → tier; every one-way door becomes a decision
 5 Check      medium tier and up: one skeptic reads the spec for gaps
 6 Approve    the user's yes in chat → status approved → build-feature
```

`<signals>` = `node <base>/../score-pr/scripts/signals.mjs`, `<score>` = `node <base>/../score-pr/scripts/score.mjs`,
`<measure>` = `node <base>/../measure-prs/scripts/measure.mjs`. The spec's shape is
[references/spec-format.md](references/spec-format.md); read it before drafting.

## 1. Explore

Start the clock: note the time (the phase's metrics start here) and make a scratch directory
`spec-<slug>` in the session scratchpad.

Before asking anything, read what the repository already says: `CONTEXT.md` and the agent guides
(`AGENTS.md`, `CLAUDE.md`), ADRs that touch the area, the code the idea would change and its tests, and the
repository profile (`<signals> --which-profile --base origin/<default branch> --repo <repo>`), whose
judgment notes name this repo's one-way doors. Use the repository's domain words from here on.

## 2. Grill

Ask the user one question at a time, each answerable in a line, until nothing is open. The user's
attention is the scarce resource: never ask what the code, the docs or a sensible default answers; say
the default you took instead and move on.

- **Use AskUserQuestion** for each question: two to four options, the recommended one first and marked,
  each with what it costs. Free-text questions only when options would be guesses.
- **Order:** the outcome and who it is for; what is out of scope; behaviour at the edges (empty, missing,
  old data, concurrent use, failure); one-way doors (stored data, schema, public contracts, keys, anything
  others already call); how each outcome will be verified.
- **One-way doors are always asked**, however obvious the answer seems, and the answer is recorded with
  the user's name. A wrong one-way decision costs a recovery; a question costs a minute.
- Keep a running list of open points in the scratch directory; when an answer raises a new question, add it.
- Stop when the list is empty. Say so in one line ("No open points left; drafting the spec.").

## 3. Draft

1. **Branch and worktree.** `git -C <repo> fetch origin <default branch>`, then
   `git -C <repo> worktree add -b feature/<slug> <repo>/../<repo name>-<slug> origin/<default branch>`.
   Work there for everything that follows; never in a checkout with uncommitted changes.
2. **Write** `docs/specs/<YYYY-MM-DD>-<slug>.md` in the shape of spec-format.md, status `draft`:
   - acceptance criteria as observable statements, each with `· *verified by*`; prefer `test`;
   - every answer from the grilling under Decisions, one-way doors marked 🚪 with the user's name;
   - the Plan as the files or modules you expect to change, from reading the code.
3. Don't commit yet.

## 4. Forecast

1. Write the Plan's paths, one per line, to `<scratch>/planned.txt` (`+ ` before a file that does not exist
   yet, `- ` before one to delete) and run
   `<signals> --planned <scratch>/planned.txt --base origin/<default branch> --repo <worktree> > <scratch>/signals.json`.
2. Answer score-pr's rubric questions for the change the spec describes (`<base>/../score-pr/references/rubric.md`)
   into `<scratch>/risk-answers.json`, and `<score> --answers <scratch>/risk-answers.json --signals <scratch>/signals.json`.
   A plan has no tests yet: answer `thinTests` for the tests the ACs will add, not for today's.
3. Put the result under Risk forecast and in `risk:` (tier and score).
4. **Every one-way door** the forecast or the plan reveals that is not yet under Decisions goes back to the
   user as a question (step 2's rules). The spec cannot be approved with an undecided one-way door.

## 5. Check (medium tier and up)

Spawn one skeptic with the Agent tool (description `spec skeptic: <slug>`, `model` and `effort` = the
forecast tier's from `<base>/../babysit-pr/references/tiers.json`): give it the spec file and the
repository, and ask it to find, with file:line where it applies, ACs that cannot be verified as written,
ACs that contradict each other or a decision, behaviour the Why implies but no AC covers, edge cases from
step 2's order with no AC, and plan entries that touch a one-way door no decision covers. It changes
nothing. Fix what it found in the spec; what needs the user goes back to step 2. Trivial and low tiers
skip this step.

## 6. Approve

Send the user, in one message: the title, the ACs (one line each), the decisions (🚪 first), the forecast
tier, and what happens next ("Approve, and build-feature builds it AC by AC, opens a draft PR and
babysit-pr reviews it; you hear from me at decisions and at the merge question."). Ask for approval with
AskUserQuestion: approve, or change something.

Only an explicit approval in this chat counts. Then:

1. Set `status: approved` and `approved: <date> by <user's name>`; `Open questions` says `None.`
2. Commit the spec alone on the branch: `docs(spec): <title>`, body with the forecast line.
3. Record the phase: `<measure> phase --name spec --repo <worktree> --branch feature/<slug> --started <step 1's time> --scratch <scratch>`.
   A failing metrics script never blocks; say so in one line.
4. Run the **build-feature** skill with the spec's path and the worktree. The user chose the chain to run
   on its own from here to babysit-pr's merge question.

When the user changes something instead, edit the spec and ask again. When the user stops, leave the
branch and the draft as they are and say where they are.
