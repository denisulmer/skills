# Changelog

Each `## <version>` section becomes the notes of the GitHub release `v<version>`. Newest first.

## 4.3.0

`measure-prs` now finds defects that escaped review, so the tiers can be tuned on quality, not only on
cost. Nothing to do but update.

- **Escape scan:** `measure.mjs escapes` walks later `fix:`, `hotfix` and `revert` commits on the default
  branch and blames the lines each one rewrote back to the reviewed PR that wrote them (a revert of a PR's
  commit counts directly). Each candidate goes to you once: escaped or not, with a note.
  `measure.mjs escape --confirm|--dismiss` records it, and the scan never asks again.
- **In the report:** an Escaped column per tier (merged PRs with a confirmed escape), and signals for tiers
  whose PRs escape often or never.
- `merge-pr` records the merge commit (and, for a rebase or fast-forward merge, how many commits landed)
  with the PR, so the scan finds the PR's commits exactly; older records fall back to the hosts' merge
  subjects (`Merged PR 123`, `#123`, `!123`). Fixes are recognised behind those prefixes too, and a fix
  merged as a merge commit counts once.
- The report says when the scan last ran and what is still undecided, and only calls a tier escape-free
  after a scan that left nothing to decide.

## 4.2.0

The pipeline now starts at the idea: `spec-feature` turns it into an approved spec, `build-feature` builds it
and opens the PR, and babysit-pr reviews it against the spec. Nothing to do but update.

- **`spec-feature`** (new): a conversation, one question at a time, until no point is open. It writes
  `docs/specs/<date>-<slug>.md` on a new `feature/<slug>` branch: numbered acceptance criteria that each
  say how they are verified, non-goals, your decisions (one-way doors always asked and signed), a plan, and
  a risk forecast from the planned files. From medium tier up, a skeptic checks the spec first. Only your
  yes in chat approves it; then the chain runs on its own to babysit-pr's merge question.
