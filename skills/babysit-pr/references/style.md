# Writing for the reviewer

Everything babysit-pr, merge-pr and score-pr write has one reader who matters: the user, deciding what
deserves their attention. A person who has to read everything ends up approving everything. So the review
is **quiet**: it posts as little as it can, and what it posts lets them stop reading as early as possible.

## Contents

1. What a person has to read
2. Rules
3. On the PR
4. In chat: the start line, one line per round, decisions, the merge question
5. Push notifications

## 1. What a person has to read

| Reads | Where | When |
|---|---|---|
| ❓ a decision | chat (Decisions message), with a thread at the code line | only when the fixer may not decide |
| 👀 a judgement call | the merge question and the PR description, one line each with a link | at the merge |
| the cover page | the PR description: what changed, why, how dangerous, the 👀 list | once |

Everything else is the **log**: one closed thread on the PR that holds the triage, each round's findings,
outcomes and summary, the checks and the original description. It is there for an audit and for resuming;
nobody has to open it. A finding fixed with proof is one line in the log and a commit.

A 👀 item is a call a person may disagree with: a declined finding, a major finding a skeptic disproved, a
person's comment that was refuted, a fix in a risky area the PR did not touch before, a tier raised mid-way.

## 2. Rules

1. **The first line is the outcome or the ask.** "Needs Denis: keep the route for one more release?",
   "Declined, by design: ADR-0038 allows it". Detail follows for whoever wants it.
2. **One comment per thing.** A thread that needs a person says the ask or the verdict, and the finding it
   is about, in its first comment.
3. **The same icons everywhere.** Severity: 🔴 blocker · 🟠 major · 🟡 minor · ⚪ nit. Outcome:
   ✅ fixed · ↩️ declined · 🧭 decided by <name> · ❓ needs <name> · ⚠️ unproven.
4. **Short lines, no walls.** One fact per bullet, at most three sentences per paragraph, a table when
   three or more items share the same fields.
5. **Separate lines with a blank line, or make them list items.** Azure DevOps and GitHub join
   consecutive lines into one paragraph.
6. **Evidence goes in a code block**, trimmed to the lines that make the point (ten at most, `…` for
   cuts), with the command named above it.
7. **Link instead of repeating.** Threads: `<thread url>`. Commits: `<repoWebUrl>/commit/<full sha>`, shown
   as the short sha in backticks.
8. **Machinery last, in italics.** Who found it, which model, the skeptic's verdict, the round: readers
   skip it, auditors find it.
9. **The repository's words.** Domain nouns from `CONTEXT.md`; for the review itself, "reviewer",
   "check", "round".
10. **Every PR comment starts with 🤖**, so nobody takes it for something the user typed. Write in a
    neutral voice ("Checked: …"), because the comment carries the user's name.

## 3. On the PR

`scripts/babysit.mjs` posts the log, the findings, the decision and decline threads and the replies on
people's threads, each with its key and status; `summary --print` shows what a round's summary looks like.
Statuses are pr-host's; on GitHub and GitLab the resolved ones (`fixed`, `wontFix`, `byDesign`, `closed`)
resolve the thread.

