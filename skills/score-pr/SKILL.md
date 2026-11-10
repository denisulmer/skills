---
name: score-pr
description: Score how dangerous a pull request or branch is, 0-100, from its blast radius and whether it is a one-way or two-way door, and name the review tier that follows (trivial, low, medium, high, critical). Use when the user asks how risky a PR or change is, "is this a one-way door", "what's the blast radius", or how much review a change deserves. babysit-pr runs it as its first step.
---

# PR risk

**score = blast radius (0-60) + door (0-40) + adjustments**, held between the floor and cap that the
repository's danger map imposes. The number decides how hard a change gets reviewed, so it has to be
explainable in two sentences: a score nobody can explain is a score nobody can calibrate.

Scripts live in this skill's base directory. The PR commands come from the `pr-host` skill beside it
(`<pr-host>` = `node <base>/../pr-host/scripts/pr-host.mjs`; GitHub, GitLab, Azure DevOps or plain git).

## Steps

1. **Get the change.**
   - A PR: `<pr-host> show <id|url>` gives source and target branches and the head commit.
     Then `git fetch origin <source> <target>`. A completed PR's source branch is usually deleted: use
     its `sourceCommit` as head and `targetCommit` as base instead.
   - A branch without a PR: base is `origin/<target branch>` (or the target branch itself when the repo
     has no remote), head is `HEAD`.
   - Read the PR description and any linked issue or work item: they state the intent the door and radius
     are judged against.
2. **Count.** `node <base>/scripts/signals.mjs --base origin/<target> --head <head commit> --repo <checkout> > <scratch>/signals.json`.
   It reports sizes, the danger-map rules the change hits, destructive migration lines, and
   `bounds` (floor, cap, adjust, with reasons). The repository profile comes from `~/.claude/pr-profiles/`
   (matched by remote URL or checkout path) or else the repo's `.claude/pr-profile.md` as committed on the
   base, never the head, so a change cannot loosen its own rules; `profile.source` says which. With no
   profile, run setup-repo's quick setup first (`<base>/../setup-repo/SKILL.md`; it asks nothing) and
   count again. A profile with `calibrated: false` was only drafted: say so next to the score.
3. **Read the diff.** All of it up to about 1,500 changed lines; beyond that, every file the signals
   flagged plus a skim of the rest. Look for what counting can't see: a renamed JSON property is a contract
   change, a "refactor" that changes a default is a behaviour change, a deleted file may be the only reader
   of a column.
4. **Answer the rubric's questions** ([references/rubric.md](references/rubric.md)): the blast-radius band
   and the door, one sentence of why for each, and yes or no on each factor. The profile's judgment notes
   name this repo's one-way doors. You choose bands and answers; you never choose points.
5. **Name the fact the change is safe because of.** Most risky-looking changes are safe because of one
   fact ("the column is new and nothing reads it yet"). Say whether you proved it by reading the code. An
   unproven safety fact is what the review has to settle first.
6. **Compute.** Write the answers to `<scratch>/risk-answers.json`:
   ```json
   { "radius": "cross-module", "radiusWhy": "...", "door": "costly", "doorWhy": "...",
     "factors": { "thinTests": false, "newTerritory": false, "concurrencyOrTime": false, "mechanical": false },
     "safeBecause": "...", "safeBecauseProven": false, "watch": ["..."] }
   ```
   then `node <base>/scripts/score.mjs --answers <scratch>/risk-answers.json --signals <scratch>/signals.json`.
   It places the points, applies the adjustment, floor and cap (the floor wins when floor > cap), and names
   the tier from tiers.json's bands. Its output is the JSON block below; don't change its numbers.

## Output

A fenced JSON block first, because babysit-pr parses it:

```json
{
  "score": 48,
  "tier": "medium",
  "door": "costly",
  "doorWord": "two-way, costly",
  "doorPoints": 9,
  "doorWhy": "Reverting restores everything, but the generated clients must be regenerated with it.",
  "radius": "cross-module",
  "radiusWord": "cross-module",
  "radiusPoints": 39,
  "radiusWhy": "Changes the shared material-number parser that Serialization and Supplier Portal both call.",
  "adjust": 0,
  "floor": 40,
  "cap": 100,
  "boundReasons": ["backend API surface or generated models shared by three frontends"],
  "factors": { "thinTests": false, "newTerritory": false, "concurrencyOrTime": false, "mechanical": false },
  "position": 0.4375,
  "safeBecause": "Both callers already pass canonical numbers, so the new normalization is a no-op for them.",
  "safeBecauseProven": false,
  "watch": ["callers outside the two modules", "stored numbers with leading zeroes"],
  "profile": "contoso-shop-monorepo",
  "formula": "radius 39 + door 9 = 48"
}
```

Then the part for people, short enough to read in ten seconds:

```markdown
**48/100 · medium review**

**48** = blast radius 39 (cross-module) + door 9 (two-way, costly), above the floor of 40 · safety fact unproven

- **Door, two-way:** reverting restores everything, but the generated clients must be regenerated with it.
- **Blast radius, cross-module:** the shared material-number parser is called by Serialization and Supplier Portal.
- **Safe because:** both callers already pass canonical numbers. ⚠️ Unproven.
- **Review hardest:** callers outside the two modules; stored numbers with leading zeroes.
```

Add one line for anything that blocks the PR regardless of its risk (it no longer merges, its build is
red), and nothing else.

When the user asks how much review the PR needs, describe its tier from
`<base>/../babysit-pr/references/tiers.json` (reviewers, their model and effort, skeptics, rounds); don't
improvise a review plan.

Post the result to the PR only when asked; babysit-pr posts its own triage thread.

**A plan instead of a change** (spec-feature's forecast): list the files the plan expects to touch, one per
line, and run `signals.mjs --planned <file> --base origin/<target> --repo <checkout>` instead of step 2; the
rest is the same, judged on what the plan describes.

## Scoring is not reviewing

Stop as soon as you can explain the number and name what the review should watch. Proving the safety
fact by reading is enough; don't build, run test suites or trial-merge to score. Finding defects is the
review rounds' job, and a scorer that reviews costs the time the tiers exist to save.
