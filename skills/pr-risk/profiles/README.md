# Repository profiles

A profile teaches the risk scorer, the review rounds and the merge step what is special about one
repository. `signals.mjs` picks the profile whose `remotes` entry is a substring of `git remote get-url origin`
(user names in the URL are stripped first).

Keep your profiles in `~/.claude/pr-risk/profiles/` (or `$CLAUDE_CONFIG_DIR/pr-risk/profiles/`): they are
read before this folder, survive plugin updates, and a profile of a private repository stays private.

~~~markdown
---
name: <org>-<project>-<repo>
remotes:
  - dev.azure.com/<org>/<project>/_git/<repo>
---

# <Repo name>

One paragraph: what runs here and where its written standards live.

## Danger map

```json rules
[
  { "id": "auth-boundaries", "match": ["src/Auth/**"], "floor": 60, "reason": "..." },
  { "id": "docs", "regex": "^docs/", "cap": 10, "reason": "..." },
  { "id": "not-live", "match": ["src/Printing/**"], "adjust": -10, "reason": "..." }
]
```

## Judgment notes      — this repo's one-way doors, costly two-way doors, fitting blast-radius words
## Checks              — table of purpose → command (fast, per area, everything, live smoke)
## Conventions a fix must keep
## Merge               — merge strategy and whether to delete the source branch
~~~

## Rule fields

| Field | Meaning |
|---|---|
| `id` | Name. Reusing a default's id (`docs-only`, `tests-only`, `dependencies`, `ci`, `infra`, `migration`, `auth`) replaces that default. |
| `match` / `exclude` | Globs on repo-relative paths: `**` spans directories, `*` and `?` stay in one segment, `{a,b}` alternates. |
| `regex` / `regexFlags` | Alternative to `match`; flags default to `i`. |
| `floor` | Minimum score when **any** non-test file matches (`includeTests: true` counts tests too). |
| `cap` | Maximum score when **every** changed file matches. |
| `adjust` | Points added when **every** changed file matches (negative for discounts). |
| `reason` | Shown in the triage; write it so a reviewer understands the rule without opening this file. |

To draft a profile for a new repository: read its agent guides and ADRs, list where authentication,
migrations, public contracts, shared libraries, deployment manifests and release tooling live, run
`signals.mjs` over its last twenty merges, and tune until the bounds look right to the user.
