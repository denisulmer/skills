# skills

The Claude Code skills I use to take a feature from a Jira ticket to merged code without drowning in
review comments along the way.

## Why they exist

Reviewing AI-written code is tiring. When a pull request comes with dozens of comments, you stop reading
them carefully and start approving everything, which defeats the point of a review. These skills try to do
the opposite. They do the routine work themselves and only bring you what needs a person: a product
decision, a trade-off you might disagree with, and the final "merge it?".

They also try not to be magic. Every run starts by telling you what it is working with: the repository
profile, how risky the change looks, and which model reviews it. The [user guide](docs/GUIDE.md) explains
every choice they make on their own and how to change it.

## How a feature moves through them

```
ticket ──► spec-feature ──► build-feature ──► babysit-pr ──► merge-pr
```

1. **[spec-feature](skills/spec-feature/SKILL.md)** reads what the stakeholder wrote in the ticket and talks
   it through with you, one question at a time, until there is a spec with testable acceptance criteria. The
   spec goes into the ticket under its own *Specification* heading, below the stakeholder's text, which
   stays untouched. Each criterion gets a sub-task.
2. **[build-feature](skills/build-feature/SKILL.md)** builds the spec one criterion at a time: a failing
   test, the code that makes it pass, a commit. It closes each sub-task as it goes and opens a draft pull
   request.
3. **[babysit-pr](skills/babysit-pr/SKILL.md)** scores how risky the change is and reviews it to match. A
   small fix gets a quick look; a change to something hard to undo gets more reviewers, stronger models
   and a second opinion on every finding. It fixes what it can prove and asks you about the rest. Its notes
   go into a single log thread, and a finding only gets a thread of its own when you have to decide
   something.
4. **[merge-pr](skills/merge-pr/SKILL.md)** merges once you say so. It watches the build, sorts out
   conflicts and late comments, cleans up the branch, and leaves one comment on the ticket.

Once you approve the spec, the rest runs by itself until the merge question. Each skill also works on its
own: `babysit-pr` on any pull request, or `spec-feature` with an idea instead of a ticket.

Behind them are five helpers, which you rarely call yourself:

- **[sync-ticket](skills/sync-ticket/SKILL.md)** keeps the ticket's Specification section and sub-tasks up
  to date.
- **[pr-host](skills/pr-host/SKILL.md)** talks to Azure DevOps, GitHub, GitLab or a plain git repository
  through one set of commands.
- **[score-pr](skills/score-pr/SKILL.md)** rates a change from 0 to 100 by how much it can break and
  whether it can be undone.
- **[setup-repo](skills/setup-repo/SKILL.md)** teaches the skills about a repository: where the dangerous
  code is, which checks must pass, and how it merges.
- **[measure-prs](skills/measure-prs/SKILL.md)** shows what the reviews cost, what they found, and what
  slipped through, and suggests changes based on those numbers.

I use them with Jira and Azure DevOps every day. GitHub, GitLab and plain git work through the same
commands.

## Install

In Claude Code 2.1.275 or later:

```
/plugin install denisulmer-skills --marketplace denisulmer/skills
```

On older versions, add the marketplace first:

```
/plugin marketplace add denisulmer/skills
/plugin install denisulmer-skills@denisulmer
```

You also need Node 18 or later, git 2.38 or later, and to be signed in wherever your code lives. Run
`/plugin marketplace update denisulmer` to get new versions; the
[releases](https://github.com/denisulmer/skills/releases) say what changed. If you installed an older
version as `denisulmer@denisulmer` (2.x) or `ado-pr@denisulmer` (1.x), uninstall it first.

## Use

```
/denisulmer-skills:spec-feature SHOP-228
/denisulmer-skills:babysit-pr 123
```

Those two are the usual starting points. The others work the same way:

```
/denisulmer-skills:build-feature SHOP-228
/denisulmer-skills:merge-pr 123
/denisulmer-skills:score-pr https://github.com/<owner>/<repo>/pull/123
/denisulmer-skills:setup-repo
/denisulmer-skills:measure-prs
```

You don't need to set anything up first. In a repository the skills haven't seen before, they work out
sensible defaults from its files and tell you what they assumed. Running `setup-repo` later makes those
defaults sharper.

`spec-feature` and `babysit-pr` run for a while and wait for you at decisions, the spec approval and the
merge, so give each one a session of its own. That session mostly coordinates, so Claude Code's default
model is enough. The heavier work runs on models picked for how risky the change is; the
[guide](docs/GUIDE.md#6-what-is-used-and-why) lists which model runs what.

## Develop

```powershell
./install.ps1
```

This links each skill into `~/.claude/skills/`, so your edits are live in the next Claude Code session.
The skills then have no `denisulmer-skills:` prefix. Rerun it after adding a skill. Use either this or the
plugin, not both, or every skill shows up twice.

```
node --test tests/*.test.mjs
```

runs the tests.

Every change under `skills/` is a release. Raise `version` in
[.claude-plugin/marketplace.json](.claude-plugin/marketplace.json), add a section to
[CHANGELOG.md](CHANGELOG.md) and push. The [release workflow](.github/workflows/release.yml) runs the
tests, tags the version and publishes the release. [CLAUDE.md](CLAUDE.md) lists the principles every
change is checked against.

## License

[MIT](LICENSE)
