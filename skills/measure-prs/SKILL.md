---
name: measure-prs
description: Measure what babysit-pr runs cost and what they found - tokens, wall time and agents per round, findings kept and refuted per reviewer lens, fixes, decisions, failed rounds - from the local metrics ledger, find the defects that escaped review (later fixes traced back to reviewed PRs, each confirmed by the user), and propose changes to the review tiers or the repository profile backed by those numbers. Use when the user asks what the PR reviews cost, whether later rounds or a lens are worth it, how the tiers should be tuned, "measure", "metrics", "stats", "how is babysit doing" or "what slipped through review", or wants to import metrics from PRs reviewed in another session.
---

# Measure PR reviews

`<measure>` = `node <base>/scripts/measure.mjs`. Read its header for every flag.

babysit-pr records one line per review round and one per PR, and spec-feature and build-feature one per
phase (spec, build), into a ledger per repository,
`<config>/pr-metrics/<repo>.jsonl` (`<config>` = `$CLAUDE_CONFIG_DIR` or `~/.claude`), and leaves the same
record as a hidden `<!-- pr-metrics … -->` marker on the PR. Tokens are counted from this machine's
session transcripts and recorded twice: as weighted input-token equivalents (cache writes 1.25×, cache
reads 0.1×, output 5×), and as `usd`, the same usage at each model's API list price, which is the figure
to compare when tiers use different models. Both are good for comparing runs; neither is a bill. A record whose transcript could not be read says
`tokens.source: unknown`.

## Steps

1. **Fill the ledger.** For PRs reviewed in another session or on another machine, read their markers
   back: `<measure> import --repo <checkout> --pr <id|url>`. Records are keyed, so importing twice is harmless.
2. **Escapes.** `git -C <checkout> fetch origin`, then `<measure> escapes --repo <checkout>` (`--since` to
   narrow it). It lists candidates: a later fix, hotfix or revert on the default branch whose changed lines a
   reviewed PR wrote (`share` = the part of the fix's lines that trace back to it). A trace is not proof: the
   fix may change behaviour on purpose. Put each candidate to the user, one AskUserQuestion at a time: the
   PR, the fix commit's subject and link, the lines it rewrote (`git show --stat <fix>` and the hunks that
   touch the PR's lines), and the options **escaped** (review should have caught it), **not an escape**
   (new requirement, deliberate change, unrelated) or **skip for now**. Record each answer with
   `<measure> escape --repo <checkout> --pr <id> --fix <sha> --confirm|--dismiss --note "<their reason>"`;
   the scan never asks about it again. `unresolved` lists merged PRs whose merge commit was not found
   (fetch, or the merge subject names no PR number); say so in one line.
3. **Report.** `<measure> report --repo <checkout>` (or `--all`, and `--since YYYY-MM-DD` to compare
   before and after a release; each record names the plugin `version` that produced it). Show the
   markdown it prints. When the user wants a chart, chart from `--json`.
4. **Read the signals.** The report's Signals section lists facts with enough data behind them (a quiet
   later round, a lens that rarely finds anything, a tier whose merged PRs escape often or never, skeptics that rarely refute or refute most, rounds
   lost to usage limits, a fixer that declines often). No signals means there is not enough data yet:
   say how many rounds are recorded and stop there rather than guessing.
5. **Propose.** For each signal, one proposal: the change, the numbers behind it, what it would save,
   and what it risks. Proposals go to one of two places:
   - **The tiers** (`<base>/../babysit-pr/references/tiers.json` in the skills repository): lenses,
     `followUpLenses`, `skeptics` and their models, effort, `severityBar`, `maxRounds`.
   - **The repository profile** (the setup-repo skill edits it): danger-map floors and caps when a
     tier's PRs keep coming back clean or keep failing, checks, conventions.
   A proposal that changes a tier's model or effort follows the ladder in tiers.json: make sure the
   agent can check its own work first, then raise effort one level, and past `high` take the next model
   up at a lower effort. Compare by the report's $ per round, which prices each model, not by tokens, and
   keep a second model in a tier only while it finds what the first does not.

   Recommend at most three, strongest evidence first. Change nothing yourself: the user decides, and a
   change to the skills repository is a release.

## What the numbers can't say

Escapes only count what a later fix commit reveals: a bug nobody has fixed yet, or one fixed without a
`fix:` or `hotfix` subject, is invisible. Weigh proposals that remove review against how long the tier's PRs
have been merged, and ask the user about bugs they know of that the scan cannot see.
