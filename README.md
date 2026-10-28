# skills

My own Claude Code skills. I write them myself so I know what each one does.

## Skills

| Skill | What it does |
|---|---|
| [ado-pr](skills/ado-pr/SKILL.md) | Azure DevOps pull requests from the terminal: threads, description, policies, build failures, auto-complete, watch |
| [pr-risk](skills/pr-risk/SKILL.md) | Scores a PR 0-100 from blast radius and one-way/two-way door, names the review tier |
| [pr-babysit](skills/pr-babysit/SKILL.md) | Takes a PR from review to merge: tiered review rounds recorded as PR threads, fixes with proof, a grill round for decisions, a report in the description |
| [pr-merge](skills/pr-merge/SKILL.md) | Merges a PR and watches it land: auto-complete, failed builds, conflicts, cleanup |

All four ship together as the `ado-pr` plugin, because they call each other: `pr-babysit` calls `pr-risk`,
then runs `skills/pr-babysit/workflows/review-round.js` once per round, then `pr-merge`. All of them post
and read through `ado-pr`. The review tiers live in `skills/pr-babysit/references/tiers.json`.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install ado-pr --marketplace denisulmer/skills
```

On older versions, add the marketplace first:

```
/plugin marketplace add denisulmer/skills
/plugin install ado-pr@denisulmer
```

`/plugin marketplace update denisulmer` picks up new versions.

The Azure DevOps skills need Node 18+ and a signed-in Azure CLI (`az login`) or `AZURE_DEVOPS_EXT_PAT`.

## Repository profiles

A profile tells `pr-risk`, `pr-babysit` and `pr-merge` what is dangerous in one repository, which checks
to run and how it merges. Put yours in `~/.claude/pr-risk/profiles/`: they are read before the bundled
ones, survive plugin updates and stay private. [skills/pr-risk/profiles/README.md](skills/pr-risk/profiles/README.md)
has the format. Without a profile, `pr-risk` scores with defaults and offers to draft one.

## Use

```
/ado-pr:pr-babysit 27887
/ado-pr:pr-risk https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/27887
/ado-pr:pr-merge 27887
```

Start `pr-babysit` in a session of its own: it runs for a while and waits for you at decisions and at the
merge.

## Develop

```powershell
./install.ps1
```

Links every folder under `skills/` into `~/.claude/skills/` with a directory junction, so edits here are
live in the next Claude Code session (skills then have no `ado-pr:` prefix). Use this or the plugin, not
both, or every skill shows up twice.
