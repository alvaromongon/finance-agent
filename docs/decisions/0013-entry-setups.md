---
status: "Deprecated — detail moved to [flows.md](../flows.md#entry-setups)"
date: 2026-10-15
decision-makers: Repository owner
---

# 0013. Entry setups: deterministic pullback and breakout detectors replace buy zones

- **Issue**: initial publication (v0.1.0)

**Decision**: buys come only from setups the heartbeat detects every day on each watchlist candidate:

- a **pullback in trend**, confirmed at the close;
- a **breakout** from a base near highs, either _armed_ (with a Buy Stop level) or _confirmed_ on volume.

The pattern gives the target. The engine computes stop and size ([ADR-0009](0009-swing-framework-risk-sizing-and-measurement.md)). Each new setup then goes through the eligibility filter ([ADR-0010](0010-deterministic-entry-eligibility-filter.md)).

## Context and problem statement

Entries depended on a static buy zone calibrated on one day. A falling price crosses a zone in exactly the same way that a pullback touches it. Buys were also proposed only once a week, in the Monday briefing, which made them late.

**Why it matters**: the entry decides where the stop sits, and so how much each trade risks.

## Decision drivers

- Confirmation of a floor, not just "the price is inside a range".
- A target that can reach the 2:1 net R:R minimum.
- One single way into a position, so that every entry can be attributed and measured.

## Considered options

- Static buy zones (do nothing).
- Deterministic pattern detectors in the daily heartbeat.
- Let the reasoner spot entries.

## Decision outcome

Chosen option: "deterministic detectors in the heartbeat", numbered so code can cite it (`ADR-0013 §N`):

1. **Detectors.** Both run on every candidate with one year of daily bars.
   - **Pullback:**
     - the close is above its SMA200;
     - in the last 5 sessions the low touched the SMA20 or SMA50;
     - today it closes back above that average with a higher low;
     - the 20-session high is still above the close.
   - **Breakout base:** 15 sessions with a range of at most 3 ATR (the ATR from before the base), and a ceiling within 5% of the 52-week high.
     - _Armed:_ the base ends today, unbroken. The alert gives its ceiling as a Buy Stop level.
     - _Confirmed:_ today's close beats yesterday's ceiling with volume at least 1.5× the 50-session average.

   Only setups that are new compared with yesterday are alerted and recorded.

2. **Target from the pattern.**
   - Pullback: measured projection. The high it pulled back from, plus the size of the pullback.
   - Breakout: ceiling plus the pole (the rise from the low of the 40 sessions before the base).
3. **Eligibility.**
   - A confirmed, eligible setup is escalated to the reasoner. If the reasoner holds, the engine records an eligible `hold`.
   - A blocked one is recorded as `buy_blocked`, without escalating.
   - Armed breakouts are recorded as `setup_armed` and emailed with their Buy Stop.
4. **Single way in.** The Monday briefing no longer proposes buys. A buy from the reasoner without a setup is blocked with `no_setup`. A user entry with no preceding setup is flagged `entry_without_setup`.
5. **Record.** Every new detection is recorded with its `setup` (pattern, state, level), whether or not it is acted on.

**What we give up**: the heartbeat downloads a year of history per candidate per run. An armed Buy Stop that fills without a close above the ceiling is not seen as confirmed: the user records that trade by hand, citing the armed setup.

**Scope**: the heartbeat, the Monday briefing, `decision:record`.

**Confidence**: low. Revisit when 30 setup proposals and 30 R:R-blocked setups have been evaluated at 20 sessions.

### Consequences

- Good: the reasoner only sees setups the engine already considers buyable, so token cost stays bounded.
- Bad: most detections are blocked by R:R. Confirmed breakouts are rare: 2 in a year, against about 50 armed ones (measured, see below).

### Confirmation

`src/tests/setups.test.ts` and `src/tests/setups-scan.test.ts`.

**Success measure**: setup proposals beat setups blocked by R:R, in hypothetical R at 20 sessions, with 30 of each (`decisions:evaluate`).

## Pros and cons of the target options

Measured over 310 pullbacks in 17 securities during the year before 2026-09-24, 60 sessions forward, with the stop at 3 ATR:

| Target                  | Reach 2:1 | Hit the target | Hit the stop first |
| ----------------------- | --------- | -------------- | ------------------ |
| Swing high              | 0         | 214            | 83                 |
| 52-week high            | 59        | 172            | 106                |
| **Measured projection** | **81**    | 115            | 134                |

The swing high never reaches the minimum R:R, so pullbacks would always be blocked. The measurement is in-sample, covers a rising year and has overlapping observations: that is why the system is measured live, not on a backtest.

## More information

Retroactive record of a decision taken on 2026-09-25.
