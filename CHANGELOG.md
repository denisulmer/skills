# Changelog

Each `## <version>` section becomes the notes of the GitHub release `v<version>`. Newest first.

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
