# Review rounds

Every comment and chat message below follows [style.md](style.md), which holds the templates.

## Contents

1. Workflow arguments
2. Recording findings
3. Fixing, pushing, resolving
4. Asking the user
5. Closing a round
6. Thread statuses

## 1. Workflow arguments

Write the args to `<scratch>/round-<n>-args.json` (keep it for the report) and pass the object as
`args`. Do not stringify it.

**Launching.** Try `scriptPath: <base>/workflows/review-round.js` first. If the tool refuses the path as
unreadable (a plugin install directory often is), pass the file's contents once as `script`, and for every
later round use the `scriptPath` that launch returned, so the script enters this conversation only once.

**Scope.**

- `full`: the tier's lenses over the whole PR. Round 1, a round after the tier went up, and a round after
  someone other than this skill pushed code (owner mode).
- `delta`: the tier's `followUpLenses` over the commits since `sinceSha` only. Every other round, and every
  round after the first in review-only mode.

**Reading the result.** Use the returned object; don't open the agents' transcripts. When it says
`valid: false`, post nothing from it: tell the user its `reason` and `failed` list in one message, send the
Round failed notification, and stop. A usage limit is the usual cause. To retry, start the same round
again with `resumeFromRunId: <its run id>`, so the agents that finished are not paid for twice (same
session only; in a new session, rerun the round).

```json
{
  "round": 2,
  "tierName": "high",
  "tier": { "...": "the tier's entry from tiers.json, unchanged" },
  "scope": "delta",
  "pr": { "id": 27887, "title": "...", "webUrl": "...", "score": 68,
          "intent": "What the PR is for, in two or three sentences from its description and linked work item." },
  "repo": { "worktree": "C:/ws/monorepo-pr-27887", "mergeBase": "<git merge-base origin/<target> HEAD>",
            "headSha": "<git rev-parse HEAD>", "sinceSha": "<head reviewed by the previous round, or null>" },
  "signals": { "hitIds": ["auth", "api-surface"], "reasons": ["...bounds reasons..."], "destructive": [] },
  "profileNotes": "The profile's Judgment notes and Conventions sections, verbatim.",
  "prior": [{ "key": "R1-F2", "severity": "major", "file": "src/x.ts", "line": 40,
              "title": "...", "resolution": "fixed in 1a2b3c4 / declined: false positive, <reason>" }],
  "human": [{ "threadId": 183301, "author": "Jane Doe", "file": "/src/x.ts", "line": 12,
              "conversation": "Jane Doe: <text>\n---\nDenis Ulmer: <text>" }],
  "scratch": "<scratch>/round-2"
}
```

- `sinceSha`: the reviewed commit named in the previous round summary's last line. The current tier is the
  one named in the latest round summary, or in the triage thread before round 1 closes.
- `prior`: every `pr-babysit:R*-F*` thread so far: severity and title from its first line, resolution
  from its status and last reply.
- `human`: threads of `kind: human` that are `active` or `pending` and whose last comment is not yours.
  Include the whole conversation, so a reply to an earlier refutation is judged in context.
- If the Workflow tool is unavailable, tell the user, read the workflow file and run the same reviewers
  and skeptics as parallel Agent calls with its prompts, keeping its rules: only the adversary builds or
  runs tests, and minor findings share one skeptic.

## 2. Recording findings

As soon as the workflow returns:

1. **Finding threads.** For each finding without a `humanThreadId`:
   `thread-create <pr> --file <file> --line <line> [--end-line <endLine>] --key pr-babysit:<id> --body-file f.md`,
   status `active`, Finding template. Nits and disproved findings get no thread; they go into the round
   summary.
2. **People's threads.** For each verdict, reply with `--key pr-babysit:R<n>-reply-<threadId>`, using the
   Confirmed, Refuted or Answered template and the status in the table below. A confirmed comment is now
   finding `<id>`: it is fixed like the others, and its Fixed reply goes on the person's own thread.

The round summary is posted when the round closes, so it can show every outcome in one table.

## 3. Fixing, pushing, resolving

1. Spawn one fixer with the Agent tool: `model` omitted (session model), `effort` = the tier's
   `fixerEffort`. Prompt: "Read <base>/references/fixer.md and follow it", then the inputs it lists.
   It returns a JSON block with one result per finding.
2. Check the result before trusting it: every `fixed` names a commit that exists
   (`git -C <wt> log --oneline <mergeBase>..HEAD`) and a proof with real output. Send anything unproven
   back to the fixer once; after that, treat it as escalated.
3. Push without rewriting anything: `git -C <wt> push origin HEAD:refs/heads/<source>`. If it is
   rejected because the branch moved, `git -C <wt> fetch origin <source>`, `git -C <wt> merge origin/<source>`,
   rerun the fast check from the profile, push again.
4. Reply on each finding's thread (Fixed or Declined template, `--key pr-babysit:<id>-<outcome>`) and set
   its status.

## 4. Asking the user

Put every escalation of the round into one chat message (Decisions template): numbered, each with its
options, what each costs, and your recommendation, answerable in one line like `1A 2B`. Before sending
it, reply on each escalated thread with the Needs template and set it `pending`. Send a push
notification, then end the turn. Fixes that don't depend on the answers are already pushed by then.

When the user answers, run a second fixer pass for the decided findings only, push, and reply on each
thread with the Decided template, quoting the user's choice.

## 5. Closing a round

Post the round summary (`--key pr-babysit:R<n>-summary`, no file, status `closed`) with every finding's
outcome, what the skeptics disproved, the nits, and the reviewed commit in the last line. Then apply the
stop rules in SKILL.md.

## 6. Thread statuses

| Outcome | Status |
|---|---|
| finding posted, or a person's claim confirmed and not fixed yet | `active` |
| waiting for the user's decision | `pending` |
| fixed, or decided and done | `fixed` |
| declined as a false positive, a person's claim refuted, a question answered | `closed` |
| declined as by design | `byDesign` |
| declined as real but out of scope (say where it is tracked) | `wontFix` |
| triage, round summaries, report | `closed` |
