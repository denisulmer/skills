# skills

My own Claude Code skills. I write them myself so I know what each one does.

## Skills

| Skill | What it does |
|---|---|
| [spec-feature](skills/spec-feature/SKILL.md) | Turns a feature idea into an approved spec through a conversation: testable acceptance criteria, your decisions, a plan and a risk forecast |
| [build-feature](skills/build-feature/SKILL.md) | Builds an approved spec AC by AC (failing test, pass, one commit each), checks every AC is covered, opens a draft PR |
| [setup-repo](skills/setup-repo/SKILL.md) | Sets a repository up: platform, sign-in, and a calibrated repository profile |
| [pr-host](skills/pr-host/SKILL.md) | One command line for pull requests on GitHub, GitLab, Azure DevOps or plain git: threads, description, checks, failed logs, auto-merge, watch |
| [score-pr](skills/score-pr/SKILL.md) | Scores a PR 0-100 from blast radius and one-way/two-way door, names the review tier |
| [babysit-pr](skills/babysit-pr/SKILL.md) | Takes a PR from review to merge: tiered review rounds recorded as PR threads, fixes with proof, decisions put to you, a report in the description |
| [merge-pr](skills/merge-pr/SKILL.md) | Merges a PR and watches it land: auto-merge, failed builds, conflicts, approvals, cleanup |
| [measure-prs](skills/measure-prs/SKILL.md) | Shows what the reviews cost and found, per tier, round and lens, finds defects that escaped review (you confirm each), and proposes tier changes backed by the numbers |

They ship together as the `denisulmer-skills` plugin, because they call each other. From an idea to merged
code: `spec-feature` → (your approval) → `build-feature` → `babysit-pr` → (your "merge") → `merge-pr`, and you
are asked only at decisions. `babysit-pr` calls `score-pr`, then runs
`skills/babysit-pr/workflows/review-round.js` once per round, then `merge-pr`. All of them post
and read through `pr-host`. Every round and PR leaves a metrics record (a local ledger in
`~/.claude/pr-metrics/` and a hidden marker on the PR) that `measure-prs` reports on. The review tiers live in `skills/babysit-pr/references/tiers.json`. Nothing
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

Run `setup-repo` in the repository once. It checks the sign-in and drafts a **repository profile** with you:
what is dangerous where, which checks a fix must pass, how the repository merges. It calibrates the draft
against the last 20 merges, then saves it either for the team (`.claude/pr-profile.md`, committed; read
from the PR's target branch so a PR cannot loosen its own rules) or just for you
(`~/.claude/pr-profiles/`, which overrides the team's). Both work from any worktree.
[The format](skills/setup-repo/references/profile-format.md).

## Use

```
/denisulmer-skills:setup-repo
/denisulmer-skills:spec-feature "suppliers' API keys should expire after 90 days"
/denisulmer-skills:build-feature docs/specs/2026-11-02-supplier-key-expiry.md
/denisulmer-skills:score-pr https://github.com/<owner>/<repo>/pull/123
/denisulmer-skills:babysit-pr 123
/denisulmer-skills:merge-pr 123
/denisulmer-skills:measure-prs
```

Start `spec-feature` or `babysit-pr` in a session of its own: they run for a while and wait for you at
decisions, at the spec approval and at the merge. The session only conducts, so Claude Code's default
(Opus at medium effort) is enough for it: each tier names the model and effort of its reviewers, skeptics,
fixer and builder in `tiers.json`, from Sonnet at medium for a trivial change to Opus at high plus a Fable
adversary for a critical one.

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
