---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0002. Cheap deterministic filters first; escalate to Claude only when a signal fires

- **Issue**: initial publication (v0.1.0)

**Decision**: every run computes technical signals and rules in code, with no LLM. Only a signal that survives them (a confirmed entry setup, or a risk trigger on an open position) is escalated to Claude, so a run without signals costs no tokens.

## Context and problem statement

The engine watches a portfolio and a watchlist several times a day. Asking a language model about every security on every run would cost tokens on runs where nothing happens. It would also let the model redo arithmetic the code can do exactly.

**Why it matters**: the main running cost is the reasoner, and it scales with the number of escalations, not with run frequency (estimated: market data and GitHub Actions minutes are free at this volume). Fewer escalations also means fewer emails to read.

## Decision drivers

- Cost proportional to what can be acted on.
- Arithmetic involving money must not depend on a model repeating it correctly.
- Every escalation should end in a decision that can be measured.

## Considered options

- Ask the model about every security on every run.
- Deterministic filters, with escalation only on a signal.
- No model at all: rules only.

## Decision outcome

Chosen option: "deterministic filters, escalate only on a signal". The model is used where it adds something code can't: reading the news and the thesis around a signal.

**What we give up**: the model never sees what the filters discard. A good opportunity that a rule blocks is not reconsidered. It is recorded as blocked instead ([ADR-0006](0006-single-append-only-decision-log.md)), so the cost of each rule can be measured.

**Scope**: the heartbeat, the weekly screening and the Monday briefing.

**Confidence**: high.

### Consequences

- Good: a quiet day costs nothing in tokens. A re-analysis cooldown stops repeated escalations at the same price.
- Good: stop, size and risk:reward are computed by the engine ([ADR-0009](0009-swing-framework-risk-sizing-and-measurement.md)). The model proposes only the target and the reasoning.
- Bad: the quality of the system depends on the filters. That is why they are measured ([ADR-0014](0014-decision-quality-slo.md)).

### Confirmation

`src/heartbeat.ts` builds signals with no LLM call. `src/tests/heartbeat-run.test.ts` checks that only escalated signals reach the analyst. The operational SLO bounds the number of Claude calls per run.

**Success measure**: Claude calls per heartbeat run, bounded by the operational SLO in the README.

## More information

Retroactive record of the engine's founding design (June 2026).
