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

### Command

A user action on the engine's state, such as a buy, a sale or moving a stop. State changes only
through commands; each is applied by its own handler, and a batch of them applies whole or not at
all.

### Batch

An ordered list of [commands](#command) in one file of the [inbox](#inbox), applied whole or not at
all. Each command is checked against the state the ones before it would produce, so a buy and its
sale can share a batch.

### Inbox

The folder where a person, an AI, a routine or the engine itself drops one file per [batch](#batch) of
[commands](#command). The engine writes there only new files (the `set_stop` of a stop it proposes) and never edits
one: `inbox:ingest` moves it to `applied/`, or to `rejected/` with the line and the reason of each error (a
[rejected batch](#rejected-batch)). It is the only way a buy or a sale is recorded.

### Rejected batch

A [batch](#batch) that `inbox:ingest` refused: it applied nothing, and the file stays in `inbox/rejected/` as the audit
trail, never retried. It awaits an answer, named in every digest of the [heartbeat](#heartbeat), until a later batch
replaces it (`replaces: <file>` at its top) or discards it (a `discard` [command](#command) with `file: <file>`). A
batch that depends on it fails its own validation.

### Pending escalation

A signal that was [escalated](#escalation) in `handoff` mode and that no one has closed. The engine leaves it as a file
in `logs/pending/` (its id is the file name without `.md`, such as `2026-11-20-xom`) for the [reasoner](#reasoner-api-and-handoff).
It stays open, and is named in every digest of the [heartbeat](#heartbeat), until a `resolve` [command](#command) closes it
as `resolved` (answered) or `discarded` (given up). A command is the only way to close it: the file is never edited or
deleted, and the store remembers what was closed with the hash of the file, so a new signal written later under the same
name is open again.

### Conversion

Cash moved from one [silo](#silo) to the other: the `convert` [command](#command) takes an amount out of one currency
and gives the other what arrived, at a rate the owner got, in one step (both silos change or neither). It is the only
way to convert, and it writes an `fx_conversion` line of the decision log, which the [shadow portfolio](#shadow-portfolio) replays.

### Corporate action

An event of a security that changes the units and prices of a [lot](#lot) without any trade by the owner. Today only a
split (or reverse split) is one: the `split` [command](#command) multiplies the units of every open lot of a ticker by
the ratio and divides its entry price and stop by it, so what was invested, the entry costs and [R](#r) do not change,
and it writes a `split` line of the decision log. A spin-off or a merger is not a command yet.

### Snapshot

What the broker shows of one [silo](#silo) on a date: its cash and the units of each position, told to the engine with the
`snapshot` [command](#command) (#138). The engine compares it with its own state and reports and records each difference
(a `reconcile` line of the [decision log](#decision-log) per difference) without changing the state: the broker is the
owner's fact, but applying it silently would hide a trade missed or entered wrongly, so the owner corrects the state with
a command. The date of the latest snapshot of a silo is what its staleness is measured from, and its differences are named
in every digest of the [heartbeat](#heartbeat) until a later snapshot shows none.

### Correction

How a mistaken buy, sale, deposit or withdrawal is fixed (#139): the `correct` [command](#command) names the record by the id
the engine gave it in the [decision log](#decision-log) and gives the values it should have had. The engine applies the batches
already applied again with the corrected record, rebuilds the [lots](#lot), cash and positions, and writes a `correction` line
that points at the original with `corrects`. The original stays in the log and in the history: a correction supersedes, it never
erases, and it is refused if it would leave a later sale without lots or the cash below zero.

### Repair

What the owner runs when the [store](#store) is corrupt (#139): `npm run state:repair` rebuilds it from the [decision log](#decision-log)
and the batches in `inbox/applied/`, the audit trail, and refuses, changing nothing, when the two disagree, saying where. It is never
automatic, it edits no batch and no line of the log, and every run writes a `repair` line with the date, the result and the differences.

### Last valid configuration

The copy of a [configuration file](input-format.md#configuration-files) (the strategy, the portfolio policy, the screening
universe or a prompt) that the engine last found valid, kept in `state/config/<file>`, written only by the engine and committed
with the rest of the state (#142). When the file the owner edits stops validating, the engine runs on this copy: a bad edit never
stops risk watch. Every [heartbeat](#heartbeat) digest and the Monday briefing email warn, with every error (file, field, reason),
until the first run after a valid edit. Until a file has validated once (the first run) there is no copy, and what needs the file
refuses with the errors.

### Stale

A [silo](#silo) is stale when it has no [snapshot](#snapshot) of the broker, or its latest one is older than
`PORTFOLIO_STALE_DAYS` (7 days). Never fresh by default: the engine integrates with no broker, so a state nobody compared
with it may be wrong. What else changed the silo since (a trade, a deposit) does not make it fresh, and a silo with no
trades and a recent snapshot is not stale. The [heartbeat](#heartbeat) names a stale silo in its digest.

### Stop

The price at which a position is closed to cap its loss. A position has one stop, set or moved by the
`set_stop` [command](#command) and removed by `clear_stop`; a buy never changes it. The stop a lot starts
with is its initial stop, the base of [R](#r). A position without a stop is named in every digest, since
risk watch cannot protect it. A stop the engine proposes (`ADJUST_STOP`) is never written into the state by the flow
that proposes it: it drops a `set_stop` in the [inbox](#inbox), as the owner would, and placing the stop at the broker
is the owner's job.

### Silo

A currency account (EUR or USD) managed on its own: its own cash, positions,
[benchmark](#benchmark) and risk sizing. Each trade risks 1% of its silo's value.

### State port

The one module through which every flow reads and writes a piece of the engine's state, in the engine's own
model and never as text: today `src/portfolio-store.ts` for the portfolio (cash, positions, lots), whose
amounts are [money](#money) of the silo's currency. The format behind it (the [store](#store), or `portfolio.md`
until the first `inbox:ingest`) is known only to the storage layer, and a test fails when another module reads or
writes a state file.

### Store

The engine's own file of the portfolio, `state/portfolio.json`, written only by the engine; it holds the [watchlist](#watchlist) too.
`portfolio.md` and `watchlist.md` are views generated from it, read by nobody; prices are not in it but in [telemetry](#telemetry) (the view
shows them); to change the portfolio or the watchlist, drop a
[batch](#batch) in the [inbox](#inbox).

### Telemetry

What the engine observes, as against what the owner tells it (#133): the last prices and the P/L they give, and the markers of the
alerts already sent (`logs/heartbeat-sent-<ccy>.json`). It is written by the [heartbeat](#heartbeat) and the Monday briefing
and never by `inbox:ingest`, and it is not [state](#store): the last prices
are in `telemetry/prices-<ccy>.json`, one file per silo, each price with the volume and average price of the position it was
seen against, so that a buy, a sale or a split makes a price seen before it stop applying to the position. A read of the
portfolio puts them over the positions, and the generated `portfolio.md` shows them. A telemetry file that does not read is
ignored and never stops a flow.

### Watchlist

The tickers the [heartbeat](#heartbeat) scans every day for [setups](#setup): the candidates a buy can come from (a buy of a
ticker that is not on the list of its [silo](#silo) is flagged `not_in_watchlist`). It is engine state (#140), kept in the
[store](#store) with the list it began with, and changed only by the `watch` and `stop_watching` [commands](#command) of a
[batch](#batch): the weekly [screening](#screening) and the Monday briefing propose entries and exits by dropping such a
batch in the [inbox](#inbox), and `inbox:ingest` applies it. `watchlist.md` is a view the engine generates from it, read by
nobody once the store holds the list; before the first `inbox:ingest` after that it is the state, as it always was, and seeds the
store. A ticker is on it once, in one silo. A position is watched for risk whether or not its ticker is on the watchlist.

### Compare-and-swap

How the engine's state is committed to the data repository when runs can overlap: a run reads the last commit, works
over it and pushes its result on top of exactly that commit. If the repository moved meanwhile the push is refused
(the run "lost the race"): the run throws its work away, reads the state as it is now and does the work again, a
bounded number of times, so a retried [batch](#batch) is judged against the state it now meets and the result is that
of a fresh run. A run that keeps losing applies nothing and rejects nothing, and its batches stay in the
[inbox](#inbox) for the next run: a delay, never a verdict on them. It takes no lock, and the [heartbeat](#heartbeat)
does not take part in it: its stop checks read the last commit.

### Heartbeat

The daily run, after each market's close: it records the last prices ([telemetry](#telemetry)), checks stops, looks for
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
(the oldest entry first) and records one exit per lot consumed; each exit says how many units it
sold from its lot and how many the lot has left. Selling part of a lot leaves the rest of it open: a trade is closed, and counts in the
results, when its lot is fully consumed, that is, when its last exit leaves 0 units. A lot only partly
sold is an open position, not a closed trade. A lot whose sales add up to more than the units of the
entry, or whose exits disagree about the entry or about the units left, is inconsistent data: it is not
measured, and the evaluation report names it. An exit that carries no snapshot of its lot, or no
units left, is not measured either, and the report names it.

### Ticker

The symbol of an asset (`TCK`, `BRK-B`, `EXSA.DE`, `^GSPC`, `EURUSD=X`), in the form Yahoo Finance
uses. Its canonical form is trimmed and upper case: letters, digits and `. - ^ =`, with at least
one letter or digit, and no two dots in a row and no leading dot. The engine makes a ticker only
by parsing, so `tck` and `TCK` are one ticker everywhere and two tickers are equal exactly when
they are the same string. A value that does not parse (for example `M&M.NS` or `A..B`) is not a
ticker. The rule against `..` and a leading dot narrowed the pattern without a `schema_version`
bump, because the owner approved it on 2026-10-26. A row or entry with such a value is skipped with
a warning by the tolerant readers, while some commands refuse the file, naming it and the row. A
decision-log line with one is skipped with a warning by every reader.

### Money

An amount of one currency (EUR or USD), always a whole number of cents (`src/money.ts`), with its
currency in the type, so an amount of one silo cannot be added to or compared with one of the other.
The engine makes a money value only through `money()`, which says the currency, compares two at the cent, shares one over weights by the
largest-remainder method (the shares add up exactly to the total, none is negative) and writes it
with two decimals. Prices, exchange rates, units and percentages are not money and stay plain
numbers. The one exception is the `amount` of an exit: it is its exact share of the sale amount and
keeps up to 8 decimals, so a lot worth under half of the last decimal (`5e-9`, the dust limit) has
an amount of 0 and cannot be sold.

### Rules version

The version of the trading rules stamped on every decision, so results can be split by the rules
that produced them.
