---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0007. Ownership is first-class: the portfolio decides what is watched for risk

- **Issue**: initial publication (v0.1.0)

**Decision**: the heartbeat watches the union of open positions (`portfolio.md`) and candidates (`watchlist.md`). An open position gets risk triggers (stop proximity, big move) whether or not it is on the watchlist. The reasoner's prompt branches on ownership: for a position it can hold, sell or adjust the stop; for a candidate, buy or wait.

## Context and problem statement

At first the heartbeat iterated only over the watchlist. A position without a watchlist entry got no risk watch, so "shadow" watchlist entries with empty buy zones existed only to make up for it. When a position closed, its orphaned shadow kept producing signals with no possible decision.

**Why it matters**: a position without a risk watch can cross its stop without an alert.

## Decision drivers

- Removing a security from the watchlist must never leave a position unwatched.
- A position and a candidate ask different questions.

## Considered options

- Watchlist only, with shadow entries for positions (do nothing).
- The union of portfolio and watchlist, with the prompt branching on ownership.

## Decision outcome

Chosen option: "union, with prompt branching". The portfolio is the single source of truth for what is owned.

**What we give up**: two lists to read on every run.

**Scope**: the heartbeat, the pending resolution and the analyst prompt.

**Confidence**: high.

### Consequences

- Good: `ADJUST_STOP` lets the reasoner raise a trailing stop without opening a new ticket. The engine computes the level ([ADR-0011](0011-stops-sized-in-atr.md)).
- Good: closing a position does not touch the watchlist. The security leaves it through the screening's mechanical exit ([ADR-0012](0012-screening-funnel.md)).

### Confirmation

`src/tests/heartbeat.test.ts` (portfolio as the source of truth) and `src/tests/analyst.test.ts` (owned and not-owned branching).

**Success measure**: no open position without risk triggers, enforced by `src/tests/heartbeat.test.ts`.

## More information

Retroactive record of a decision taken in July 2026.
