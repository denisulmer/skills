# Repository profiles

A profile teaches the risk scorer, the review rounds and the merge step what is special about one
repository. `pr-risk/scripts/signals.mjs` finds it, first match wins:

1. **Yours:** `~/.claude/pr-profiles/*.md` (or `$CLAUDE_CONFIG_DIR/pr-profiles/`), when an entry in
   `remotes` is a substring of one of the repo's remote URLs (user names stripped first), or an entry in
   `paths` is the repo's main checkout. Private, survives plugin updates, overrides the team's.
2. **The team's:** `.claude/pr-profile.md` committed in the repository, read from the target branch (the
   `--base` ref), never from the PR's head: a PR cannot loosen the rules it is scored by, and a change to
   the profile only counts once it is merged.

Both work the same from every worktree: remotes and the main checkout are shared by all worktrees of a
repository, and the committed profile is read from git, not from a working tree.
`signals.mjs --which-profile --base <ref> --repo <path>` prints the one that applies.

~~~markdown
---
name: <owner>-<repo>
remotes:                # yours only; leave out of a committed profile
  - github.com/<owner>/<repo>
paths:                  # yours only, for a repository without a remote
  - C:/src/<repo>
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
## Merge               — strategy (merge | squash | rebase | rebase-merge) and whether to delete the source branch
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
