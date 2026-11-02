---
name: measure-prs
description: Measure what babysit-pr runs cost and what they found - tokens, wall time and agents per round, findings kept and refuted per reviewer lens, fixes, decisions, failed rounds - from the local metrics ledger, and propose changes to the review tiers or the repository profile backed by those numbers. Use when the user asks what the PR reviews cost, whether later rounds or a lens are worth it, how the tiers should be tuned, "measure", "metrics", "stats" or "how is babysit doing", or wants to import metrics from PRs reviewed in another session.
---

# Measure PR reviews

`<measure>` = `node <base>/scripts/measure.mjs`. Read its header for every flag.

babysit-pr records one line per review round and one per PR into a ledger per repository,
`<config>/pr-metrics/<repo>.jsonl` (`<config>` = `$CLAUDE_CONFIG_DIR` or `~/.claude`), and leaves the same
record as a hidden `<!-- pr-metrics … -->` marker on the PR. Tokens are counted from this machine's
session transcripts and recorded as weighted input-token equivalents (cache writes 1.25×, cache reads
0.1×, output 5×): good for comparing runs, not a bill. A record whose transcript could not be read says
`tokens.source: unknown`.

## Steps

1. **Fill the ledger.** For PRs reviewed in another session or on another machine, read their markers
   back: `<measure> import --repo <checkout> --pr <id|url>`. Records are keyed, so importing twice is harmless.
2. **Report.** `<measure> report --repo <checkout>` (or `--all`, and `--since YYYY-MM-DD` to compare
   before and after a release; each record names the plugin `version` that produced it). Show the
   markdown it prints. When the user wants a chart, chart from `--json`.
3. **Read the signals.** The report's Signals section lists facts with enough data behind them (a quiet
   later round, a lens that rarely finds anything, skeptics that rarely refute or refute most, rounds
   lost to usage limits, a fixer that declines often). No signals means there is not enough data yet:
   say how many rounds are recorded and stop there rather than guessing.
4. **Propose.** For each signal, one proposal: the change, the numbers behind it, what it would save,
   and what it risks. Proposals go to one of two places:
   - **The tiers** (`<base>/../babysit-pr/references/tiers.json` in the skills repository): rounds,
     lenses, `followUpLenses`, skeptic counts and models, effort, `severityBar`.
   - **The repository profile** (the setup-repo skill edits it): danger-map floors and caps when a
     tier's PRs keep coming back clean or keep failing, checks, conventions.
   Recommend at most three, strongest evidence first. Change nothing yourself: the user decides, and a
   change to the skills repository is a release.

## What the numbers can't say yet

Whether review missed something only shows after the merge. Until the escape scan exists, ask the user
for bugs they traced back to a reviewed PR, and weigh proposals that remove review accordingly.
