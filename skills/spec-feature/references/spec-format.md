# Spec format

One file per feature: `docs/specs/<YYYY-MM-DD>-<slug>.md` (or the place the profile's Conventions name),
committed as the first commit of the feature branch and merged with the code. It stays as history: what
was asked for and decided, next to the code that does it. build-feature builds from it, the reviewers judge
against it, and `build-feature/scripts/acmap.mjs` checks its acceptance criteria mechanically, so keep the
shapes below exact.

~~~markdown
---
title: Supplier keys expire after 90 days
slug: supplier-key-expiry
status: draft                # draft → approved
created: 2026-11-02
approved:                    # 2026-11-02 by <name>, set when the user approves
branch: feature/supplier-key-expiry
pr:                          # set by build-feature when it opens the PR
ref:                         # optional: a ticket key or link, if one exists
risk: medium 50              # the forecast: tier and score
---

# Supplier keys expire after 90 days

## Why

Two to four sentences: the problem, who has it, what changes for them. In the repository's domain words.

## Acceptance criteria

- **AC1:** Given a key issued 91 days ago, when a supplier calls any API, then the call is refused with 401 and `key_expired`. · *verified by* test
- **AC2:** Given a key without an expiry date (issued before this change), when it is used, then it keeps working until it is rotated. · *verified by* test
- **AC3:** The key list in the portal shows each key's expiry date. · *verified by* manual: open the portal as a supplier and compare with the database

## Non-goals

- Rotating keys automatically.

## Decisions

- **Existing keys without an expiry date?** Keep working until rotated (not: expire all now). Why: suppliers' integrations would break overnight. 🚪 one-way: decided by <name> on 2026-11-02.

## Plan

- `src/Auth/ApiKeyHandler.cs`: check the expiry.
- `src/Auth/Migrations/…`: nullable `ExpiresAt` column. 🚪
- `web/portal/keys/`: show the date.

## Risk forecast

**50/100 · medium** = blast radius 39 (cross-module) + door 9 (two-way, costly) = 48, raised to the floor of 50 (authentication). Safe because existing keys get no expiry date. ⚠️ Unproven until AC2's test passes.

## Open questions

None.

## Amendments

- 2026-11-03, approved by <name>: AC2 also covers keys rotated before the change (found while building AC2).
~~~

## Rules

- **Acceptance criteria:** numbered `AC1`, `AC2`… in order, never renumbered once approved (an amendment
  adds `AC4` or strikes one through with `~~` and says why). Each is one observable statement, Given/When/Then
  where it fits, and ends with `· *verified by*` and one of: `test` (build-feature writes a test whose name
  carries the id), `manual: <what a person does>`, or `adr: <which record>`. A criterion nobody can verify
  is not one: rewrite it or move it to Non-goals.
- **Decisions:** every question the user answered, with the choice, what was not chosen, and why. A
  one-way door (stored data, schema, public contract, keys) gets 🚪 and the user's name: it is never
  decided by default.
- **Plan:** the files or modules expected to change. score-pr's forecast reads it (`signals.mjs
  --planned`), and the build follows it loosely: a plan is a guess, the ACs are the contract.
- **Open questions** must say `None.` before the spec can be approved.
- **Status:** `draft` while it is being written; `approved` with date and name once the user says so in
  chat (the only way it becomes approved). build-feature fills in `pr:` when it opens the PR, before the
  review. Nothing is written at the merge: a spec on the default branch has shipped, with the PR its `pr:`
  names (and git says when).
- **Amendments:** a change after approval needs the user's yes again and a dated line here; the ACs and
  decisions above are edited to match.
