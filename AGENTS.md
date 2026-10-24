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

## Documentation (keep it true)

A document that says something the code no longer does is worse than none. When a change makes a
statement in the docs false, deprecated or incomplete, fix the docs **in the same task**.

- **What counts.** `README.md` and `factory/README.md` (configuration tables, defaults, the file layout,
  troubleshooting rows, the "deliberately not used" list), `QUICK-START.md`, `factory/.env.example`, and the
  header comments of the files you touched. Search for the names you changed or removed
  (`grep -rn "<name>" --include=*.md --include=.env.example .`) before you finish.
- **Same commit or a `docs` commit right after it.** A new setting is documented where its siblings are
  (README configuration table and `.env.example`); a removed or renamed one is removed or renamed there too.
  A behaviour that was true and is now deprecated is rewritten, not left with a "(deprecated)" note, unless
  people still run the old way.
- **Historical records stay as written.** The dated `FIXES_*.md` summaries describe what was true then; do
  not rewrite them. Put the current truth in the README.
- **Say so in the report.** List the docs you updated, or say that nothing the change touched was documented.

## Work log

`WORK-LOG.md` is where the owner reads, the next morning, what was built while they were away. When you
finish a feature (not a typo fix), add an entry at the top, below the table, and a row to the table:

- what was asked and the short version of what now works;
- what was wrong or missing before, if anything;
- what changed (files, settings, new behaviour), how it was verified (tests, real runs, screenshots), and
  what could not be verified;
- the decisions you took without asking, and anything left to do or to check;
- the commits, and the branch they are on (merged or not).

Write it for someone who was not watching. Older entries are records: correct a mistake in them, do not
rewrite them.
