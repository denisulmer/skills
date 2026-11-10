# User guide

How to take a ticket to merged code with these skills, what each step writes where, and what is used and
why. Nothing here happens behind your back: every run starts by saying what it uses, and this guide is the
long form of that line.

## Contents

1. The idea
2. What you need
3. From a ticket to merged code
4. What is written where
5. What you read, and what you can ignore
6. What is used, and why
7. Defaults, and how to improve them
8. Changing how it behaves
9. Stopping, resuming, undoing
10. Limits worth knowing

## 1. The idea

```
ticket ──► spec-feature ──► build-feature ──► babysit-pr ──► merge-pr
           questions         one commit per    review in       your "merge",
           until nothing     acceptance        rounds, fixes   then it lands
           is open           criterion         with proof
              │                   │                 │               │
              ▼                   ▼                 ▼               ▼
        Specification       sub-tasks closed   one log thread,   one comment
        section + one       as they are built  a thread only     on the ticket
        sub-task per                           where you are
        criterion                              needed
```

Four promises hold at every step:

- **Your attention is the scarce thing.** A person who has to read everything ends up approving
  everything. So the skills ask you questions, show you decisions and show you the few calls you may
  disagree with. Everything else is kept where you can find it and never have to read it.
- **No magic.** Each skill starts with one line that names what it works from: the ticket and how it is
  reached, the repository profile and whether it was only drafted, the review tier with its model and
  effort. Section 6 explains each of those.
- **Defaults first, better later.** Nothing has to be set up before the first run. Where a default is
  weaker than it could be, the skill says so once and names the one thing that improves it (section 7).
- **Yours stays yours.** Nothing is merged, no ticket is moved and no one-way decision is taken without
  your yes in the chat. An approval or a comment on the host is not a yes.

You can enter anywhere. `babysit-pr` on an existing pull request, `score-pr` to ask how risky a change is
and `merge-pr` to land one work on their own.

## 2. What you need

- Claude Code, Node 18 or newer, git 2.38 or newer.
- A sign-in for where the code lives:

  | Code host | Sign in |
  |---|---|
  | Azure DevOps | `az login` (or `AZURE_DEVOPS_EXT_PAT`) |
  | GitHub | `gh auth login` (or `GH_TOKEN`) |
  | GitLab | `glab auth login` (or `GITLAB_TOKEN`) |
  | plain git, any other remote, or none | nothing: reviews live in the repository's git directory |

