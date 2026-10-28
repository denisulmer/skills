# skills

My own Claude Code skills. I write them myself so I know what each one does.

## Skills

| Skill | What it does |
|---|---|
| [pr-setup](skills/pr-setup/SKILL.md) | Sets a repository up: platform, sign-in, and a calibrated repository profile |
| [pr-host](skills/pr-host/SKILL.md) | One command line for pull requests on GitHub, GitLab, Azure DevOps or plain git: threads, description, checks, failed logs, auto-merge, watch |
| [pr-risk](skills/pr-risk/SKILL.md) | Scores a PR 0-100 from blast radius and one-way/two-way door, names the review tier |
| [pr-babysit](skills/pr-babysit/SKILL.md) | Takes a PR from review to merge: tiered review rounds recorded as PR threads, fixes with proof, decisions put to you, a report in the description |
| [pr-merge](skills/pr-merge/SKILL.md) | Merges a PR and watches it land: auto-merge, failed builds, conflicts, cleanup |

They ship together as the `denisulmer-skills` plugin, because they call each other: `pr-babysit` calls `pr-risk`,
then runs `skills/pr-babysit/workflows/review-round.js` once per round, then `pr-merge`. All of them post
and read through `pr-host`. The review tiers live in `skills/pr-babysit/references/tiers.json`. Nothing
outside this repository is needed besides Node 18+, git 2.38+ and the host's sign-in.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install denisulmer-skills --marketplace denisulmer/skills
```

On older versions, add the marketplace first:

```
/plugin marketplace add denisulmer/skills
/plugin install denisulmer-skills@denisulmer
```

`/plugin marketplace update denisulmer` picks up new versions; [releases](https://github.com/denisulmer/skills/releases)
say what changed. Installed an older version as `denisulmer@denisulmer` (2.x) or `ado-pr@denisulmer` (1.x)? Uninstall it first.

## Platforms

| Platform | Sign in |
|---|---|
| GitHub (and Enterprise) | `gh auth login` or `GH_TOKEN` |
| GitLab (and self-managed) | `glab auth login` or `GITLAB_TOKEN` |
| Azure DevOps | `az login` or `AZURE_DEVOPS_EXT_PAT` |
| Plain git, any other remote, or none | nothing: the review lives in the repo's git directory, the merge is a local merge plus a push |

## Set up a repository

Run `pr-setup` in the repository once. It checks the sign-in and drafts a **repository profile** with you:
what is dangerous where, which checks a fix must pass, how the repository merges. It calibrates the draft
against the last 20 merges, then saves it either for the team (`.claude/pr-profile.md`, committed; read
from the PR's target branch so a PR cannot loosen its own rules) or just for you
(`~/.claude/pr-profiles/`, which overrides the team's). Both work from any worktree.
[The format](skills/pr-setup/references/profile-format.md).

## Use

```
/denisulmer-skills:pr-setup
/denisulmer-skills:pr-risk https://github.com/<owner>/<repo>/pull/123
/denisulmer-skills:pr-babysit 123
/denisulmer-skills:pr-merge 123
```

Start `pr-babysit` in a session of its own: it runs for a while and waits for you at decisions and at the
merge.

## Develop

```powershell
./install.ps1
```

Links every folder under `skills/` into `~/.claude/skills/` with a directory junction, so edits here are
live in the next Claude Code session (skills then have no `denisulmer-skills:` prefix). Use this or the plugin,
not both, or every skill shows up twice.

Every change to `skills/` ships as a release: raise `version` in
[.claude-plugin/marketplace.json](.claude-plugin/marketplace.json), add a section for it to
[CHANGELOG.md](CHANGELOG.md), push. The [release workflow](.github/workflows/release.yml) tags it and
publishes a GitHub release with that section as its notes, and fails when `skills/` changed without a
new version.

## License

[MIT](LICENSE)
