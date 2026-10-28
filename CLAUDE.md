# CLAUDE.md

Claude Code skills, published as the `denisulmer-skills` plugin from `.claude-plugin/marketplace.json`.

## Every change to `skills/` is a release

1. Raise `version` of the `denisulmer-skills` plugin in `.claude-plugin/marketplace.json` (semver: a renamed
   skill, command or profile location is major; a new skill or command is minor; a fix is patch).
2. Add `## <version>` at the top of `CHANGELOG.md`: one sentence on what changed for someone using the
   skills, then bullets. Say what a user has to do (rename, move a file, uninstall something).
3. Push to `main`. `.github/workflows/release.yml` tags `v<version>` and publishes the GitHub release with
   that section as its notes. It fails when `skills/` changed without a new version.

Installed plugins update by version, so a change without a new version never reaches anyone.

## Checks before committing

- `claude plugin validate .` passes.
- `node --check` every changed `.mjs`.
- Nothing from a private repository: profiles, PR links or internal names belong in `~/.claude/pr-profiles/`
  or a private repo, never here (this repository is public).