- For tickets, one of these. Without either, the pipeline still works and keeps the spec in the repository.

  | Jira access | Setup | What it can do |
  |---|---|---|
  | the Atlassian connector | connect it once in Claude | everything, and it writes the Specification into a description that is plain text. A description with an image, a mention or a smart link is left alone, and the Specification goes into a sub-task instead. |
  | an API token | set `JIRA_EMAIL` and `JIRA_API_TOKEN` ([create a token](https://id.atlassian.com/manage-profile/security/api-tokens)) | the same, and it writes the Specification into any description, exactly, because it sends Jira's own document back instead of Markdown. Sub-tasks, statuses and comments still go through the connector. |

Other trackers (GitHub or GitLab issues, Azure Boards) work through their own tools in the session; Jira
with Azure DevOps is the pair this is built and used with.

Nothing else. The first run in a repository drafts its profile by itself (section 7).

## 3. From a ticket to merged code

**1. Spec.** `/spec-feature SHOP-228`

It reads the ticket, the code and the repository's guides, then asks you one question at a time, with
options and a recommendation, until nothing is open. It never asks what the ticket or the code answers.
One-way doors (stored data, schema, public contracts, keys) are always asked. Then it drafts the spec:
numbered acceptance criteria that each say how they are verified, non-goals, your decisions, a plan, and a
risk forecast. From the medium tier up, a second reader checks the spec for gaps first.

You see the spec in the chat and approve it or change it. On your approval:

- the ticket's description gets a **Specification** section below what the stakeholder wrote;
- the ticket gets one sub-task per acceptance criterion, named `AC1: …`;
- a feature branch and a worktree beside your checkout exist: `feature/SHOP-228-<slug>`.

**2. Build.** Runs by itself after the approval (or `/build-feature SHOP-228`).

One builder works through the criteria in order: a failing test that carries the criterion's id, the
change that makes it pass, the checks, one commit (`Refs: SHOP-228 AC3`). The skill then checks the
builder's work itself: every criterion has its commit and its test, and the checks pass on the head. Each
sub-task is closed with one line naming the commit and the test. If a criterion cannot be built as
written, you get the problem, the options and a recommendation in one message; an approved amendment goes
into the ticket. Then it opens a draft pull request and the ticket's Specification names it.

**3. Review.** Runs by itself after the build (or `/babysit-pr 123` on any pull request).

It scores the change's risk, 0 to 100, which sets the review tier. Round 1 reviews the whole change with
that tier's reviewers; reports of the same defect are merged into one; a skeptic tries to disprove each
finding before it counts. A fixer then fixes what it can prove fixed (a test that failed and now passes),
declines what is wrong with the evidence, and hands you what is yours to decide. If round 1 kept a serious
finding, a follow-up round checks only the fixes. Section 5 says what of this reaches you.

**4. Merge.** You get one message: the verdict, the calls worth a glance, what the review cost, and
"merge?". On your yes, `merge-pr` sets auto-merge with the repository's strategy, watches the build, fixes
a failed build or a conflict, answers late comments, confirms the merge, cleans up the branch and the
worktree, and leaves the ticket one comment. It tells you the ticket's status; moving the ticket is yours.

## 4. What is written where

| Place | What | Never |
|---|---|---|
| **Ticket** | the Specification section at the end of the description; one sub-task per acceptance criterion; one line on each sub-task when it is closed; one comment when the work is merged | a word above the Specification heading; the ticket's own status; assignees; other fields |
| **Pull request** | the description, rewritten at the end as a cover page (summary, evidence, merge danger, the calls worth a glance); one closed thread, the review's log; one thread at the code line for each decision and each declined finding; replies on other people's comments | a thread for something that was simply fixed; votes or approvals; force-pushes |
| **Repository** | commits: one per acceptance criterion, one per fixed finding, each with a `Refs:` trailer; with a ticket, no spec file. Without a ticket, `docs/specs/<date>-<slug>.md` | rewritten history |
| **Your machine** | `~/.claude/pr-profiles/` (repository profiles), `~/.claude/pr-metrics/` (what reviews cost and found), worktrees beside your checkout (`<repo>-<slug>`, `<repo>-pr-<id>`, removed after the merge) | anything in a checkout with uncommitted changes |

Every comment on a pull request starts with 🤖, because it is posted under your name.

## 5. What you read, and what you can ignore

| You read | Where | When |
|---|---|---|
| ❓ a decision | one chat message per round, answerable like `1A 2B`; each has a thread at the code line | only when the fixer may not decide: a one-way door, behaviour users can see, two findings that pull apart |
| 👀 a call you may disagree with | the merge question and the PR description, one line each with a link | at the merge |
| the cover page | the PR description | once |

A 👀 item is a declined finding, a serious finding a skeptic disproved, a refuted comment from a
colleague, a fix in a risky area, or a tier raised mid-way.

**You can ignore the log.** It is one closed thread on the pull request with the risk triage, every
round's findings and what became of each, the checks and the original description. It exists for audits
and so that any later session can pick up where this one stopped. A finding that was fixed with proof is
one row there and one commit; it gets no thread, no chat line and no notification.

In chat, between the start line and the merge question you get at most one line per round, plus decisions.

## 6. What is used, and why

**The start line** of every review names these:

`PR !27887 · risk 52/100 · medium review. Using: profile contoso-shop (drafted automatically, not calibrated) · Opus at medium effort, 3 reviewers and a skeptic · up to 3 rounds.`

**The risk score** is blast radius (0 to 60: who notices when it is wrong) plus door (0 to 40: what it
costs to walk back), held between a floor and a cap that the repository profile sets for the files the
change touches. You can always ask for the two sentences behind a score.

**The tier** follows from the score and sets everything about the review
([tiers.json](../skills/babysit-pr/references/tiers.json)):

| Tier | Score | Round 1 reviewers | Model, effort | Skeptic | Rounds |
|---|---|---|---|---|---|
| trivial | 0–15 | one generalist | Sonnet, medium | no | 1 |
| low | 16–35 | correctness; standards and intent | Sonnet, high | yes | up to 2 |
| medium | 36–60 | correctness; standards and intent; blast radius | Opus, medium | yes | up to 3 |
| high | 61–80 | correctness per part of the change; standards and intent; blast radius; an adversary that must run something to count | Opus, high | yes | up to 3 |
| critical | 81–100 | as high, plus a second adversary on Fable | Opus, high | yes, and a second one for a blocker | up to 4 |

Changes that touch migrations or authentication add a reviewer for that from medium up.

Why these models: the tiers are one ladder that follows
[Anthropic's model guidance](https://claude.dev/blog/which-claude-model-should-you-build-with/). Effort is
raised before the model, nothing runs above `high` (one more level costs about as much as the next model
and gains little), and the next model up starts at a lower effort. Small jobs run on small models:
splitting a change into parts on Haiku, checking minor findings on Sonnet.

**Who runs on what:**

| Role | What it does | Runs on |
|---|---|---|
| your session | conducts: runs the scripts, asks you, pushes | whatever you chose; Claude Code's default is enough |
| scorer | reads the diff once, answers the risk questions | Opus, medium, in its own context |
| reviewers and skeptics | find defects; try to disprove each | the tier's model and effort |
| fixer | fixes with proof, declines with evidence, escalates | the tier's model and effort |
| builder, spec reader | build the spec; look for gaps in it | the forecast tier's model and effort |

**Scripts** do every step that needs no judgment, so it comes out the same each time: the score's
arithmetic, which checks a change must pass, what is posted on the pull request, the Specification section
of a ticket. Each prints what it did; each can be run by hand (its header lists the commands).

**The repository profile** tells the scorer what is dangerous where (a danger map of path rules with
floors and caps), names the checks a fix must pass, the conventions a fix must keep and how the repository
merges. [Its format](../skills/setup-repo/references/profile-format.md).

**Cost** is shown where you already look: the merge question says what the review cost at API list
prices. `/measure-prs` breaks it down per tier, round and reviewer, shows where one round's money went
agent by agent, and proposes changes to the tiers once there is enough data behind them.

## 7. Defaults, and how to improve them

| Without setup | What you get | To improve it |
|---|---|---|
| a repository nobody set up | a profile drafted from its files: the checks its build files name, the merge strategy its history shows, the default danger map (docs, tests, dependencies, CI, infrastructure, migrations, authentication). It is marked as not calibrated, and the skills say so. | `/setup-repo`: adds what is dangerous here and calibrates it against your last 20 merges |
| Jira through the connector | the Specification in the description when the stakeholder's text is plain; otherwise in a sub-task named `Specification` | set `JIRA_EMAIL` and `JIRA_API_TOKEN`: any description, exactly |
| no tracker tools in the session | the spec as a file in `docs/specs/`, committed with the code | connect the Atlassian connector |
| a profile without a checks block | agents read the profile's prose and the repository's guides to find the checks | add a ```` ```json checks ```` block (`/setup-repo` offers it) |
| the tiers as shipped | section 6 | `/measure-prs` after a few reviews: it proposes changes backed by your own numbers |

## 8. Changing how it behaves

- **How hard a change is reviewed:** the repository profile's danger map (a floor raises the tier for
  risky paths, a cap lowers it for harmless ones). Yours is in `~/.claude/pr-profiles/`; a team's is
  `.claude/pr-profile.md`, read from the target branch so a pull request cannot loosen its own rules.
- **What a tier does:** `skills/babysit-pr/references/tiers.json`: reviewers, model, effort, whether a
  skeptic checks findings, the severity that makes round 1 unclean, the most rounds. Its first entry
  explains every field.
- **Which checks run:** the profile's checks block: `fast` checks per area for what a change touches,
  one `full` check for the pipeline.
- **What happens on tickets:** the profile's Tickets section, where it differs from the defaults.

## 9. Stopping, resuming, undoing

- **The pull request is the state.** Stop any time; start the same skill on the same pull request in any
  session and it reads the log and carries on. The same holds for a ticket: the spec is read back from it.
- **A rehearsal:** ask `babysit-pr` for a dry run. It reviews for real, posts nothing and pushes nothing,
  and shows you what it would have posted.
- **Undo a fix:** every fixed finding is one commit with its finding's id; revert it.
- **Undo a ticket edit:** Jira keeps the description's history. Sub-tasks the skills created start with
  `AC<n>:`.
- **Worktrees** are removed after the merge; `git worktree list` shows any that are left.

## 10. Limits worth knowing

- **Usage limits.** A full high or critical round is about a dozen agents. When a 5-hour limit stops a
  round, it resumes by itself after the reset and nothing is lost; a weekly limit asks you.
- **Someone else's pull request** is reviewed only: findings are posted as threads for the author, and
  nothing is fixed, pushed or resolved for them.
- **The connector rewrites a Jira description as Markdown.** That is why the skill only does it for plain
  text and otherwise uses a sub-task (section 2).
- **Cost figures are estimates** from the session's transcripts at API list prices: good for comparing
  runs, not a bill.
- **What a review cannot see:** a bug nobody has fixed yet does not show up as an escape in `/measure-prs`.
