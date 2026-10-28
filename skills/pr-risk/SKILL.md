---
name: pr-risk
description: Score how dangerous a pull request or branch is, 0-100, from its blast radius and whether it is a one-way or two-way door, and name the review tier that follows (trivial, low, medium, high, critical). Use when the user asks how risky a PR or change is, wants a PR triaged or categorized before review, asks "is this a one-way door", "what's the blast radius", "how careful do we need to be with this", or wants to know how much review a change deserves. pr-babysit runs it as its first step.
---

# PR risk

**score = blast radius (0-60) + door (0-40) + adjustments**, held between the floor and cap that the
repository's danger map imposes. The number decides how hard a change gets reviewed, so it has to be
explainable in two sentences: a score nobody can explain is a score nobody can calibrate.

Scripts live in this skill's base directory. The PR commands come from the `ado-pr` skill beside it
(`<base>/../ado-pr/scripts/ado-pr.mjs`).

## Steps

1. **Get the change.**
   - Azure DevOps PR: `node <ado-pr> show <id|url>` gives source and target branches and the head commit.
     Then `git fetch origin <source> <target>`. A completed PR's source branch is usually deleted: use
     its `sourceCommit` as head and `targetCommit` as base instead.
   - Local branch: base is `origin/<target branch>`, head is `HEAD`.
   - Read the PR description and any linked work item: they state the intent the door and radius are
     judged against.
2. **Count.** `node <base>/scripts/signals.mjs --base origin/<target> --head <head commit> --repo <checkout>`.
   It reports sizes, the danger-map rules the change hits, destructive migration lines, and
   `bounds` (floor, cap, adjust, with reasons). It uses the profile whose `remotes` matches `origin`,
   looking in `~/.claude/pr-risk/profiles/` first, then this skill's `profiles/`. With no matching
   profile it applies defaults only; say so, and offer to draft a profile into `~/.claude/pr-risk/profiles/`
   (`profiles/README.md` says how).
3. **Read the diff.** All of it up to about 1,500 changed lines; beyond that, every file the signals
   flagged plus a skim of the rest. Look for what counting can't see: a renamed JSON property is a contract
   change, a "refactor" that changes a default is a behaviour change, a deleted file may be the only reader
   of a column.
4. **Judge both axes** with [references/rubric.md](references/rubric.md). Pick the band first, then the
   point inside it, and write one sentence for each. The profile's judgment notes name this repo's
   one-way doors.
5. **Name the fact the change is safe because of.** Most risky-looking changes are safe because of one
   fact ("the column is new and nothing reads it yet"). Say whether you proved it by reading the code. An
   unproven safety fact is what the review has to settle first.
6. **Compute.** raw = radius + door + adjust; score = clamp(raw, floor, cap), and the floor wins when
   floor > cap: one risky file is enough to need care. Tier: 0-15 trivial, 16-35 low, 36-60 medium,
   61-80 high, 81-100 critical.

## Output

A fenced JSON block first, because pr-babysit parses it:

```json
{
  "score": 47,
  "tier": "medium",
  "door": "two-way",
  "doorPoints": 10,
  "doorWhy": "Reverting restores everything, but the generated clients must be regenerated with it.",
  "radius": "cross-module",
  "radiusPoints": 37,
  "radiusWhy": "Changes the shared material-number parser that Serialization and Supplier Portal both call.",
  "adjust": 0,
  "floor": 40,
  "cap": 100,
  "boundReasons": ["backend API surface or generated models shared by three frontends"],
  "safeBecause": "Both callers already pass canonical numbers, so the new normalization is a no-op for them.",
  "safeBecauseProven": false,
  "watch": ["callers outside the two modules", "stored numbers with leading zeroes"],
  "profile": "contoso-shop-monorepo"
}
```

Then the part for people, short enough to read in ten seconds:

```markdown
**47/100 · medium review**

**47** = blast radius 37 (cross-module) + door 10 (two-way, costly), above the floor of 40

- **Door, two-way:** reverting restores everything, but the generated clients must be regenerated with it.
- **Blast radius, cross-module:** the shared material-number parser is called by Serialization and Supplier Portal.
- **Safe because:** both callers already pass canonical numbers. ⚠️ Unproven.
- **Review hardest:** callers outside the two modules; stored numbers with leading zeroes.
```

Add one line for anything that blocks the PR regardless of its risk (it no longer merges, its build is
red), and nothing else.

When the user asks how much review the PR needs, describe its tier from
`<base>/../pr-babysit/references/tiers.json` (rounds, reviewers, skeptics); don't improvise a review plan.

Post the result to the PR only when asked; pr-babysit posts its own triage thread.

## Scoring is not reviewing

Stop as soon as you can explain the number and name what the review should watch. Proving the safety
fact by reading is enough; don't build, run test suites or trial-merge to score. Finding defects is the
review rounds' job, and a scorer that reviews costs the time the tiers exist to save.
