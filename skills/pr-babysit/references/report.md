# Report

Two pieces. The PR description is rewritten in the /pr shape, so a reader gets the change, its danger and
what deserves a look at a glance. The report thread (template in [style.md](style.md)) holds everything
else. Azure DevOps keeps at most 4,000 characters of description, so the description summarizes and links.

## Before rewriting

- **Keep the original.** The first time, copy the current description verbatim into the report thread
  under "Original description". When a report thread already exists (a rerun), take the original from
  it, never from the current description, which is already the rewrite.
- **Keep the substance.** Carry forward what the author wrote that a reader needs: the why, the evidence,
  links to work items. Fixes from the rounds update it.
- **Collect the 👀 list.** Every declined finding, every refuted comment from a person, every fix in a
  danger-map area the PR did not touch before, and a tier raised mid-way: one line each, with a link.
  When it is empty, say "Nothing to glance at." Do not pad it.
- **Critical tier only:** run the profile's smoke check, and write a rollback plan: the exact revert,
  what has to be redeployed, and what data has to be repaired, in that order.

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

**Rollback:** <critical tier only: one line; the plan is in the report>

## Review

🤖 **Risk <score>/100 · <tier>** · <n> rounds · ✅ <n> fixed · 🧭 <n> decided · ↩️ <n> declined · <last rounds clean>

👀 **Worth a glance**

- [R2-F4](<thread url>) declined as by design: <one line>
- [<name>'s comment](<thread url>) refuted: <one line>

| Round | Found | Outcome |
|---|---|---|
| [1](<summary url>) | 🟠 3 · 🟡 2 | ✅ 4 · ↩️ 1 |
| [2](<summary url>) | none | ✅ clean |

[Full review report](<report thread url>)

<!-- pr-babysit report -->
```

- **Summary view:** as the /pr skill describes: pseudocode for logic, a call tree for control flow, a file
  tree for layout, a `diff` block when the point is what changed. No Mermaid; Azure DevOps descriptions
  are not known to render it.
- **Language:** the domain words from the repo's `CONTEXT.md`, and the rules in style.md.
- **Length:** write it to `<scratch>/description.md`, check the length with
  `node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8').length)" <file>`, and cut the
  Summary detail first, then Evidence, until it fits. Never cut the 👀 list. Then `set-description`.

## Report thread

Post it with the Report template from style.md (`--key pr-babysit:report`, status `closed`) before
rewriting the description, so the description can link to it. When it is over the comment limit, split
the rounds into replies on the same thread.
