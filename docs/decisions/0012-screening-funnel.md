---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0012. Screening funnel: mechanical filter 0, a two-factor ranking with exploration, an engine conviction rubric and a mechanical watchlist exit

- **Issue**: initial publication (v0.1.0)

**Decision**: the weekly screening stops drawing candidates at random. Every security of `screening-universe.md` goes through a mechanical filter 0. The eligible ones are ranked by two factors in each silo. The top ones are analysed, plus one random exploration candidate per silo. The engine, not the reasoner, scores conviction, and it retires watchlist entries by mechanical rules.

## Context and problem statement

Drawing candidates at random rarely finds one in a good moment to enter. A strength filter written into the prompt asked the model to repeat comparisons the engine already computed, with exceptions nobody could check. The reasoner rated almost everything "medium" conviction. And the watchlist only shrank when the model judged it should, so it kept growing.

**Why it matters**: the screening decides what the system can buy at all. A poor funnel wastes the reasoner on candidates it could never act on.

## Decision drivers

- Deterministic where possible. The reasoner answers only what the engine can't see.
- Every ranking choice is measured against chance (exploration).
- The same reasoning cost as before: 12 candidates per run.

## Considered options

- A random draw, with the strength filter in the prompt (do nothing).
- A mechanical filter, a ranking and exploration.
- Rank only, with no exploration.

## Decision outcome

Chosen option: "filter, ranking and exploration", numbered so code can cite it (`ADR-0012 §N`):

1. **Filter 0.** A security is eligible if it has data from this week, at least 240 sessions in the last year, a last close above its SMA200, and a median 50-session traded value of at least 500,000 in its currency. No exception for "turnaround catalysts".
2. **Score.** For each silo, the mean percentile of two factors: proximity to the 52-week high, and 6-month relative strength against the silo benchmark ([ADR-0009](0009-swing-framework-risk-sizing-and-measurement.md) §1). Only two factors, to overfit less.
3. **Selection.** The best 4 in EUR and 6 in USD, excluding the watchlist and recent rejections. Plus 1 random exploration candidate per silo among the remaining eligibles, marked `exploration: true`.
4. **Record.** `screen_interesting` and `screen_rejected` carry `rank`, `score` and `exploration` ([ADR-0006](0006-single-append-only-decision-log.md)).
5. **Fallback.** The ranking is skipped if a benchmark lacks recent history, if less than 80% of the universe has data, or if the median last session is more than 5 days old. Then `prepare` draws at random among the filter-0 eligibles, and the email says **NO RANKING** with the reason.
6. **Question to the reasoner:** "is there a thesis that justifies trading this security when a setup appears?". The reasoner judges what the engine can't see: an identifiable driver, no unpriced fundamental risk, no thematic duplicate.
7. **Conviction rubric.** One point each for: top quintile of the ranking, `favorable` regime ([ADR-0010](0010-deterministic-entry-eligibility-filter.md)), an active setup with net R:R ≥ 3, and a dated catalyst (the only qualitative point). **high** is 3 or more points, **medium** 2, **low** 0–1. The heartbeat applies the same rubric to setups, inheriting the screening points.
8. **Mechanical watchlist exit.** A candidate is retired if:
   - it left the universe (`out_of_universe`);
   - it fails filter 0 (`filter_zero`);
   - it falls out of the top half of its silo (`out_of_top`);
   - or it spent 4 weeks without any setup (`no_setup`).

   A security with an open position is never retired, and a data failure retires nothing. The Monday briefing can only bring an exit forward, by citing the thesis's own invalidation criterion.

**What we give up**: the only measurement available went _against_ rewarding proximity to highs, but it was a 20-session horizon with 19 overlapping observations. That is why the ranking is a hypothesis with a minimum sample, and why exploration is mandatory. Downloading the universe adds about 1 minute per run (measured: 186 series in 61 s with no rate limiting, 2026-09-16).

**Scope**: `screening:prepare`, `screening:resolve`, the heartbeat's conviction and the watchlist.

**Confidence**: low. Revisit when ranking vs exploration has 30 candidates per group at 20 sessions.

### Consequences

- Good: "Ranking vs exploration" in `decisions:evaluate` answers whether the ranking beats chance.
- Bad: candidates excluded by filter 0 are not recorded (about 100 a week, with no consumer). Only the run's progress output shows the reason.

### Confirmation

`src/tests/screening-ranking.test.ts`, `src/tests/conviction.test.ts`, `src/tests/watchlist-exit.test.ts` and `src/tests/screening-flow.test.ts`.

**Success measure**: ranked candidates beat exploration ones in excess return at 20 sessions, with 30 per group (`decisions:evaluate`). See [ADR-0014](0014-decision-quality-slo.md).

## More information

Retroactive record of decisions taken between 2026-09-16 and 2026-09-30. The watchlist exit values were measured on 192 securities over 150 sessions: a setup is active on 24% of days, and a security above its SMA200 forms one within 4 weeks 91% of the time. Factors: George & Hwang (2004) for the proximity to the 52-week high.
