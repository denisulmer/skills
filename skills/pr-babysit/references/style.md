# Writing for the reviewer

Everything pr-babysit, pr-merge and pr-risk write has one reader who matters: the user, deciding what
deserves their attention. Write so they can stop reading as early as possible, and so the few things that
need them cannot be missed.

## Contents

1. Rules
2. Azure DevOps comments: triage, finding, replies, people's comments, round summary, report thread
3. Chat: triage line, decisions, round limit, merge question, merge progress
4. Push notifications

## 1. Rules

1. **The first line is the outcome or the ask.** "2 decisions need you", "Fixed in `1a2b3c4`",
   "Risk 52/100 · medium review". Detail follows for whoever wants it.
2. **Three attention levels, always visibly different.**
   - ❓ **Needs you**: a decision, an approval, a stuck merge. Only these reach chat and push notifications.
   - 👀 **Worth a glance**: judgement calls a person may disagree with: a declined finding, a refuted
     comment from a colleague, a fix in a risky area, a tier raised mid-way. One line each with a link,
     in the report and in the merge question.
   - Everything else is audit trail: posted, resolved, never pushed at the user.
3. **The same icons everywhere.** Severity: 🔴 blocker · 🟠 major · 🟡 minor · ⚪ nit. Outcome:
   ✅ fixed · ↩️ declined · 🧭 decided by <name> · ❓ needs <name> · ⚠️ unproven.
4. **Short lines, no walls.** One fact per bullet, at most three sentences per paragraph, a table when
   three or more items share the same fields.
5. **Never rely on a single newline.** Azure DevOps may join consecutive lines into one paragraph.
   Separate lines with a blank line, or make them list items.
6. **Evidence goes in a code block**, trimmed to the lines that make the point (ten at most, `…` for
   cuts), with the command named above it.
7. **Link instead of repeating.** A summary names a finding in a few words and links to its thread.
   Threads: `<thread url>`. Commits: `<repoWebUrl>/commit/<full sha>`, shown as the short sha in backticks.
8. **Machinery last, in italics.** Who found it, which model, skeptic votes, round: readers skip it,
   auditors find it.
9. **The repository's words, not the machinery's.** Domain nouns from `CONTEXT.md`. Say "reviewer",
   "check", "round". Never mention agents, lenses, prompts, schemas, workflows or tokens.
10. **Every Azure DevOps comment starts with 🤖**, so nobody takes it for something the user typed.
    Write in a neutral voice ("Checked: …"), not "I", because the comment carries the user's name.

## 2. Azure DevOps comments

### Triage (`pr-babysit:triage`, status `closed`)

~~~markdown
🤖 **Risk 68/100 · high review**

**68** = blast radius 43 (contract) + door 25 (one-way, recoverable), above the floor of 55

- **Door, one-way:** suppliers' tooling fails the moment the route goes; re-adding it later does not undo those failures.
- **Blast radius, contract:** the legacy self-service API is called by external supplier systems.
- **Floor 55:** the legacy self-service layer must stay 1:1 with the legacy API.
- **Safe because:** no supplier has called `/account-information` in 90 days. ⚠️ Unproven: round 1 checks this first.

**Plan:** 2–4 rounds, done after 2 clean rounds in a row · 7 reviewers · 3 skeptics check every finding
~~~

### Finding (`pr-babysit:R<n>-F<k>`, inline, status `active`)

~~~markdown
🤖 🟠 **Major · R2-F1:** a supplier key without an expiry date gets a 500 on every call

`ApiKeyHandler.cs:42` reads `key.ExpiresAt.Value` before checking `HasValue`. Keys issued before ADR-0012 have no expiry date.

**Evidence:** `dotnet test --filter ApiKeyHandlerTests`

```text
ApiKeyHandlerTests.Key_without_expiry_is_accepted   FAILED
  System.InvalidOperationException: Nullable object must have a value.
```

