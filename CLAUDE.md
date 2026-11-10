# CLAUDE.md

Claude Code skills, published as the `denisulmer-skills` plugin from `.claude-plugin/marketplace.json`.
They take a ticket to merged code: `spec-feature` → `build-feature` → `babysit-pr` → `merge-pr`, with
`sync-ticket`, `pr-host`, `score-pr`, `setup-repo` and `measure-prs` beside them. `docs/GUIDE.md` is the
user's guide; keep it true when behaviour changes.

## What every change is measured against

1. **The user's attention is the scarce thing.** A person who has to read everything ends up approving
   everything. Post, say and ask as little as possible: only a decision or a call the user may disagree
   with reaches them. Before adding a comment, a thread, a chat line or a question, ask what it replaces.
2. **No magic.** A skill says at the start what it uses and why (profile, tier, model and effort, ticket
   and how it is reached). Anything a skill decides by itself is written down in `docs/GUIDE.md`.
3. **Defaults first, better later.** Nothing needs setup before the first run. A missing piece gets a
   best-effort default, and the user is told once what was assumed and the one thing that improves it.
4. **Scripts for what needs no judgment.** A step that must come out the same every time is a script with
   a test, not an instruction.
5. **Simple over complete.** Jira with Azure DevOps is the pair in daily use; another tracker or host is
   welcome when it costs no extra path through the skills.

## Every change to `skills/` is a release

1. Raise `version` of the `denisulmer-skills` plugin in `.claude-plugin/marketplace.json` (semver: a renamed
   skill, command or profile location is major; a new skill or command is minor; a fix is patch).
2. Add `## <version>` at the top of `CHANGELOG.md`: one sentence on what changed for someone using the
   skills, then bullets. Say what a user has to do (rename, move a file, uninstall something).
3. Push to `main`. `.github/workflows/release.yml` runs the tests, tags `v<version>` and publishes the
   GitHub release with that section as its notes. It fails when `skills/` changed without a new version.

Installed plugins update by version, so a change without a new version never reaches anyone.

## Checks before committing

- `node --test tests/*.test.mjs` passes (a few minutes on Windows). A changed script gets a test for what
  changed; `tests/helpers.mjs` gives each test a throwaway repository.
- `claude plugin validate .` passes.
- `node --check` every changed `.mjs`.
- Nothing from a private repository: profiles, PR links, ticket keys or internal names belong in
  `~/.claude/pr-profiles/` or a private repo, never here (this repository is public). Examples use
  made-up names (`SHOP-228`, `contoso-shop`).