What you post by hand (merge-pr's late comments and build fixes) follows the same shapes. Replies on a
person's thread:

- Confirmed (stays `active` until fixed, then a Fixed reply with cause, change and proof):
  `🤖 **Checked: right.** <file:line and what is wrong>. Tracked as R2-F4; the fix will be linked here.`
- Refuted (status `closed`): `🤖 **Checked: this doesn't hold.** <the file:line and output that settle it>`
  and `Reopen the thread if there is a path this misses.`
- Answered (status `closed`): `🤖 **Answer:** <the answer>`

## 4. In chat

**Chat budget.** Chat holds the start line, at most one line per round, Decisions messages, and the merge
question. Fixes, findings and round details live in the log.

### Start line

It says what the review will use and why, so nothing about it is a surprise later:

~~~markdown
**PR !27887 · risk 52/100 · medium review.** Using: profile `contoso-shop` (drafted automatically, not calibrated) · Opus at medium effort, 3 reviewers and a skeptic · up to 3 rounds. Round 1 is running; I'll only interrupt you for decisions.
~~~

### One line per round

~~~markdown
Round 1: 5 found, 4 fixed, 1 needs you (below).
~~~

Leave it out when the round needs nothing from the user and the merge question follows anyway.

### Decisions

One message per round, everything else already fixed and pushed. The user answers in one line.

~~~markdown
**PR !27887 · round 1 · 2 decisions need you.** Everything else is fixed and pushed.

**1 · Keep the legacy route for one more release?** 🟠 [R1-F2](<thread url>)

Removing `/account-information` breaks any supplier tooling that still calls it, and nothing here shows who does.

- **A (recommended):** keep it with a `Deprecation` header and remove it next release. Safe; one more release of dead code.
- **B:** remove it now. Clean; callers get a 404 immediately.

**2 · Accept a breaking change to the CSV header?** 🟡 [R1-F5](<thread url>)

…

Reply like `1A 2B`, or `ok` for all recommendations.
~~~

### Another round?

Only before a second full round (`args` printed `ask: true`): someone else pushed, or the tier rose.

~~~markdown
**PR !27887 · 3 commits arrived after round 2** that this review did not write.

Reviewing the whole change again takes 7 reviewers (~1 h). Run it, or go to the report as it is?
~~~

### Round failed

A 5-hour usage limit retries by itself (rounds.md §1); say so in one line, no question:

~~~markdown
**PR !27887 · round 1 paused:** the 5-hour usage limit was reached. It resumes by itself at 6:45 pm; nothing was lost or posted.
~~~

A weekly limit or any other failure needs the user:

~~~markdown
**PR !27887 · round 3 stopped:** 5 reviewers got no answer (weekly usage limit, resets Oct 30, 9 pm). Nothing from this round was posted.

Say **retry** when the limit has reset, or **report** to finish with the rounds that completed.
~~~

### Round limit reached

~~~markdown
**PR !27887 · round limit reached (3 of 3).** 1 finding is still open:

- 🟠 [R3-F1](<thread url>) the retry loop can submit test results twice

Run **another round**, **accept** the PR as it is (the finding stays open on the PR), or **stop** here?
~~~

### Merge question

The one message the user reads in full: the verdict, what is still owed, the 👀 list, the cost, the ask.

~~~markdown
**PR !27887 is ready to merge:** risk 52/100 · medium · 2 rounds, the last one clean

✅ 3 fixed · ↩️ 1 declined · 🧭 1 decided by you · nothing open

❓ Still needs an approval from Jane Doe (required reviewer); auto-merge will wait for it.

👀 Worth a glance first:

- [R1-F4](<thread url>) declined as a false positive: the 500 path is unreachable behind `KeyMiddleware`

Cost: 2 rounds, about $14 at API list prices.

Merge with a merge commit and delete the branch?
~~~

The cost line is `cost.line` from `babysit.mjs state`. When the profile was drafted automatically and never
calibrated, add one line after it: `The repository profile is a draft: /setup-repo calibrates it against
your last 20 merges.`

### Merge progress

Say something only when the state changes in a way the user would care about:

- `Auto-merge is set; waiting for the PR build.`
- `The PR build failed in check-frontends (lint). Fixed in 1a2b3c4; the build is running again.`
- `**PR !27887 merged** as 1a2b3c4. Branch deleted, worktree removed.`

## 5. Push notifications

Only for ❓ items and endings. One line, under 200 characters, the PR first, then what to do.

| When | Message |
|---|---|
| decisions wait | `PR !27887: 2 decisions need you (round 2)` |
| another full round to approve | `PR !27887: 3 new commits after round 2. Review the whole change again?` |
| round failed and needs you (not a 5-hour limit) | `PR !27887: round 3 stopped, weekly usage limit reached. Nothing posted` |
| review finished | `PR !27887 ready to merge: risk 52, 3 fixed, 1 worth a glance` |
| round limit hit | `PR !27887: round limit reached, 1 major finding open` |
| waiting for approval | `PR !27887: checks green, waiting 2 h for approval by Jane Doe` |
| merge stuck | `PR !27887 merge stuck: check-frontends failed 3 times` |
| merged | `PR !27887 merged as 1a2b3c4` |