**Suggested fix:** treat a missing expiry as "never expires" and cover it in `ApiKeyHandlerTests`.

_Found by correctness and adversary reviewers · upheld by 3 of 3 skeptics · round 2, high review_
~~~

### Replies on a finding

Fixed (status `fixed`):

~~~markdown
🤖 ✅ **Fixed** in [`1a2b3c4`](<commit url>)

- **Cause:** the handler assumed every key has an expiry date.
- **Change:** a missing expiry now means "never expires"; new test `Key_without_expiry_is_accepted`.
- **Proof:** `dotnet test --filter ApiKeyHandlerTests` → 14 passed (before: 1 failed)
~~~

Declined (status `closed`, `byDesign` or `wontFix`, see rounds.md):

~~~markdown
🤖 ↩️ **Declined, false positive:** `KeyMiddleware.cs:18` rejects expired keys with 401 before this handler runs, so the 500 path is unreachable.

**Evidence:** `dotnet test --filter Expired` → 3 passed
~~~

Needs the user (status `pending`):

~~~markdown
🤖 ❓ **Needs Denis:** remove the legacy route now, or keep it for one more release?

- **A (recommended):** keep it and send a `Deprecation` header; remove it next release. Safe; one more release of dead code.
- **B:** remove it now. Clean; any supplier still calling it gets a 404 immediately.

The question is waiting in the babysit session.
~~~

Decided (status `fixed`):

~~~markdown
🤖 🧭 **Decided by Denis:** keep the route for one more release (option A).

Done in [`5d6e7f8`](<commit url>): `Deprecation` and `Sunset` headers on every response.
~~~

### People's comments

Confirmed (stays `active` until fixed, then the Fixed reply):

~~~markdown
🤖 **Checked: right.** `SupplierSession.cs:88` never checks `IsDisabled`. Tracked as R2-F4; the fix will be linked here.
~~~

Refuted (status `closed`, or `byDesign` when it describes intended behaviour):

~~~markdown
🤖 **Checked: this doesn't hold.** `SupplierSession.cs:88` only runs after `SessionGuard.cs:31`, which already rejects disabled suppliers.

**Evidence:** `dotnet test --filter Disabled_supplier_is_rejected` → passed

Reopen the thread if there is a path this misses.
~~~

Answered (status `closed`):

~~~markdown
🤖 **Answer:** the `sharp` override is gone because `next` 16.4.3 already requires `^0.35.5`; see `package-lock.json`.
~~~

### Round summary (`pr-babysit:R<n>-summary`, posted when the round closes, status `closed`)

~~~markdown
🤖 **Round 2 of up to 4 · high review:** ✅ 2 fixed · 🧭 1 decided · ↩️ 1 declined

| | Finding | Outcome |
|---|---|---|
| 🟠 | [R2-F1](<thread url>) key without expiry gets a 500 | ✅ [`1a2b3c4`](<commit url>) |
| 🟠 | [R2-F2](<thread url>) route removal breaks supplier tooling | 🧭 kept one release · [`5d6e7f8`](<commit url>) |
| 🟡 | [R2-F3](<thread url>) no test for a disabled supplier | ✅ [`9a8b7c6`](<commit url>) |
| 🟡 | [R2-F4](<thread url>) log line shows the key prefix | ↩️ by design, ADR-0038 |

**Not clean** (2 major) → round 3 is next; done after 2 clean rounds in a row.

**Disproved before posting:** 3

- `Auth.cs:40` wrong status for an expired key: `KeyMiddleware.cs:18` handles it first
- `ui.tsx:12` missing translation: the key exists in every catalog
- `Program.cs:88` middleware order: covered by `AuthPipelineTests`

**Nits:** 2 fixed in [`aa11bb2`](<commit url>), 1 skipped

_Reviewed `fa6b973` · 7 reviewers (correctness ×3, standards and intent, blast radius, tests, adversary) · opus xhigh · 3 skeptics per finding_
~~~

