---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0003. State as versioned Markdown in a data directory; localized output

- **Issue**: initial publication (v0.1.0)

**Decision**: the engine keeps no database. It reads and writes Markdown files with YAML frontmatter in a data directory (the _brain_, `VAULT_PROJECT_DIR`). The input format is an English, versioned contract (`schema_version`). What the engine writes for people is localized with `OUTPUT_LANGUAGE=en|es`.

## Context and problem statement

The user maintains the portfolio by hand: the engine integrates with no broker. They read the agent's output in a notes app. The state has to be easy for a person to edit, easy to review in git diffs, and safe for the engine to parse.

**Why it matters**: if a hand-edited file breaks the parser in silence, risk alerts are missed. If state lives in a database, the user can't see or fix it.

## Decision drivers

- A person edits the portfolio. The engine must reject what it can't read, never guess.
- Several writers (scheduled runs, agent sessions, the user) commit to the same repository.
- Output language is a user preference. The parsed format must not change with it.

## Considered options

- Markdown with frontmatter, with a versioned format.
- A database (SQLite or a hosted one).
- JSON or YAML files only.

## Decision outcome

Chosen option: "Markdown with a versioned format". People can read it, git can merge it, and it works in any notes app.

**What we give up**: tables in Markdown are a fragile contract. Columns are located by header, and the engine is strict: a missing section or an unknown value is an error. An incompatible change bumps `schema_version` and ships a migration. Where a format must be machine-first (the decision log), JSON Lines is used instead ([ADR-0006](0006-single-append-only-decision-log.md)).

**Scope**: every file in [`docs/input-format.md`](../input-format.md), and every user's data directory.

**Confidence**: high.

### Consequences

- Good: the whole state is reviewable in a pull request and recoverable with git.
- Good: headings the engine writes and reads back are part of the format and are never translated. Everything else follows `OUTPUT_LANGUAGE`.
- Bad: parsing Markdown tables needs care with line endings, number formats and spacing (`src/utils/vault-parser.ts`).

### Confirmation

`assertSchemaVersion` rejects a missing or unknown version (`src/tests/vault-parser.test.ts`). `src/tests/i18n.test.ts` checks that both catalogs define the same keys.

**Success measure**: the engine never parses a file with an unknown `schema_version`, enforced by the tests above.

## More information

Retroactive record. The format moved to English with `schema_version: 1` on 2026-10-13, and the output was localized the same week.
