---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0006. A single append-only decision log in JSON Lines, including decisions not to act

- **Issue**: initial publication (v0.1.0)

**Decision**: every decision goes as one JSON line to `logs/decisions.jsonl`, append-only and always written by the engine. That includes the system's proposals and blocks, its decisions not to act (`hold`, rejections) and the user's own trades and cash flows. Each line carries the price and benchmark snapshot, the plan (initial stop, target, horizon, assumptions) and the rules version, so every decision can be evaluated later.

## Context and problem statement

Without one place for decisions, there is no way to tell whether the system beats doing nothing. Before this decision, decisions were spread over Markdown logs and prose. Blocks and holds were lost, and the user's own trades were not recorded against the system's.

**Why it matters**: the SLO of this project is decision quality ([ADR-0014](0014-decision-quality-slo.md)), and it can only be measured from this log.

## Decision drivers

- Several writers (scheduled runs, agent sessions, the user) commit concurrently to git.
- The schema evolves by adding optional fields, without rewriting old lines.
- No line without `rules_version`: a decision that can't be tied to a set of rules is useless for change control.

## Considered options

- One JSON Lines file, append-only.
- SQLite.
- One file per decision.
- A Markdown table.

## Decision outcome

Chosen option: "one JSON Lines file, append-only". With `merge=union` in `.gitattributes`, a rebase concatenates lines written in parallel instead of raising a conflict.

**What we give up**: corrections need a dedicated commit that edits one line, made when no automated run is in flight. The live file keeps at least three months. Older quarters can be archived (`DECISIONS_ARCHIVE_DIR`).

**Scope**: every writer. The schema has a single source: `src/decisions.ts`.

**Confidence**: high.

### Consequences

- Good: `decisions:evaluate` measures proposals, blocks, holds and trades without any LLM.
- Good: a user trade is attributed to the system when a system proposal or armed setup precedes it within 10 days. Otherwise it belongs to the owner, and buying something the engine blocked is flagged `overrode_block`.
- Bad: the stored values of `origin` (`sistema`, `propietario`) and of the market regime are in Spanish, inherited from the original deployment. They are part of the stored format, and changing them needs a schema migration.

### Confirmation

`src/tests/decisions.test.ts` validates the schema. `src/tests/decision-record.test.ts` covers attribution of origin.

**Success measure**: every decision type in the README's evaluation has a writer, enforced by the tests above.

## More information

Retroactive record of a decision taken on 2026-09-14. SQLite was rejected because it is binary in git and can't be merged. One file per decision would mean thousands of files. A Markdown table would conflict with every concurrent writer.