A clean round is one line plus the machinery line:

~~~markdown
🤖 **Round 3 of up to 4 · high review:** ✅ clean, nothing found

_Reviewed `b2c3d4e` · 7 reviewers · opus xhigh · 2 findings disproved by skeptics_
~~~

### Report thread (`pr-babysit:report`, status `closed`)

~~~markdown
🤖 **Review report · risk 68/100 · high · 3 rounds**

### 👀 Worth a glance

- [R2-F4](<thread url>) declined as by design: ADR-0038 allows the key prefix in logs
- [Jane Doe's comment](<thread url>) refuted: disabled suppliers are rejected earlier by `SessionGuard`
- Review raised from medium to high in round 2: a fix touched the legacy self-service layer

### Rounds

| Round | Found | Outcome |
|---|---|---|
| [1](<summary url>) | 🟠 3 · 🟡 2 | ✅ 4 · ↩️ 1 |
| [2](<summary url>) | 🟠 2 · 🟡 2 | ✅ 2 · 🧭 1 · ↩️ 1 |
| [3](<summary url>) | none | ✅ clean |

### Decisions

- 🧭 Keep the legacy route for one more release ([R2-F2](<thread url>))

### Checks

- `scripts/dev/check-fast.sh` → passed
- `scripts/dev/check-backend.sh` → passed

### Triage

<the triage thread's bullets>

### Original description

<verbatim>
~~~

## 3. Chat

### Triage line

~~~markdown
**PR !27887 · risk 52/100 · medium review:** 2–3 rounds, done after a clean one. Round 1 is running; I'll only interrupt you for decisions.
~~~

### Decisions

One message per round, everything else already fixed and pushed. The user should be able to answer in one line.

~~~markdown
**PR !27887 · round 2 · 2 decisions need you.** Everything else is fixed and pushed.

**1 · Keep the legacy route for one more release?** 🟠 [R2-F2](<thread url>)

Removing `/account-information` breaks any supplier tooling that still calls it, and nothing here shows who does.

- **A (recommended):** keep it with a `Deprecation` header and remove it next release. Safe; one more release of dead code.
- **B:** remove it now. Clean; callers get a 404 immediately.

**2 · Accept a breaking change to the CSV header?** 🟡 [R2-F5](<thread url>)

…

Reply like `1A 2B`, or `ok` for all recommendations.
~~~

### Round limit reached

~~~markdown
**PR !27887 · round limit reached (4 of 4).** 1 finding is still open:

- 🟠 [R4-F1](<thread url>) the retry loop can submit test results twice

Run **another round**, **accept** the PR as it is (the finding stays open on the PR), or **stop** here?
~~~

### Merge question

~~~markdown
**PR !27887 is ready to merge:** risk 52/100 · medium · 2 rounds, the last one clean

✅ 3 fixed · ↩️ 1 declined · 🧭 1 decided by you · nothing open

👀 Worth a glance first:

- [R1-F4](<thread url>) declined as a false positive: the 500 path is unreachable behind `KeyMiddleware`

Merge with a merge commit and delete the branch?
~~~

### Merge progress

Say something only when the state changes in a way the user would care about:

- `Auto-complete is set; waiting for the PR build.`
- `The PR build failed in check-frontends (lint). Fixed in 1a2b3c4; the build is running again.`
- `**PR !27887 merged** as 1a2b3c4. Branch deleted, worktree removed.`

## 4. Push notifications

Only for ❓ items and endings. One line, under 200 characters, the PR first, then what to do.

| When | Message |
|---|---|
| decisions wait | `PR !27887: 2 decisions need you (round 2)` |
| review finished | `PR !27887 ready to merge: risk 52, 3 fixed, 1 worth a glance` |
| round limit hit | `PR !27887: round limit reached, 1 major finding open` |
| merge stuck | `PR !27887 merge stuck: check-frontends failed 3 times` |
| merged | `PR !27887 merged as 1a2b3c4` |
