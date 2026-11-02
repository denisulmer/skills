# Changelog

Each `## <version>` section becomes the notes of the GitHub release `v<version>`. Newest first.

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