- **`build-feature`** (new): one builder agent builds the spec AC by AC (failing test with the AC's id,
  pass, checks, one commit per AC with `Refs: spec <slug> AC<n>`). `acmap.mjs` checks every AC has its
  commit (that exact trailer) and a test carrying its id (JS/TS, C#, Java, Go, Python, Ruby, Rust), the checks run again on the head, and spec problems come to you as amendments. Then it
  opens a draft PR and starts babysit-pr.
- **Review against the spec:** babysit-pr finds the spec on the branch (by its shape, wherever it lives)
  and gives the reviewers that judge against it its ACs and the ones no test covers yet. The spec links its
  PR; once merged, it has shipped.
- **`pr-host open`** now opens a PR on GitHub, GitLab and Azure DevOps too (draft, title, description,
  default target), and returns the open PR for the branch instead of opening a second one.
- `signals.mjs --planned <file>` forecasts the risk of files a plan expects to touch. `measure-prs` records
  the spec and build phases and reports them under "Before review".

## 4.1.0

The steps that need no judgment are scripts now, so a run does them the same way every time: the risk
score, the checks a change must pass, and babysit-pr's bookkeeping. Optional: add a checks block to your
repository profile (`setup-repo` offers it).

- **Checks as data.** A profile can list its checks in a ```` ```json checks ```` block: glob → command,
  at level `fast`, `full` or `smoke`. `setup-repo/scripts/checks.mjs` runs the fast checks for the files a
  change touches and reports pass or fail. The fixer uses it, babysit-pr reruns it on every pushed head
  before it posts a fix as done, and merge-pr runs `full` only where there is no CI. A profile without
  the block still works as before.
- **Risk score by formula.** score-pr answers closed questions (blast-radius band, door, four factors,
  whether the safety fact is proven) and `score-pr/scripts/score.mjs` computes the points, floor, cap and
  tier. The same answers always give the same score. Scores can move a few points from before; every
  calibration example keeps its tier.
- **babysit-pr bookkeeping.** `babysit-pr/scripts/babysit.mjs` reads the PR back (`state`, with the stop
  rule as `next`), builds each round's inputs and picks full or delta scope (`args`), and posts the
  triage, findings, replies and round summary from the templates (`triage`, `record`, `reply`,
  `summary`). Fixes without an existing commit or proof are held back, and nothing is posted as fixed
  while the checks fail. A red build is fixed before the round's review (`fix-build`). A person's
  confirmed comment counts as a finding everywhere, and commits merged in from the target don't force a
  full round. PRs started earlier still resume; give `args` the intent once with `--intent-file`.
- `checks.mjs` passes changed file names to the shell single-quoted, so a file name cannot run commands;
  `{files}` paths are relative to the check's `cwd`.
- The profile code is shared in `setup-repo/scripts/profile.mjs`; `signals.mjs` gives the same output.

## 4.0.0

The skills are renamed verb-first, every review now leaves metrics behind, and a new `measure-prs` skill
reports on them. **Use the new names**; nothing else to do.

- **Renamed skills:** `pr-setup` → `setup-repo`, `pr-risk` → `score-pr`, `pr-babysit` → `babysit-pr`,
  `pr-merge` → `merge-pr` (for example `/denisulmer-skills:babysit-pr`). `pr-host` keeps its name. PR
  threads keep their `pr-babysit:*` keys, so PRs started before the rename still resume. With the
  development junctions, rerun `./install.ps1`: it links the new folders and removes the old links.
- **`measure-prs`** (new): every review round and every PR writes a record to a local ledger
  (`~/.claude/pr-metrics/<repo>.jsonl`) and a hidden marker on the PR: tokens from the session
  transcripts, wall time, agents, findings kept and refuted per reviewer, fixes, decisions, failed rounds.
  The skill reports per tier, round and lens, imports markers from other sessions, and proposes tier or
  profile changes backed by the numbers. It changes nothing by itself.
- **Green build first:** `babysit-pr` reviews only code whose PR build is green (or, without a build, whose
  fast check passes); a real failure is fixed before the round's review starts. The full suite runs in
  the pipeline only.
- **Approvals:** `pr-host watch` reports `approval` (`not required`, `approved`, `waiting (<who>)`).
  `merge-pr` and the merge question name approvals still owed, and a notification fires after 2 hours
  of waiting. Reviewers are never added or pinged for you.
- `merge-pr` reviews a fix to a failed build with a delta round (only the fix), not a full one.

## 3.1.0

pr-babysit spends far less per PR: later rounds review only the fixes, reviewers stop building and
running tests, and a failed or extra round asks you instead of going on. Nothing to do but update.

- **Delta rounds.** Round 1 (or one after the tier rose or someone else pushed) reviews the whole PR;
  every later round reviews only the commits since the last one, with the tier's new `followUpLenses`.
- **High tier converges.** A round is clean when it keeps no major finding (was: no minor), one clean
  round is enough (was: two), and it stops at 3 rounds (was: 4). Reviewers run at `high` effort.
  Critical is unchanged.
- **Read-only reviewers.** Only the adversary builds or runs tests, and only the filtered tests that
  prove a point. Skeptics only read.
- **Cheaper skeptics.** Major and blocker findings still get the tier's skeptics each; minor findings
  share one batched skeptic on the tier's `skepticModel` (Sonnet). The portion mapper runs on Sonnet.
- **Test gaps are nits** unless the reviewer names a plausible bug the gap lets through.
- **Failed rounds stop.** When a reviewer or skeptic returns nothing (a usage limit, say), the round
  returns `valid: false`, nothing is posted, and you get a Round failed message. Retry resumes the run
  so finished agents are not paid for twice.
- **Another round?** Before any round past the tier's minimum, you're asked first.
- The review script enters the conversation at most once, even when the plugin directory is not
  readable as a `scriptPath`.

## 3.0.0

The plugin is renamed `denisulmer` → `denisulmer-skills`; the skills themselves are unchanged.

- Skills are now `/denisulmer-skills:<skill>` (for example `/denisulmer-skills:pr-babysit`).
- Run `/plugin uninstall denisulmer@denisulmer`, then
  `/plugin install denisulmer-skills --marketplace denisulmer/skills`. The marketplace is still `denisulmer`.

## 2.0.0

The PR skills work on GitHub, GitLab, Azure DevOps and plain git, and the plugin is now called `denisulmer`.

- **Renamed plugin** `ado-pr` → `denisulmer`: skills are `/denisulmer:<skill>`. Uninstall `ado-pr@denisulmer`
  before installing `denisulmer@denisulmer`.
- **`pr-host`** replaces `ado-pr`: the same commands on every platform, with adapters for GitHub (`gh`
  sign-in), GitLab (`GITLAB_TOKEN` or `glab`), Azure DevOps (`az` sign-in) and `local` for repositories
  without a PR host, where the review lives in the git directory and merging is a local merge plus a
  push. Renamed commands: `policies` → `checks`, `requeue-policy` → `rerun-check`, `build-failures` →
  `check-failures`, `autocomplete` → `auto-merge`, `cancel-autocomplete` → `cancel-auto-merge`; new
  `merge` and (local) `open`. Merge strategies are `merge | squash | rebase | rebase-merge`; the Azure
  DevOps names still work. Threads posted by `ado-pr` are still recognised.
- **`pr-setup`** (new): detects the platform, checks the sign-in, drafts a repository profile, calibrates
  it against the last 20 merges, and saves it for the team or just for you.
- **Repository profiles** now come from `~/.claude/pr-profiles/` (matched by remote URL or checkout path)
  or a committed `.claude/pr-profile.md`, read from the PR's target branch so a PR cannot loosen its own
  rules. Both work from any worktree. `signals.mjs --which-profile` prints the one that applies. Move
  profiles from `~/.claude/pr-risk/profiles/` to `~/.claude/pr-profiles/`.
- `pr-babysit`, `pr-merge` and `pr-risk` no longer assume Azure DevOps, and no longer refer to an outside
  `/pr` skill.

## 1.0.0

First release as a Claude Code plugin marketplace: `ado-pr`, `pr-risk`, `pr-babysit` and `pr-merge` for
Azure DevOps pull requests.
