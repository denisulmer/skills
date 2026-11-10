# Report

When the rounds are done, two things are written. The PR description becomes the cover page: what changed,
why, how dangerous it is, and the few calls a person may want to look at. Everything else goes to the log
as one reply. The description stays under 4,000 characters on every host (Azure DevOps keeps no more, and
nobody reads more elsewhere), so it says little and links.

## Before rewriting

- **Keep the original.** The first time, copy the current description verbatim into the report reply
  under "Original description". When a report already exists (a rerun), take the original from it, never
  from the current description, which is already the rewrite.
- **Keep the substance.** Carry forward what the author wrote that a reader needs: the why, the evidence,
  links to work items. Fixes from the rounds update it.
- **Collect the 👀 list** from `babysit.mjs state` and the round summaries on the log: every declined
  finding (it has a thread: link it), every major or blocker finding a skeptic disproved (🟠 or 🔴 in a
  round summary's Disproved list), every refuted comment from a person, every fix in a danger-map area the
  PR did not touch before, and a tier raised mid-way. One line each, with a link. When it is empty, say
  "Nothing to glance at." Do not pad it: every line here costs the reader attention.
- **Critical tier only:** run the profile's smoke check, and write a rollback plan: the exact revert,
  what has to be redeployed, and what data has to be repaired, in that order.

## The report reply (first, so the description can link to the log)

`<pr-host> reply <pr> <log thread id> --key pr-babysit:report --body-file <scratch>/report.md`, where the
log thread id is `log.id` from `babysit.mjs state`. Its presence is what tells a later session that the
review reached the merge gate.

```markdown
🤖 **Review finished · risk <score>/100 · <tier> · <n> rounds**

### Checks

- `<command>` → passed

### Rollback plan            <!-- critical tier only -->

### Original description

<verbatim>
```

When it is over the comment limit, put the original description into a second reply on the log.

## Description (≤ 4,000 characters)

```markdown
## Summary

<the smallest view that makes the change clear: a diff sketch, call tree, file tree or pseudocode>

<two or three sentences of why, in the repository's domain language>

## Evidence

- **Before:** <failing test, wrong output>
- **After:** <passing test, right output>

## Merge Danger

**Door:** <two-way | one-way>, <one line on why>

**Blast Radius:** <one word>, <one line on what could break>

**Rollback:** <critical tier only: one line; the plan is in the log>

## Review

🤖 **Risk <score>/100 · <tier>** · <n> rounds, <the last one clean | ended with <what is open>> · ✅ <n> fixed · 🧭 <n> decided · ↩️ <n> declined

👀 **Worth a glance**, the rest needs no reading:

- [R2-F4](<thread url>) declined as by design: <one line>
- [<name>'s comment](<thread url>) refuted: <one line>

[Review log](<log thread url>)

<!-- pr-babysit report -->
```

- **Summary view:** pseudocode for logic, a call tree for control flow, a file tree for layout, a `diff`
  block when the point is what changed. No Mermaid; Azure DevOps descriptions are not known to render it.
- **Language:** the domain words from the repo's `CONTEXT.md`, and the rules in style.md.
- **No rounds table and no finding list:** they are on the log. The description names only what a person
  should look at.
- **Length:** write it to `<scratch>/description.md`, check the length with
  `node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8').length)" <file>`, and cut the
  Summary detail first, then Evidence, until it fits. Never cut the 👀 list. Then `set-description`.
