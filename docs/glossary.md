# Glossary

The terms the engine, its reports and its decision records use, each defined once and in full.
Other documents link here instead of redefining them. The glossary is self-contained: it links
only between its own entries, never to other documents.

## Measurement

### R

The unit every result is measured in: **multiples of the risk taken on the trade**. One R is the
distance from the entry to the initial stop. A result in R is
`(exit − entry − costs per unit) / (entry − initial stop)`.

Example: buy at 100 with the stop at 95, so 1R = 5. Selling at 110 is **+2R**; the stop being hit
is **−1R**; selling at 102.5 is **+0.5R**.

When a [lot](#lot) is sold in several parts, the trade has one R: the R of each sale weighted by
the share of the lot it sold, `Σ (units sold in the sale / units in the lot) × R of the sale`.
Example: a lot of 10 units bought at 100 with the stop at 90 (1R = 10); 4 units sold at 120 (+2R)
and the other 6 at 105 (+0.5R) give 4/10 × 2 + 6/10 × 0.5 = **+1.1R**, the R of that one trade.

R makes results comparable across trades and independent of money: +2R means the same with any
account size, which is why results can be published without amounts. With a 2:1
[reward:risk](#rewardrisk-rr), winning 40% of the time averages 0.4 × 2R − 0.6 × 1R = +0.2R per
trade.

### Plan R

The [R](#r) a proposal would have made if followed exactly as proposed — entry, stop and target —
over the 60 sessions after it, whether or not anyone executed it. It judges the system's
proposal, not the user's execution.

### Reward:risk (R:R)

Distance to the target divided by distance to the stop, net of costs. A buy needs at least 2:1.
At 2:1, break-even is a hit rate of 1 / (1 + 2) = 33%.

### Benchmark

One accumulating ETF per [silo](#silo) (`REFERENCE_TICKER_EUR`, `REFERENCE_TICKER_USD`), the
"do nothing" alternative every result is compared with. It also sets the
[market regime](#market-regime). In charts it is shown in [R](#r): its return over the same window
divided by the proposal's stop distance.

### Shadow portfolio

A virtual portfolio that buys the [benchmark](#benchmark) with every real cash flow of a silo. The
user's real value against it answers "did using the system beat simply holding the index?"; it is
a private metric.

### SLI and SLO

A service level indicator (SLI) is what is measured and how; its current value is the measurement,
and the objective (SLO) is the target for it. Here the headline SLI is the [plan R](#plan-r) of
every buy proposal, with a confidence bound, not speed. Below 30 evaluated proposals its status is
"insufficient data".

### Screening lift

Mean excess return over the [benchmark](#benchmark), at 60 sessions, of the
[screening](#screening)'s ranked candidates minus its [exploration](#exploration-candidate)
candidates: whether the ranking adds anything over chance.

## Engine

### Brain

The data directory the user owns — portfolio, watchlist, theses, policy, logs — as versioned
Markdown files with YAML frontmatter, kept in the user's own repository (`VAULT_PROJECT_DIR`).
The engine keeps no database: it reads and writes these files, and they never live in the public
engine repository. `examples/brain` is a fictitious one.

### Silo

A currency account (EUR or USD) managed on its own: its own cash, positions,
[benchmark](#benchmark) and risk sizing. Each trade risks 1% of its silo's value.

### Heartbeat

The daily run, after each market's close: it refreshes prices, checks stops, looks for
[setups](#setup) and [risk triggers](#risk-trigger), and [escalates](#escalation) what survives
the rules.

### Setup

The only way the engine proposes a buy: a price pattern detected at the close on a watchlist
candidate.

- **Pullback in trend**: a dip within an uptrend, confirmed at the close.
- **Breakout**: a move out of a base near highs. **Armed** means a Buy Stop level is set and not
  yet reached; **confirmed** means it broke out on volume.

### Eligibility

Three deterministic rules — bearish trend, weak momentum, adverse
[regime](#market-regime) — that block a [setup](#setup) before it reaches the reasoner. A blocked
setup is recorded as `buy_blocked` with its reasons.

### Risk trigger

A condition on something watched that needs a look: a position near its stop
(`approaching_stop`) or a large daily move (`big_move`).

### Escalation

Handing a signal that survived the rules to the reasoner (Claude). Every run computes signals and
rules in code, with no LLM; only a confirmed [setup](#setup) or a [risk trigger](#risk-trigger)
that survives them is escalated. A run without signals costs no tokens: at most one call per
escalated signal.

### Reasoner: API and handoff

The model that judges an escalated signal. In `api` mode the engine calls the Anthropic API; in
`handoff` mode it leaves the prompts in `logs/pending/` for a Claude Code session.

### Ticket

The order the engine proposes, fully computed: entry, stop, target, units, amount and costs. The
engine sets the money figures, never the reasoner.

### ATR stop

The stop distance as a multiple of ATR14 (the average daily range of the last 14 sessions): 3 ATR
for the medium horizon, 2.5 for short, never less than 2.

### Market regime

The state of a silo's [benchmark](#benchmark): `favorable` (above its 200-session average, with
the 50-session average rising), `adverso` (below the 200-session average) or `neutral`. Stored
values are in Spanish, inherited from the original deployment.

### Screening

The weekly ranking of the screening universe: a mechanical filter 0, two ranking factors per
[silo](#silo), the top candidates analysed, plus one
[exploration candidate](#exploration-candidate) per silo.

### Exploration candidate

A candidate picked at random per silo, as a control: it is what
[screening lift](#screening-lift) compares the ranked ones against.

### Conviction

`high`, `medium` or `low`, scored by the engine with one point per condition: top of its silo's
ranking, favorable [regime](#market-regime), [R:R](#rewardrisk-rr) at the minimum or above, and a
dated catalyst.

### Decision log

`logs/decisions.jsonl`: one append-only JSON line per decision — proposals, blocks, holds and the
user's own trades — with the price, benchmark and plan of the day, so every decision can be
evaluated later. It includes decisions not to act (`hold`, rejections) and the user's cash
flows; every line carries the [rules version](#rules-version). Lines are only appended, never
rewritten, and the engine is its only writer.

### Lot

The units of one ticker bought in a single entry. A trade is one lot: buying more of a ticker you
already hold opens a second lot and so a second trade, and its [R](#r) is measured on its own,
from its own entry price and initial stop. A sale consumes the ticker's lots first in, first out
(the oldest entry first) and records one exit per lot consumed; each exit says how many units its lot
has left. Selling part of a lot leaves the rest of it open: a trade is closed, and counts in the
results, when its lot is fully consumed, that is, when its last exit leaves 0 units. A lot only partly
sold is an open position, not a closed trade. A lot whose sales add up to more than the units of the
entry, or whose exits disagree about the entry or about the units left, is inconsistent data: it is not
measured, and the evaluation report names it. An exit that carries no snapshot of its lot, or no
units left, is not measured either, and the report names it.

### Rules version

The version of the trading rules stamped on every decision, so results can be split by the rules
that produced them.
