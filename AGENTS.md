# AGENTS.md

Rules for AI assistants that work on this repository **directly** (Claude Code, OpenCode, Cursor, ...).

**Scope.** When the factory itself runs on this repository as its target, its agents follow the
factory's own rules instead: they never commit, push or switch branches, because the Delivery step
does that. The "Commits" section below is not addressed to them.

## Commits (autonomous)

Commit your own work as you go, without waiting to be asked. Every fix, enhancement, refactor, test
or documentation change you make is committed once it is finished and verified.

- **One logical change per commit.** Do not mix unrelated changes, and do not leave finished work
  uncommitted at the end of a task.
- **Verify before committing.** Run `npm run check` (typecheck, unit tests and the graph smoke test)
  or, for a small change, the part of it that covers what you touched. Do not commit code that
  fails. A change to the workflow or the agents always needs `npm run smoke`.
- **Message.** Conventional Commits: `type(scope): subject`. Types: `feat`, `fix`, `refactor`,
  `perf`, `test`, `docs`, `build`, `ci`, `chore`. Scopes: `factory`, `studio`, `ci`, `docs`, `test`,
  or none. The subject is imperative, at most 72 characters, with no final period. Add a body when
  the reason for the change is not obvious.
- **Stage explicit paths** and read `git diff --staged` first. Never `git add -A` blindly.
- **Never commit** secrets or `.env` files, run traces (`logs/`, `factory/logs/`), databases, or
  build output (`dist/`, `dist-electron/`, `.mastra/`).
- **Local only.** Do not push, force-push, rewrite history, skip hooks (`--no-verify`) or change the
  git config unless the user asks.
- **Other people's changes.** If the working tree holds uncommitted changes you did not make, keep
  them out of your commits and tell the user.
- **Report.** At the end of a task, list what you committed (short hash and subject).
