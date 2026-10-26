---
status: "Deprecated — detail moved to [flows.md](../flows.md#stops-in-atr)"
date: 2026-10-15
decision-makers: Repository owner
---

# 0011. Stops are sized in ATR and set by the engine

- **Issue**: initial publication (v0.1.0)

**Decision**: the stop distance is a multiple of ATR14, not a percentage: 3 ATR for the `medium` horizon, 2.5 ATR for `short`, and never less than 2 ATR. The engine sets the stop of every ticket. On `ADJUST_STOP` it raises it to that distance below today's price and never lowers it. The heartbeat emails a direct warning, with no LLM, when an open position's real stop is closer than `STOP_MIN_ATR`.

## Context and problem statement

Stops used to be a percentage of price. A 3% stop is 1.5 ATR on a quiet security and 0.6 ATR on a volatile one: the second is almost certain to be swept. In the original deployment, one position was stopped out at 1.2 ATR on a day it closed above its own stop.

**Why it matters**: a stop inside the daily noise closes positions whose thesis is intact.

## Decision drivers

- Volatility is the natural unit for any price distance (same family as [ADR-0010](0010-deterministic-entry-eligibility-filter.md)).
- The user places the real stop at their broker, so the engine can only advise on it.

## Considered options

- Let the reasoner propose the stop.
- The engine sets an ATR-based stop, and the heartbeat warns about tight real stops.
- A hard guard that rejects tickets with tight stops.

## Decision outcome

Chosen option: "the engine sets the stop, and the heartbeat warns". With the engine computing it, no system ticket carries a tight stop. The warning covers discretionary trades and stops the user moved away from the ticket.

**What we give up**: the warning has no cooldown: it repeats on every run until the stop is fixed. The lever is `STOP_MIN_ATR`, not extra state. Positions already below their stop are excluded, because the stop-breach alert covers them ([ADR-0008](0008-market-data-freshness.md)).

**Scope**: tickets, `ADJUST_STOP`, and the heartbeat's stop-hygiene step.

**Confidence**: medium. 2, 2.5 and 3 ATR come from 5 executed stops. Revisit with several dozen trades.

### Consequences

- Good: every trade's 1R means the same thing, which makes R comparable ([ADR-0009](0009-swing-framework-risk-sizing-and-measurement.md)).
- Bad: one history request per position with a stop, per run. It is best-effort: without ATR the position is skipped, and the run continues.

### Confirmation

`src/tests/atr-stop.test.ts` and `src/tests/sizing.test.ts`.

**Success measure**: no system ticket with a stop closer than 2 ATR, enforced by `src/tests/sizing.test.ts`.

## More information

Retroactive record of a decision taken on 2026-09-01.
