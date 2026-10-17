# Glossary

The terms the engine, its reports and its decision records use, each defined once. Other
documents link here instead of redefining them. The ADR in brackets is the one that decides the
term.

## Measurement

### R

The unit every result is measured in: **multiples of the risk taken on the trade**. One R is the
distance from the entry to the initial stop. A result in R is
`(exit − entry − costs per unit) / (entry − initial stop)`
([ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md)).

Example: buy at 100 with the stop at 95, so 1R = 5. Selling at 110 is **+2R**; the stop being hit
is **−1R**; selling at 102.5 is **+0.5R**.

R makes results comparable across trades and independent of money: +2R means the same with any
account size, which is why results can be published without amounts. With a 2:1
[reward:risk](#rewardrisk-rr), winning 40% of the time averages 0.4 × 2R − 0.6 × 1R = +0.2R per
trade.

### Plan R

The [R](#r) a proposal would have made if followed exactly as proposed — entry, stop and target —
over the 60 sessions after it, whether or not anyone executed it. It judges the system's
proposal, not the user's execution
([ADR-0014](decisions/0014-decision-quality-slo.md)).

### Reward:risk (R:R)

Distance to the target divided by distance to the stop, net of costs. A buy needs at least 2:1
([ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md)). At 2:1, break-even
is a hit rate of 1 / (1 + 2) = 33%.

### Benchmark

One accumulating ETF per [silo](#silo) (`REFERENCE_TICKER_EUR`, `REFERENCE_TICKER_USD`), the
"do nothing" alternative every result is compared with. It also sets the
[market regime](#market-regime). In charts it is shown in [R](#r): its return over the same window
divided by the proposal's stop distance
([ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md)).

### Shadow portfolio

A virtual portfolio that buys the [benchmark](#benchmark) with every real cash flow of a silo. The
user's real value against it answers "did using the system beat simply holding the index?"; it is
a private metric ([ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md) §1,
[ADR-0014](decisions/0014-decision-quality-slo.md)).

### SLI and SLO

A service level indicator is a measured value; an objective is its target. Here the headline SLI
is the [plan R](#plan-r) of every buy proposal, with a confidence bound, not speed
([ADR-0014](decisions/0014-decision-quality-slo.md)). Below 30 evaluated proposals its status is
"insufficient data".

### Screening lift

Mean excess return over the [benchmark](#benchmark), at 60 sessions, of the
[screening](#screening)'s ranked candidates minus its [exploration](#exploration-candidate)
candidates: whether the ranking adds anything over chance
([ADR-0014](decisions/0014-decision-quality-slo.md)).

## Engine

### Brain

The data directory the user owns — portfolio, watchlist, theses, policy, logs — as versioned
Markdown in its own repository. The engine reads and writes it; it never lives in this repository
([ADR-0001](decisions/0001-public-engine-private-data.md),
[ADR-0003](decisions/0003-state-as-versioned-markdown.md)). `examples/brain` is a fictitious one.

### Silo

A currency account (EUR or USD) managed on its own: its own cash, positions,
[benchmark](#benchmark) and risk sizing. Each trade risks 1% of its silo's value
([ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md)).

### Heartbeat

The daily run, after each market's close: it refreshes prices, checks stops, looks for
[setups](#setup) and [risk triggers](#risk-trigger), and [escalates](#escalation) what survives
the rules.

### Setup

The only way the engine proposes a buy: a price pattern detected at the close on a watchlist
candidate ([ADR-0013](decisions/0013-entry-setups.md)).

- **Pullback in trend**: a dip within an uptrend, confirmed at the close.
- **Breakout**: a move out of a base near highs. **Armed** means a Buy Stop level is set and not
  yet reached; **confirmed** means it broke out on volume.

### Eligibility

Three deterministic rules — bearish trend, weak momentum, adverse
[regime](#market-regime) — that block a [setup](#setup) before it reaches the reasoner. A blocked
setup is recorded as `buy_blocked` with its reasons
([ADR-0010](decisions/0010-deterministic-entry-eligibility-filter.md)).

### Risk trigger

A condition on something watched that needs a look: a position near its stop
(`approaching_stop`) or a large daily move (`big_move`).

### Escalation

Handing a signal that survived the rules to the reasoner (Claude). A run without signals costs no
tokens: at most one call per escalated signal
([ADR-0002](decisions/0002-escalate-to-claude-only-after-deterministic-filters.md)).

### Reasoner: API and handoff

The model that judges an escalated signal. In `api` mode the engine calls the Anthropic API; in
`handoff` mode it leaves the prompts in `logs/pending/` for a Claude Code session
([ADR-0004](decisions/0004-handoff-mode-for-the-reasoner.md)).

### Ticket

The order the engine proposes, fully computed: entry, stop, target, units, amount and costs. The
engine sets the money figures, never the reasoner
([ADR-0009](decisions/0009-swing-framework-risk-sizing-and-measurement.md)).

### ATR stop

The stop distance as a multiple of ATR14 (the average daily range of the last 14 sessions): 3 ATR
for the medium horizon, 2.5 for short, never less than 2
([ADR-0011](decisions/0011-stops-sized-in-atr.md)).

### Market regime

The state of a silo's [benchmark](#benchmark): `favorable` (above its 200-session average, with
the 50-session average rising), `adverso` (below the 200-session average) or `neutral`. Stored
values are in Spanish, inherited from the original deployment.

### Screening

The weekly ranking of the screening universe: a mechanical filter 0, two ranking factors per
[silo](#silo), the top candidates analysed, plus one
[exploration candidate](#exploration-candidate) per silo
([ADR-0012](decisions/0012-screening-funnel.md)).

### Exploration candidate

A candidate picked at random per silo, as a control: it is what
[screening lift](#screening-lift) compares the ranked ones against
([ADR-0012](decisions/0012-screening-funnel.md)).

### Conviction

`high`, `medium` or `low`, scored by the engine with one point per condition: top of its silo's
ranking, favorable [regime](#market-regime), [R:R](#rewardrisk-rr) at the minimum or above, and a
dated catalyst ([ADR-0012](decisions/0012-screening-funnel.md) §7).

### Decision log

`logs/decisions.jsonl`: one append-only JSON line per decision — proposals, blocks, holds and the
user's own trades — with the price, benchmark and plan of the day, so every decision can be
evaluated later ([ADR-0006](decisions/0006-single-append-only-decision-log.md)).

### Rules version

The version of the trading rules stamped on every decision, so results can be split by the rules
that produced them.
