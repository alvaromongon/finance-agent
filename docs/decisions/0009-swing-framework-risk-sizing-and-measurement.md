---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0009. Swing framework: the engine sizes by risk, measures in net R against one benchmark per silo, and controls rule changes

- **Issue**: initial publication (v0.1.0)

**Decision**: the engine computes every money figure of a ticket and measures every result against a benchmark, with these rules:

- **Sizing:** stop, units and amount come from the engine. Each trade risks 1% of the silo value, a position is capped at 25%, and a buy needs a reward:risk of at least 2:1 net of costs.
- **Measurement:** results are in R net of costs, against one accumulating benchmark ETF per silo, and against a shadow portfolio that buys that benchmark with every cash flow.
- **Change control:** the rules carry a `version`, and each change is judged only with the decisions made after it.

## Context and problem statement

A swing-trading assistant is only worth running if it answers, with data and in reasonable time: "does this beat doing nothing?". Public evidence goes against active retail trading. Stops set as a percentage of price, and sizes chosen by feel, make results impossible to compare across trades.

**Why it matters**: without a common unit and a benchmark, a good month in a rising market looks like skill.

## Decision drivers

- Money arithmetic is deterministic and testable (principle: _deterministic where money is involved_).
- Results are comparable across securities with different volatility and price.
- The numbers are fixed before looking at more data.

## Decision outcome

The framework, numbered so that code comments can cite it (`ADR-0009 §N`):

1. **One benchmark per silo**, set with `REFERENCE_TICKER_EUR` / `REFERENCE_TICKER_USD`. It must be an accumulating ETF: the engine uses closes not adjusted for dividends, so a distributing ETF would understate the benchmark. The same benchmark serves the shadow portfolio, the market regime ([ADR-0010](0010-deterministic-entry-eligibility-filter.md)), the relative strength of the ranking ([ADR-0012](0012-screening-funnel.md)) and the excess return of each decision. The **shadow portfolio** starts at the silo value and replicates every deposit, withdrawal and currency conversion on the same date. Returns are money-weighted (modified Dietz).
2. **Unit: net R.** `R = (exit − entry − costs per unit) / (entry − initial stop)`. The currency conversion fee is not in R: it is paid when converting, and the shadow portfolio pays it too.
3. **Size by risk.** Risk per trade: 1% of the silo value (total cash plus positions at market). Units = risk / (entry − stop), fractional when the broker allows it (`BROKER_FRACTIONAL_SHARES`), always rounded down. Hard cap: 25% of the silo value and the available cash. Minimum net R:R: 2:1 on the planned target. What does not reach it is recorded as `buy_blocked` with `rr_below_min`. Orders below `BROKER_MIN_ORDER_VALUE` are blocked.
4. **Evaluation board.** `decisions:evaluate` counts the system's closed trades under the current major rules version, adding up both silos (R has no currency), and reports expectancy and real-versus-shadow value. A silo that falls ≥ 15% from its peak, measured without cash flows, pauses new entries until the next written review.
5. **Change control.** Every rules change has a written hypothesis, metric, minimum sample and window. It is judged only with decisions made after it, one component at a time (screening, entry, stop and size, regime). The version lives in the `version` frontmatter of `strategies/base.md`. The thresholds in `config.framework` are not environment variables on purpose: changing them is a rules change.
6. **Currency buffer.** Convert to the USD silo only what is missing to cover one maximum position (the 25% cap), and never on weekends or currency holidays, when the fee is usually higher.
7. **Costs.** Transaction taxes by market are estimated conservatively, without checking market cap. The conversion fee comes from `BROKER_FX_CONVERSION_PCT`.
8. **Discretionary trades** are allowed. They carry origin `propietario` (owner), do not count for the system's expectancy, and are evaluated separately.

**What we give up**: the engine dictates size, so the user can't size by conviction inside the system. Doing so makes the trade discretionary (§8). The 1% / 25% / 2:1 values are a first calibration: a Monte Carlo of 50 trades put the chance of a ≥ 15% drawdown at about 5% for a +0.2R system and about 35% for a −0.1R one (estimated: −1R losses with 10% gaps to −1.3R, +2R average win, independent trades, which understates risk on correlated days).

**Scope**: every ticket, every evaluation, every rules change.

**Confidence**: medium. Revisit the thresholds after several dozen closed trades, through §5.

### Consequences

- Good: any user can compare the system with simply holding the benchmark.
- Bad: two currency silos (EUR, USD) are built in.
- Bad: the stored `origin` values are in Spanish ([ADR-0006](0006-single-append-only-decision-log.md)).

### Confirmation

`src/tests/sizing.test.ts`, `src/tests/risk.test.ts`, `src/tests/silo-performance.test.ts` and `src/tests/decisions-evaluation.test.ts`.

**Success measure**: see [ADR-0014](0014-decision-quality-slo.md).

## Pros and cons of the options

- **Whole shares only:** with 1% risk and a 3 ATR stop, only 15 of 27 securities of the original watchlist fit. The expensive ones drop out because of their share price, not their setup.
- **0.5% or 2% risk:** at 0.5% a drawdown barely tells a good system from a bad one. At 2% the pause would trigger on a system that works.
- **R:R 1.5:1 or 3:1:** the first needs a hit rate above 40%. The second needs targets at 9 ATR, rarely reached in weeks.
- **A world or S&P 500 ETF as the EUR benchmark:** it mixes the US and EUR/USD into the regime and relative strength of European securities (daily correlation 0.22–0.30, against 0.44 for STOXX Europe 600; measured over one year to 2026-09-14 on 13 securities).

## More information

Retroactive record of a decision taken on 2026-09-14. The owner-specific parts (account size, cut-off dates, move from demo to real money) stay in the owner's private repository.
