---
name: sync-ticket
description: Keep a Jira (or other tracker) ticket in step with the work - the spec in its own section of the description, one sub-task per acceptance criterion, one comment at the merge, the stakeholder's text untouched. Use when the user says "update the ticket", "put the spec into the ticket" or "create the sub-tasks".
---

# Keep the ticket in step

`<ticket>` = `node <base>/scripts/ticket.mjs`; its header lists every command. The ticket is where
stakeholders look, so it holds the specification and shows the progress. A repository whose work has a
ticket gets no spec file.

## What goes on a ticket

| What | Where | When |
|---|---|---|
| the specification | its own section at the end of the description, under the heading **Specification** | on approval; again on an amendment, and when the PR exists (its status line names the PR) |
| one sub-task per acceptance criterion, `AC<n>: <statement>` | sub-tasks of the ticket | on approval |
| that sub-task closed, with one line: the commit and the test | the sub-task | when its criterion is built and the checks pass |
| one comment: merged, and what is left to verify by hand | the ticket | after the merge |

Nothing else, because the ticket is **quiet** too: one comment on it, one line per sub-task. Never change
a word above the Specification heading, another field, an assignee, or the status of the ticket itself: say
what its status is and leave moving it to the user.

## Which tracker, and saying so

The ticket comes from the argument (a key like `SHOP-228` or a URL), else from the branch name or the PR
title. Tell the user once per session what you use and how to improve it, in one line:

`Ticket SHOP-228 (Jira, through the Atlassian connector): the specification goes into its description, one sub-task per acceptance criterion.`

- **Jira:** `<ticket> transport` says `api` or `connector`.
  - `api` (`JIRA_EMAIL` and `JIRA_API_TOKEN` are set): the script reads and writes the description itself
    and keeps the stakeholder's text exact, whatever it contains.
  - `connector`: the Atlassian connector's tools (`getJiraIssue`, `editJiraIssue`, `createJiraIssue`,
    `getJiraProjectIssueTypesMetadata`, `getTransitionsForJiraIssue`, `transitionJiraIssue`,
    `addCommentToJiraIssue`; their names carry the server's prefix, and ToolSearch loads them when they
    are deferred). `cloudId` is the site's host name (`<site>.atlassian.net`). The connector hands a
    description over as Markdown, so it can only rewrite descriptions that are plain text (below); add the
    `improve` line from `transport` to what you tell the user.
  - Sub-tasks, statuses and comments go through the connector in both cases.
- **Another tracker** (GitHub or GitLab issues, Azure Boards): the same steps with that tracker's tools; its
  description is Markdown, so `merge`, `check` and `read` work on it as they are.
- **No tracker tools in this session, or no ticket:** say so in one line; the spec lives in
  `docs/specs/` instead (spec-feature's file mode), and nothing here applies.

## Reading a ticket

- `api`: `<ticket> jira-read --ticket <url> --out <scratch>/spec.md` gives the title, the status, the
  sub-tasks and, when the ticket has one, the spec file.
- `connector`: `getJiraIssue` with `fields: ["summary", "description", "status", "issuetype", "subtasks"]` and
  `expand: "renderedFields"`. Save `fields.description` exactly as returned to
  `<scratch>/description.before.md`, then `<ticket> read --description <that file> --ticket <KEY> --title
  "<summary>" --out <scratch>/spec.md`. No section in the description: look for a sub-task named
  `Specification` and read its description the same way.

The stakeholder's text is the request. `<scratch>/spec.md` is the working copy every other skill reads; it
is rebuilt from the ticket in each new session, never committed.

## Writing the Specification section

**`api`:** `<ticket> jira-write --ticket <url> --spec <scratch>/spec.md`. It reads the ticket back and puts
the description back as it was if anything above the section changed; an error says so.

**`connector`,** only when what the stakeholder wrote is plain:

1. Read `renderedFields.description`, the part above the section. It is **plain** when it holds nothing but
   headings, paragraphs, lists, links, code and simple tables; an empty description is plain. It is **not
   plain** when it holds any of: an image or attachment, a mention of a person, a smart link or an issue
   shown as a card (`jira-issue-macro`), a panel, a status label, an emoticon, coloured text, a task list,
   an expand, a date. Markdown cannot carry those, and writing the description back would lose them.
2. Plain: `<ticket> merge --description <scratch>/description.before.md --spec <scratch>/spec.md --out
   <scratch>/description.after.md`, then `editJiraIssue` with `fields: { "description": <that file's text> }`.
   Save the `fields.description` it returns to `<scratch>/description.stored.md` and run `<ticket> check
   --before <scratch>/description.before.md --after <scratch>/description.stored.md`. When it exits 1,
   write `description.before.md` back with `editJiraIssue` and take the fallback.
3. Not plain, or the check failed: **leave the description alone.** Put the section (`<ticket> render
   --spec <scratch>/spec.md`) into a sub-task named `Specification`, created once and updated after that,
   and tell the user: `SHOP-228's description holds <what>, which the connector cannot write back
   unchanged, so the specification is in sub-task <KEY>. With JIRA_EMAIL and JIRA_API_TOKEN set it goes
   into the description itself.`

## Sub-tasks

1. Write the ticket's sub-tasks as `[{ "key", "summary", "status" }]` to `<scratch>/subtasks.json`, then
   `<ticket> subtasks --spec <scratch>/spec.md --existing <scratch>/subtasks.json`.
2. Create each entry of `create` with its `summary` and `description`, as a sub-task of the ticket
   (`createJiraIssue` with `parent`; the sub-task type's name comes from
   `getJiraProjectIssueTypesMetadata`, the type with `subtask: true`). `existing` are there already.
   `dropped` belong to a criterion that was struck out: comment why on each and close it.
3. When a criterion is built and the checks pass, close its sub-task: `getTransitionsForJiraIssue`, the
   transition whose target status is in the Done category, `transitionJiraIssue`. Then one comment on it:
   `Built in <short sha> · test: <file>: <test name>`, or `· verify by hand: <what a person does>` for a
   criterion no test covers.
4. A sub-task a person added, or one that does not start with `AC<n>:`, is not yours: leave it.

## When the work is merged

One comment on the ticket: `Merged: <PR url> (<short sha>).` and either `Still to verify by hand: AC3
<what>` or `Nothing is left to verify by hand.` Then tell the user the ticket's status in one line; moving
it is theirs.
