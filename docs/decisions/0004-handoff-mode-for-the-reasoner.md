---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0004. Handoff mode: the engine prepares and resolves, an agent session reasons

- **Issue**: initial publication (v0.1.0)

**Decision**: the reasoner has two backends, chosen with `ANALYST_PROVIDER`:

- `api` calls the Anthropic API from the engine.
- `handoff` writes the signal and its prompts to `logs/pending/` and leaves the reasoning to a Claude Code session. That session calls deterministic commands to list, show and resolve each item.

The weekly runs follow the same pattern, split into `prepare`, `resolve`/`finalize` and `summarize` steps.

## Context and problem statement

Reasoning through the API costs tokens on every escalation. A Claude Code session (for example a scheduled routine) can reason with a subscription and native web search. But it can't be called synchronously from a GitHub Actions run, and its sandbox only allows outbound HTTPS.

**Why it matters**: the weekly briefing and screening are the most expensive calls: about 12 candidates per screening and several web searches per briefing (estimated from the original deployment). With handoff they cost no API tokens.

## Decision drivers

- Same prompts, same validation and same decision log, whichever backend runs.
- A run must survive the session dying halfway.
- The engine never trusts the model's output without validating it.

## Considered options

- API only.
- Handoff only.
- Both, selected by configuration, with deterministic prepare/resolve commands around the reasoning.

## Decision outcome

Chosen option: "both, selected by configuration". `api` is the simplest way to start. `handoff` is cheaper for users who already have Claude Code.

**What we give up**: two code paths to keep equivalent, and a delay between the signal and its resolution in handoff mode. The pending item keeps the market snapshot of the day the signal was detected, so a late resolution is still judged on that day's facts.

**Scope**: heartbeat escalations, the Monday briefing and the weekly screening.

**Confidence**: medium. Revisit if routines gain synchronous invocation, or if API costs fall enough to make handoff not worth its complexity.

### Consequences

- Good: `pending:resolve`, `monday-briefing:finalize` and `screening:resolve` validate the model's JSON or report and reject it, rather than commit something wrong.
- Good: screening candidates are reasoned one per turn, so a session that dies halfway leaves the finished ones recorded. The relay summarizes an orphaned run.
- Bad: in handoff the engine can't see whether the session's web search worked. The briefing validator requires a citation or an explicit disclaimer in the macro section.

### Confirmation

`src/tests/handoff-provider.test.ts`, `src/tests/pending.test.ts`, `src/tests/monday-briefing-flow.test.ts` and `src/tests/screening-flow.test.ts` check that both backends produce the same decision for the same recommendation.

**Success measure**: equivalence between backends, enforced by those tests.

## More information

Retroactive record of decisions taken in July 2026 in the original deployment.
