# skills

My own Claude Code skills. I write them myself so I know what each one does.

They take a ticket to merged code and ask me only for what is mine to decide:

```
ticket ──► spec-feature ──► build-feature ──► babysit-pr ──► merge-pr
```

**[The user guide](docs/GUIDE.md)** walks through it: what each step writes where, what you have to read
and what you can ignore, which model runs what and why, and how to improve every default.

## Skills

| Skill | What it does |
|---|---|
| [spec-feature](skills/spec-feature/SKILL.md) | Turns a ticket or an idea into an approved spec through a conversation: testable acceptance criteria, your decisions, a plan and a risk forecast, written into the ticket |
| [build-feature](skills/build-feature/SKILL.md) | Builds an approved spec criterion by criterion (failing test, pass, one commit each), closes each sub-task, opens a draft PR |
| [babysit-pr](skills/babysit-pr/SKILL.md) | Takes a PR from review to merge: review rounds sized by risk, fixes with proof, decisions put to you, one log thread and a thread only where you are needed |
| [merge-pr](skills/merge-pr/SKILL.md) | Merges a PR and watches it land: auto-merge, failed builds, conflicts, approvals, cleanup, one comment on the ticket |
| [sync-ticket](skills/sync-ticket/SKILL.md) | Keeps the ticket in step: the Specification section of its description, one sub-task per acceptance criterion, without touching what the stakeholder wrote |
| [pr-host](skills/pr-host/SKILL.md) | One command line for pull requests on GitHub, GitLab, Azure DevOps or plain git: threads, description, checks, failed logs, auto-merge, watch |
| [score-pr](skills/score-pr/SKILL.md) | Scores a PR 0-100 from blast radius and one-way/two-way door, names the review tier |
| [setup-repo](skills/setup-repo/SKILL.md) | Writes the repository profile: drafted by itself on first contact, calibrated against recent merges when you run it |
| [measure-prs](skills/measure-prs/SKILL.md) | Shows what the reviews cost and found, where a round's money went, which defects escaped review, and proposes tier changes backed by the numbers |

They ship together as the `denisulmer-skills` plugin, because they call each other. Nothing outside this
repository is needed besides Node 18+, git 2.38+ and the sign-in for where your code lives. Jira with Azure
DevOps is the pair they are used with every day; GitHub, GitLab and plain git work through the same
commands.

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

## Use

```
/denisulmer-skills:spec-feature SHOP-228
/denisulmer-skills:build-feature SHOP-228
/denisulmer-skills:babysit-pr 123
/denisulmer-skills:merge-pr 123
/denisulmer-skills:score-pr https://github.com/<owner>/<repo>/pull/123
/denisulmer-skills:setup-repo
/denisulmer-skills:measure-prs
```

`spec-feature` carries on by itself to the merge question once you approve the spec. Each skill also works
alone: `babysit-pr` on any pull request, `spec-feature "an idea"` without a ticket. Start `spec-feature` or
`babysit-pr` in a session of its own: they run for a while and wait for you at decisions, at the spec
approval and at the merge. The session only conducts, so Claude Code's default (Opus at medium effort) is
enough for it: each review tier names the model and effort of its reviewers, skeptics, fixer and builder
([the table](docs/GUIDE.md#6-what-is-used-and-why)).

No setup is needed first. A repository without a profile gets one drafted from its files, and the skill
says what it assumed; `setup-repo` calibrates it later.

## Develop

```powershell
./install.ps1
```

Links every folder under `skills/` into `~/.claude/skills/` with a directory junction, so edits here are
live in the next Claude Code session (skills then have no `denisulmer-skills:` prefix). Rerun it after a
skill is added. Use this or the plugin, not both, or every skill shows up twice.

```
node --test tests/*.test.mjs
```

runs the tests: the review round with stub agents, `babysit.mjs` end to end on a throwaway repository, the
ticket section in Jira's format and in Markdown, the profile draft, the price table.

Every change to `skills/` ships as a release: raise `version` in
[.claude-plugin/marketplace.json](.claude-plugin/marketplace.json), add a section for it to
[CHANGELOG.md](CHANGELOG.md), push. The [release workflow](.github/workflows/release.yml) runs the tests,
tags the version and publishes a GitHub release with that section as its notes, and fails when `skills/`
changed without a new version. [CLAUDE.md](CLAUDE.md) says what every change is measured against.

## License

[MIT](LICENSE)
