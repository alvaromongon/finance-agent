---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0010. A deterministic entry-eligibility filter: trend, momentum and market regime

- **Issue**: initial publication (v0.1.0)

**Decision**: the engine blocks every entry setup ([ADR-0013](0013-entry-setups.md)) that fails one of three rules. Blocked setups are not escalated to the reasoner and are recorded with their reasons.

1. **Trend:** price < SMA50 < SMA200 (bearish bias).
2. **Momentum:** `(price − SMA50) / ATR14 < −1.5`.
3. **Regime:** the silo's benchmark is below its SMA200 (`adverso`).

## Context and problem statement

In the original deployment, several entries were bought while the price fell through a static buy zone. The thesis was intact, but the timing was not. On another day, three stops were hit at once by a market-wide shock. With a weak market there are fewer good entries, and holding cash is correct.

**Why it matters**: an entry in an open fall turns a sound thesis into a stop-out.

## Decision drivers

- The verdict is objective, so it should not depend on a model repeating arithmetic.
- Every block is recorded, so its cost can be measured.
- One lever per rule, so each can be calibrated.

## Considered options

- Let the reasoner judge timing.
- A deterministic filter in the engine.
- No filter: buy every setup.

## Decision outcome

Chosen option: "a deterministic filter". The thresholds are in ATR, not in percent, on purpose: a −5% day is noise for a volatile security and a serious fall for a quiet one. The two security rules cover different gaps. A mixed bias (above SMA200, far below SMA50) is only caught by momentum. A bearish bias that hugs its SMA50 is only caught by trend.

The regime rule uses the silo benchmark alone, with one year of daily closes. It is `favorable` when the benchmark is above its SMA200 and its SMA50 is rising (higher than 20 sessions ago), `adverso` below its SMA200, and `neutral` otherwise. Only `adverso` blocks. `favorable` adds a point to conviction ([ADR-0012](0012-screening-funnel.md) §7). Without enough history there is no regime, and it does not block.

**What we give up**: the filter only delays entries, never forces one. The worst case of a miscalibrated threshold is a missed opportunity, not lost capital. V-shaped rebounds from below the SMA200 are missed until the benchmark recovers. A flat SMA200 can flip the regime within days.

**Scope**: heartbeat setups, pending resolutions and the Monday briefing.

**Confidence**: low. The first calibration used 6 measured entries. Revisit with several dozen decisions, through [ADR-0009](0009-swing-framework-risk-sizing-and-measurement.md) §5.

### Consequences

- Good: `decisions:evaluate` compares eligible setups with those blocked by regime and those blocked for other reasons. The two blocked groups are disjoint.
- Bad: in an adverse regime nothing in the silo is eligible, so there is no simultaneous control group. The comparison is between periods.
- Bad: a pending item is judged with the regime of its detection date, which is frozen in the snapshot.

### Confirmation

`src/tests/entry-eligibility.test.ts` and `src/tests/market-regime.test.ts`.

**Success measure**: eligible setups beat blocked ones in R at 20 sessions, with at least 30 per group (`decisions:evaluate`).

## More information

Retroactive record of a decision taken in September 2026. The regime rule follows the index phase filter of [RyanJHamby/stock-screener](https://github.com/RyanJHamby/stock-screener).
