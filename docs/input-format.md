# Input format

The engine reads its state from files in the project directory (`VAULT_PROJECT_DIR`). The portfolio
is the engine's own store, `state/portfolio.json`, written only by the engine, and `portfolio.md` is a
read-only view generated from it ([below](#stateportfoliojson)); until the first
[`inbox:ingest`](#inboxyaml) makes the store, `portfolio.md` is still the state. The other files are
Markdown. This document is the contract for those files: their
structure is fixed, in English and versioned, and independent of the output
language (`OUTPUT_LANGUAGE`). Prose around the parsed parts is free: write it in
any language.

## Versioning

Every file the engine parses carries `schema_version` in its YAML frontmatter:

```yaml
---
schema_version: 1
---
```

The version is **per file**: each file below has its own, and a change to one
file's format does not touch the others. The engine refuses a file without
`schema_version` or with a version other than the one it reads for that file,
naming the file and the expected version in the error, instead of reading it
partially. An incompatible change to a file's format bumps its version and
ships with a migration script, except where its section says otherwise. The
`version` in `strategies/base.md` is the version of the trading rules, not of
this format.

| File                                   | Versioned                   | Version | Parsed parts                                                    |
| -------------------------------------- | --------------------------- | ------- | --------------------------------------------------------------- |
| `portfolio.md`                         | yes                         | **2**   | Frontmatter, `Cash`, `Positions` and `Lots` tables per currency |
| `state/portfolio.json`                 | yes (written by the engine) | **1**   | All of it: the engine's store of the portfolio                  |
| `inbox/*.yaml`                         | yes                         | **1**   | Frontmatter-less YAML: `schema_version` and `commands`          |
| `watchlist.md`                         | yes                         | 1       | First ` ```yaml ` block                                         |
| `screening-universe.md`                | yes                         | 1       | Frontmatter, first ` ```yaml ` block                            |
| `screening-log.md`                     | yes                         | 1       | The table                                                       |
| `tesis/tesis-<slug>.md`                | yes                         | 1       | Frontmatter                                                     |
| `logs/<YYYY-MM-DD>-<ticker>.md`        | no (written by the engine)  | -       | Frontmatter                                                     |
| `strategies/base.md`                   | no                          | -       | Frontmatter `version` (rules version) and text                  |
| `portfolio-policy.md`, `routines/*.md` | no                          | -       | Text only, passed to the reasoning model                        |

Files that are only passed to the model as text are not parsed, so they carry
no `schema_version`.

Each flow that reasons needs its own prompt in `routines/`. There are no
built-in defaults: a missing prompt fails with the example to copy.

| Prompt                           | Required by                                                                                                       | Example                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `routines/monday-briefing.md`    | `monday-briefing:prepare` (system prompt of the weekly report)                                                    | [`examples/brain/routines/monday-briefing.md`](../examples/brain/routines/monday-briefing.md)       |
| `routines/weekly-screening.md`   | `screening:prepare` (system prompt of each candidate)                                                             | [`examples/brain/routines/weekly-screening.md`](../examples/brain/routines/weekly-screening.md)     |
| `routines/execution-analysis.md` | `heartbeat` whenever it escalates a signal (system prompt of the reasoner, `ANALYST_PROVIDER` `api` or `handoff`) | [`examples/brain/routines/execution-analysis.md`](../examples/brain/routines/execution-analysis.md) |

`pending:*`, `decisions:evaluate`, `screening:outcomes`, `outbox:send` and
`decision:record` need no prompt; `heartbeat` needs one only when it escalates.

A [ticker](glossary.md#ticker) in any file is read case-insensitively and written in upper case:
`tck` in `portfolio.md`, the watchlist, the screening universe or the decision log reads as `TCK`
(a row the engine writes, or an entry it adds, carries the upper-case ticker). A ticker has
letters, digits and `. - ^ =` only (`BRK-B`, `EXSA.DE`, `^GSPC`, `EURUSD=X`), with at least one
letter or digit, and no two dots in a row and no leading dot (`A..B`, `..A` and
`.A` are refused; this narrowing of the pattern shipped without a `schema_version` bump because the
owner approved it in [#93](https://github.com/alvaromongon/finance-agent/issues/93) on 2026-10-26; the
`portfolio.md` v2 change, by contrast, bumped the version and shipped without a migration). A
ticker outside that pattern (`TC|K`, `M&M.NS`, `A..B`) is never silently
accepted, and a typo there must never switch off the stop alerts
([ADR-0015](decisions/0015-open-lots-live-in-the-portfolio.md)). In general, a row or entry whose
ticker does not parse is skipped with a warning by the tolerant readers (the heartbeat,
`pending:resolve`, the Monday briefing, the weekly screening), while some commands, those that must
not act on a file they cannot fully read, refuse it, naming the file and the row.

Two cases are the same everywhere:

- A decision-log line (`logs/decisions.jsonl` or an archived quarter) whose ticker does not parse is
  skipped with a console warning by every reader.
- A `benchmark` whose ticker does not parse is dropped from its decision-log line with a console
  warning, and the decision is kept.

Numbers in tables accept European (`1.234,56 €`) or US (`$1,234.56`)
notation. `—`, `-` or `TBD` mean "no value".
A number too large to count in cents (`1e307`) is also read as "no value", but the
heartbeat names it: a `Positions` `P/L` (read as 0, the row is still watched), `Available cash` (0) or
`Total cash` (absent) holding one is reported in the digest, in every run while it lasts. An `Entry costs`
cell that large makes its `Lots` row skipped (see below). No `schema_version` change.

## `portfolio.md`

Synced by hand from the broker, except `Lots` and `Positions`, which `decision:record` writes
when you record a trade (see below). One `Cash`, one `Positions` and one `Lots`
section per currency (`EUR`, `USD`), with an em dash, en dash or hyphen between
currency and section name. A section ends at the next `##` heading or `---` rule.

```markdown
---
schema_version: 2
last_manual_sync: 2026-10-05T18:00:00Z
account_env: demo
---

## EUR — Cash

| Item           | Value      |
| -------------- | ---------- |
| Available cash | 1.200,00 € |
| Total cash     | 1.572,80 € |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L   | Stop loss |
| ------ | ------ | --------- | ------------- | ----- | --------- |
| SAP.DE | 2      | 180,00    | 186,40        | 12,80 | 168,00    |

## EUR — Lots

| Ticker | Entry id                     | Date       | Units | Entry units | Entry price | Initial stop | Entry costs | Origin  | Rules version | Rules violations |
| ------ | ---------------------------- | ---------- | ----- | ----------- | ----------- | ------------ | ----------- | ------- | ------------- | ---------------- |
| SAP.DE | 20260915-sapde-entry-example | 2026-09-15 | 2     | 2           | 180,00      | 168,00       | —           | sistema | 1.0           | —                |
```

Frontmatter:

| Field              | Required | Meaning                                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `schema_version`   | yes      | `2`. A file at `1` (without `Lots`) is refused: there is no reading of v1 and no migration    |
| `last_manual_sync` | no       | ISO timestamp of the last sync; the engine warns when it is older than `PORTFOLIO_STALE_DAYS` |
| `account_env`      | no       | `demo` or `real`; recorded with each decision                                                 |

The v1 to v2 change is incompatible and ships without a migration script: the
owner is the only user, and rewrites the file by hand (an owner-approved
exception to the rule above; see
[ADR-0015](decisions/0015-open-lots-live-in-the-portfolio.md)).

The three sections are required for each currency; a missing one is an error
rather than an empty silo. Cash rows, matched by the first cell
(case-insensitive); other rows are ignored:

| Row              | Required                  | Meaning                                                                                                |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Available cash` | yes (missing row → error) | Cash free to trade today. Not a number (`TBD`, `—`) → 0                                                |
| `Total cash`     | no                        | Account cash including what pending orders hold; used for the silo value. Defaults to `Available cash` |

Positions table: the first row is the header and columns are read **by
name** (case-insensitive), in any order. All six are required; a missing one
is an error. Extra columns are ignored.

| Column          | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `Ticker`        | Yahoo Finance symbol                                        |
| `Volume`        | Units held; fractions allowed. The sum of its lots' `Units` |
| `Avg price`     | Average entry price                                         |
| `Current price` | Rewritten by the engine on each heartbeat                   |
| `P/L`           | Rewritten by the engine on each heartbeat                   |
| `Stop loss`     | Active stop, or `—`                                         |

Rows whose ticker is empty, `—` or `-`, or whose `Volume` or `Avg price` is not a
number, are skipped.

Lots table: one row per open [lot](glossary.md#lot), the units of one ticker
bought in a single entry. `decision:record` writes it: an entry adds a row, a
sale shrinks the rows it consumes, first in, first out, and removes a row whose
`Units` reach 0 (its history lives in the `exit` lines of the decision log). You
only edit it by hand to correct it, in a correction commit (a split, a partial
fill, a recording mistake). The first row is the header and columns are read
**by name** (case-insensitive), in any order. All eleven are required; a missing
one is an error. An empty table (header only, or `—` rows) is a silo with no
open lots.

| Column             | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `Ticker`           | Ticker of the position the lot belongs to; the one of its entry in the decision log              |
| `Entry id`         | Id of the `entry` line in the decision log that opened the lot                                   |
| `Date`             | Entry date, `YYYY-MM-DD`                                                                         |
| `Units`            | Units of the lot still open                                                                      |
| `Entry units`      | Units the entry bought                                                                           |
| `Entry price`      | Price of the entry                                                                               |
| `Initial stop`     | Stop at entry, the base of R; `—` if there was none                                              |
| `Entry costs`      | Costs of the entry in the silo currency; `—` if none                                             |
| `Origin`           | `sistema` or `propietario`                                                                       |
| `Rules version`    | `version` of `strategies/base.md` in force at the entry                                          |
| `Rules violations` | The rules the entry broke, comma-separated (for example `no_stop, overrode_block`); `—` for none |

The `exit` lines `decision:record` writes for a sale carry, per lot, an `amount`
that is that exit's exact share of the sale amount and can have sub-cent
decimals (owner decision of 2026-10-22 in #27). When the owner gives only the
units, the sale amount derived (`units × price`) is to the cent unless that
rounds to 0.00, and then it is exact.

A row of `—` (or empty cells) and a repeated header are not lots and are ignored.
Any other row that does not read as a lot is **skipped**: it does not count towards
its position's `Volume`, and the lots check reports it with its row number, its `Ticker` and
`Entry id` (when it has them) and the reason, for example
`portfolio.md (USD): Lots row 2 (XOM, xom-1): Origin "Sistema" is not sistema or propietario (write it "sistema"); the row is skipped`.
The reasons:

- no `Entry id`, or no `Ticker`;
- `Units`, `Entry units` or `Entry price` is not a number (including empty);
- `Origin` is not `sistema` or `propietario`. It matches exactly, in lower case,
  because it is compared with the entry's in the decision log, which writes it so;
  the message says which case to write. (Column headers, which you type, match any case);
- `Entry costs` is a number too large to count in cents (`1e307`; the reason reads `Entry costs "1e307" is too large to count in cents`);
- `Date` is not `YYYY-MM-DD`;
- `Rules version` is empty, `—` or `-` (`TBD` is kept as text and reads as a version).

A skipped row is a problem like any other of the checks below: some commands refuse the silo,
naming it, and the heartbeat warns.
A missing column is an error, not a skipped row: a file written before the
`Ticker` column existed is refused with `add a "Ticker" column, first, to
"## <CCY> — Lots"`.

A table can be split by blank lines or notes: the first table line of a section is
its header and the other table lines are its rows, wherever they are. The engine
reads it as one table. When `decision:record` writes the `Lots` and `Positions` rows of a silo, the
rows of that table end up in one block, with a note that sat between them moved under the table
and the blank lines that split it dropped. The heartbeat updates the `Current price` and `P/L` cells
of the `Positions` rows it prices and upper-cases their `Ticker`; the other rows stay in place.

When one lot of a silo changes, `decision:record` rebuilds the whole `Lots` table of that silo from
the lots it read, so the rows it did not touch come back rewritten: one space around each cell,
the ticker in upper case, any column you added to the header set to `—`, an `Initial stop` or
`Entry costs` cell that is not a number (`TBD`, `-` or `N/A`, for example) written as `—` (`Rules version` and `Rules violations` keep `TBD` as
text; only an empty cell, `—` or `-` is a placeholder there, and a `Rules violations` placeholder is
written as `—`), `Rules violations` joined with `, `, and every number written in the silo's
notation, with no thousands separator and no currency symbol (`1.234,50 €` in a EUR silo comes back
as `1234,50`; at least 2 decimals for prices and costs and up to 8, with no minimum for units).
Placeholder rows of `Lots` (`—` or empty cells, a repeated header) are dropped, since the table is
rebuilt from the lots.

The `Positions` table of the same silo keeps its rows' cells as written, except that each cell has
one space around it and the placeholder rows (`—`, `-` or an empty ticker, a repeated header) are dropped; only the row of
the ticker the trade is about is changed, as described next.

`decision:record` also keeps `Positions`: the first entry of a ticker creates
its row, with the lot's initial stop as `Stop loss` (`—` if there was none);
later entries and sales only change `Volume` and `Avg price` (the units-weighted
entry price of the open lots), and the row is deleted when the last lot is
consumed. Recording a trade needs `portfolio.md`; without it an entry or a sale
is refused. A ticker is on one `Positions` row: the lots check refuses a
silo that has the ticker on several (merge them into one row; see below), and the
heartbeat warns of it, while it prices every row of a ticker (the `Volume` check sums them all). `decision:record`
reads `portfolio.md` again right before it writes, after the market-data calls,
and applies its change to that text, so a write made to the file meanwhile on the
same checkout (the owner's editor) is not lost; if the `Lots` changed meanwhile it
refuses and records nothing. A write on another checkout is a git conflict, which
stays visible ([ADR-0015](decisions/0015-open-lots-live-in-the-portfolio.md)).

The amount of a sale is shared across the lots it consumes to 8 decimals, so a lot whose
share is under the [dust limit](glossary.md#money) gets an `amount` of 0 and cannot be sold
(`DUST_LIMIT` in `src/money.ts`).
Sharing these exact amounts is exact up to about 90 million of the silo currency; beyond
that the total itself is no longer exact. Amounts in reports and emails mostly go through one
shared money formatting (`formatMoney` in `src/money.ts`), but a few places (the digest P/L, the
sizing ticket, the Monday briefing) write numbers their own way; locale formatters remain for
prices, stops and profit and loss: `fmtEU` (`src/utils/portfolio-writer.ts`) for the `Current price` and `P/L`
cells the heartbeat writes in `portfolio.md`, always in German notation (`1.234,56`) whatever the
silo's notation, and `formatNumber` (`src/i18n/index.ts`) for the prices, stops and profit and loss
of the heartbeat digest and for the R multiples of the charts
([ADR-0017](decisions/0017-money-is-a-domain-value-in-whole-cents.md)).

The lots must add up to the positions and agree with the decision log
(`logs/decisions.jsonl` and any archived quarter). A silo is **inconsistent**
when:

- a ticker is on several `Positions` rows (the message names the ticker and the
  rows as written, `tck` and `TCK` being the same ticker; merge them into one row);
- a position's `Volume` is not the sum of the `Units` of its lots (a position
  with no lots, or lots of a ticker with no position row, count too). A ticker
  with a `Lots` row that does not read gets only the message of that row: fix it
  first, the `Volume` and "no lot" messages that follow from it are left out;
- a lot has more `Units` than `Entry units`, or an `Entry id` is on two rows;
- a lot's `Entry id` is not an `entry` of that currency in the decision log, its
  `Ticker` is not the ticker of that entry, or its entry price, entry units,
  initial stop, entry costs (to the cent; a value against an empty cell is a
  difference), date, origin, rules version or rules violations differ from the
  entry's. The `Entry costs` of a lot are the whole entry's, also after a split
  or a partial sale. To correct them, correct the entry's line in the decision
  log too, in a correction commit ([ADR-0006](decisions/0006-single-append-only-decision-log.md));
  or
- an entry in the decision log is still open and has no lot. An entry is open
  until an exit that cites it has `lot_units_left` 0. An entry whose log line has
  no `units` was recorded before the lots existed and is not checked
  (`decision:record` writes `units` on every entry).

Where portfolio and log are both read, `decision:record` and `decisions:evaluate` refuse an
inconsistent silo with an error naming the ticker and the entry id; fix `Lots` by hand. The
heartbeat does not read the decision log: it only checks `Volume` against the lots, and it does
not refuse the file either. It keeps watching the positions (stops, `Volume`, `Avg price`) and raises
a warning in its output and in the digest, because a typo must not switch off
the stop alerts. That includes a `Lots` table that does not read (a misspelled or
missing column in its header) and a `Lots` section that is missing (a misspelled
heading, or a deleted empty section): the warning names `portfolio.md` and the
section (`## USD — Lots`), and the lots count as empty for that run. The warning
is not deduplicated: it is in every digest while the problem lasts. A missing
`Cash` or `Positions` section still stops the heartbeat, as every other problem of
the file. `decision:record` (for every decision type, including a deposit or an
`adjust_stop`, which read the lots before looking at the type) and
`decisions:evaluate` keep the strict reader: they refuse a `Lots` table or
section that does not read. `pending:resolve`, the Monday briefing and the weekly
screening use positions, cash and silo value only, so they read the file like the
heartbeat and carry on with the lots counted as empty; unlike the heartbeat, they
send no warning.

A stock split is corrected by hand, in a correction commit, by scaling the lot
by one ratio r > 0: `Units` and `Entry units` × r, `Entry price` and
`Initial stop` ÷ r (a 2:1 split doubles the units and halves the prices). The
check accepts a lot whose `Entry units`, `Entry price` and `Initial stop` differ
from its entry in the decision log by one such common ratio, and refuses any
other difference: only the units scaled, or the units and the price by
different ratios, or a stop that was not scaled. The check cannot tell a wrong
ratio from a right one, nor a split from a sale that was written to the
decision log but not to `portfolio.md` (a stop between the two files); you
catch both when you reconcile `Volume` with the broker.

Write the split-adjusted `Entry price` and `Initial stop` at full precision
(the original ÷ r, not rounded to the cent): the check compares them with the
original within a tolerance of 1e-6, and the exits of a lot sold before and
after the split are measured as one trade only if their snapshots differ by that
same ratio.

To correct a mistaken entry (a wrong ticker, price or units), the entry line
stays in the decision log, so a lot deleted by hand would leave the silo
refused (an open entry with no lot). Correct it in a correction commit
([ADR-0006](decisions/0006-single-append-only-decision-log.md)): fix or remove the entry's
line in `logs/decisions.jsonl` (the ADR's dedicated commit, made when no
automated run is in flight) together with its lot in `Lots` and `Volume` in
`Positions`, in the same commit, so the log and the portfolio agree again.

## `state/portfolio.json`

The engine's [store](glossary.md#store) of the portfolio: cash, positions and lots of each silo it has, as JSON that
only the engine writes. **Do not edit it**, and do not edit `portfolio.md` either: `inbox:ingest` and the flows that
refresh prices write the store and generate `portfolio.md` from it, overwriting what is there. To change the portfolio,
drop a batch of commands in `inbox/` ([below](#inboxyaml)). Commit `state/` with the rest of the data directory.

```json
{
  "schema_version": 1,
  "account_env": "demo",
  "unmoved_batches": [],
  "pending_decisions": [],
  "silos": {
    "EUR": {
      "synced_at": "2026-11-12T09:00:00.000Z",
      "cash": "1049.00 EUR",
      "positions": [
        {
          "ticker": "SAP.DE",
          "volume": "2",
          "avg_price": "100",
          "current_price": "100",
          "pl": "0.00 EUR",
          "stop_loss": "90"
        }
      ],
      "lots": [
        {
          "entry_id": "20260915-sapde-entry-1d3e4b2e",
          "ticker": "SAP.DE",
          "date": "2026-09-15",
          "units": "2",
          "entry_units": "2",
          "entry_price": "100",
          "initial_stop": "90",
          "entry_costs": "1.50 EUR",
          "origin": "propietario",
          "rules_version": "1.4",
          "rules_violations": []
        }
      ]
    }
  }
}
```

Numbers are plain decimal text, never an exponent (`0.00000001`, not `1e-8`), and every amount of money is its
number and its currency (`1049.00 EUR`, whole cents, the silo's own currency); prices, units and stops carry no
currency, the silo's is theirs. A silo the portfolio does not have is absent. `synced_at` is when a command last
changed the silo. `unmoved_batches` and `pending_decisions` are what a run that stopped halfway left for the next
one: the batches applied whose files are still in `inbox/`, and the decision-log lines of their trades not yet in
`logs/decisions.jsonl`. The reader is strict: a number that is not plain decimal, an amount in another currency, a
ticker that does not parse or another `schema_version` is refused, naming the file and the field, instead of read
partially.

**`portfolio.md` is generated from the store** in the tables of the format above (`Cash`, `Positions` and `Lots`
per silo, EUR numbers with the decimal comma, USD with the point), with a note that it is generated. Nothing reads
it as a source. While there is no store, `portfolio.md` is the state as before; the first `inbox:ingest` makes the
store from it (it must read whole: a row that does not read is refused, not dropped), and from then on edits to
`portfolio.md` are overwritten. Starting from scratch needs no `portfolio.md`: without one, and without a store,
every command is refused for having no silo. This slice was approved by the owner on 2026-11-05 in
[#132](https://github.com/alvaromongon/finance-agent/issues/132) for agent work, without a migration, as the rest of
the inbox format (see [#124](https://github.com/alvaromongon/finance-agent/issues/124)).

## `inbox/*.yaml`

The [inbox](glossary.md#inbox) is the `inbox/` folder of the project directory. Each `.yaml` or `.yml`
file in it is one [batch](glossary.md#batch) of [commands](glossary.md#command) that the owner, an AI or a
routine writes; other files there are not batches and are ignored. `npm run inbox:check` reads the batches
and checks them against the current portfolio without writing anything; `npm run inbox:ingest` applies them,
all or nothing per batch: a clean one changes the [store](#stateportfoliojson) and moves to `inbox/applied/`, a
refused one changes nothing and moves to `inbox/rejected/` with `<file>.errors.txt` beside it, one line per error
(`command <n>, line <l>: <reason>`). The two run the same code, so they accept and refuse the same batches. The
engine never edits a batch. A name already taken in `applied/` or `rejected/` gets a counter
(`2026-11-12-2.yaml`), so a file dropped again is a new batch and is applied again. It is a new file in the format,
so it has no earlier version to migrate from: the format shipped without a migration, approved by the owner on
2026-11-03 in [#131](https://github.com/alvaromongon/finance-agent/issues/131) because nobody uses the system yet.

```yaml
schema_version: 1
commands:
  - command: deposit
    amount: 1000.00 EUR
  - command: buy
    ticker: SAP.DE
    date: 2026-09-15
    units: 2
    price: 180.25 EUR
    costs: 1.50 EUR
  - command: set_stop
    ticker: SAP.DE
    price: 168 EUR
  - command: sale
    ticker: SAP.DE
    date: 2026-09-20
    units: 1
    price: 190 EUR
    stop_executed: false
  - command: withdrawal
    amount: 200.00 EUR
```

`schema_version` is required and is `1`: a file without it, or with another version, is one error and is
not read further. The only other top-level field is `commands`, a list with at least one command. Every
value is read as text, never as a YAML number or date, so the rules below are the same for all of them.

An **amount** is a plain decimal number and its currency, separated by a space: `1000.50 EUR`. The number is
digits with an optional decimal point: no sign, no thousands separator, no comma as the decimal mark and no
exponent (`1e3`, `1,000.50`, `-5` and `.5` are errors). The currency is `EUR` or `USD`; an amount without a
currency, or with another one, is an error. Money amounts (`amount`, `costs`) have at most two decimals and are
greater than zero; prices (`price`) may have more decimals. The `units` are a plain decimal number
without a currency. A `date` is a calendar date, `YYYY-MM-DD`. A [ticker](glossary.md#ticker) follows the rule
under _Versioning_ above, as narrowed in #93: it is checked once, when the batch is read, and read
case-insensitively.

| Command      | Required fields                    | Optional fields                 | What it checks and does                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deposit`    | `amount`                           |                                 | Adds to the cash of the amount's currency.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `withdrawal` | `amount`                           |                                 | Refused if it exceeds the available cash of its currency.                                                                                                                                                                                                                                                                                                                                                                                           |
| `buy`        | `ticker`, `date`, `units`, `price` | `costs`                         | Refused if `units × price + costs` exceeds the available cash of its currency. Also refused if it costs less than half a cent (it rounds to zero cents) or has fewer units than 1e-8. Opens a lot; buying a ticker already held is a scale-in. It has no `stop`: a batch that gives one is refused, with an error that names `set_stop`.                                                                                                            |
| `sale`       | `ticker`, `date`, `units`, `price` | `costs`, `lot`, `stop_executed` | Refused if the ticker has no open lot, or fewer open units than sold, if its costs exceed its proceeds, or if its proceeds round to zero cents (under half a cent), unless it uses up every remaining unit of each lot it sells: that sale credits 0.00 and closes every lot it sells, which is how a dust lot is removed. Sells oldest lot first, or only the lot whose entry id is `lot`. `stop_executed: true` marks a stop the broker executed. |
| `set_stop`   | `ticker`, `price`                  | `date`                          | Sets or moves the one stop of a position, in the currency of `price`. Refused if the ticker has no open position after the commands before it in the batch.                                                                                                                                                                                                                                                                                         |
| `clear_stop` | `ticker`                           | `date`                          | Removes the stop of a position; it has no amount, so it acts on every silo that holds the ticker with a [stop](glossary.md#stop) (the warning names them). Refused if the ticker has no open position or none has a stop.                                                                                                                                                                                                                           |

**A stop is its own command.** A position has one [stop](glossary.md#stop), and a buy never changes it.
The initial stop of a lot (the base of [R](glossary.md#r)) is the stop of the position right after the batch
that holds the buy: the price of a `set_stop` for that ticker in the same batch (after the buy, so the
buy is checked first), else the stop the position already had, else none, and then the buy carries the
`no_stop` rule violation when the batch is applied. A `set_stop` gives that initial stop only to the lots
its own batch opened before it; the lots already open keep theirs, so moving a stop never rewrites an
earlier R.

That initial stop must be below the entry price of its lot, so that R is never zero or negative: a batch
where a lot it opened would end with an initial stop at or above its entry price is refused, whether the
stop comes from a `set_stop` of the batch or, in a scale-in with no `set_stop`, from the stop the position
already had. One error per `set_stop` (or per position, when the stop is not the batch's) names the lots it
breaks, their entry prices and the stop, and where it comes from: the `set_stop`, a command of an earlier file, or
`portfolio.md`. A `set_stop` above the entry price of a position with no lot opened in the batch is accepted:
that is a trailing stop.
The rule was approved by the owner on 2026-11-10 in [#159](https://github.com/alvaromongon/finance-agent/issues/159),
without a migration. `inbox:check` and `inbox:ingest` warn, without failing, about every position a batch touches (by a
buy, a sale, a `set_stop` or a `clear_stop`) that ends with no stop, naming its silo; a stop that is not above zero is
no stop (the one definition the stop checks and the heartbeat digest share). The digest names every position without
a stop in every run while it lasts.

**What a buy and a sale write.** A lot opened by a buy gets its `Entry id` from the one source of decision ids
(`20260915-sapde-entry-1d3e4b2e`: date, ticker, type and a suffix), never an id the whole decision history holds, closed
lots included, and the `Rules version` of `strategies/base.md` in force; a lot with no initial stop carries the rule
violation `no_stop`. A sale takes the entry costs earlier exits already took of each lot, so the exits of a lot add up
to its `Entry costs`. A sale dated before the buy of a lot it would consume is refused (the same day is allowed), in
`check` and in `ingest`, and the `lot` of a sale must look like an entry id (letters, digits, `.`, `_` and `-`).
`inbox:ingest` also appends the decision-log line of each trade (`source: portfolio-sync`): an `entry` per buy, with the
lot's `Entry id` as its id, and an `exit` per lot a sale touched, as `decision:record` writes them, so the two read
one history. A sale whose proceeds round to 0.00 (it must use up every lot it touches) credits 0.00 and records the
exact amounts of its exits (their sum is the exact proceeds, not the cash credited); an exit whose share of the
proceeds is 0 is not recorded as a decision (it needs an amount above zero) and its lot is closed all the same. Cash
flows and `set_stop` are not written to the decision log.

**The folder is not trusted.** A batch must be a regular file: a symbolic link (or a folder or named pipe with a batch's
name) is never followed or read, and is reported, by `check` and `ingest`, as an error that names it; `ingest` leaves
it in `inbox/` and still applies the others (a later file that could depend on it is listed as not checked, like one
that depends on a rejected file). A symbolic link as `inbox/` itself, or as `inbox/applied/` or `inbox/rejected/`, is
refused, and a file name from the folder is never joined into a path before it is checked to be a plain file name.

```yaml
commands:
  - command: buy
    ticker: SAP.DE
    date: 2026-09-15
    units: 2
    price: 180.25 EUR
  - command: set_stop # the initial stop of the lot just bought
    ticker: SAP.DE
    price: 168 EUR
```

The stop rule and this command set were approved by the owner on 2026-11-05 in
[#151](https://github.com/alvaromongon/finance-agent/issues/151), without a migration, as the rest of the
inbox format (above).

All the amounts of one command are in the same currency, and the command acts on that currency's silo only.
An unknown field is an error, so a misspelt optional field is never silently ignored.

The commands of a batch are checked in order, each against the state the previous ones would produce, so a
buy followed by its sale in one batch is valid. The files of the inbox are checked in name order, each
against the state the clean batches before it would produce; a batch with errors contributes nothing.
`inbox:check` reports every error of every batch, not only the first, each as the file, the command (its
position in the batch, from 1), the line in the file where the command starts and the reason. The exit code is
non-zero when there is any error and zero when the inbox is clean or empty. A file that is not valid YAML is
reported as one error, with the line the YAML reader gives. A command that does not read, or that a handler
refuses, leaves the cash and lots of its currency unknown (a `set_stop` or `clear_stop` that fails, only the
stop of its ticker), so the later commands that depend on it are not checked against them: each is listed as
not checked, with the command that blocked it, and is not an error. A refusal that a rejected file before it
could explain (by the cash, the lots or the stop it would have changed) is listed the same way, as depending on
that file. Fixing the errors listed can reveal an error in a command listed as not checked, and an initial-stop
error in a currency a refusal blocked. Names and reasons taken from the file are
printed escaped, never as raw control characters. The YAML is read with the failsafe schema: every value is text.

## `watchlist.md`

Assets the heartbeat scans for entry setups, in the first ` ```yaml ` block.
The file starts with the frontmatter (`schema_version: 1`).

```yaml
watchlist:
  - ticker: AMD
    name: Advanced Micro Devices
    market: NASDAQ
    currency: USD # EUR | USD
    horizon: medium # short | medium
    asset_class: equity # equity | commodity | etf (default equity)
    thesis: >-
      One-paragraph thesis.
    thesis_link: "[[tesis-amd]]" # optional; its `created` date is the watchlist entry date
```

## `screening-universe.md`

The universe the weekly screening ranks, in the first ` ```yaml ` block, with
three pools:

```yaml
universe:
  eur:
    - ticker: AI.PA
      name: Air Liquide
      market: Euronext Paris
      currency: EUR
  usd: [...]
  commodities:
    - ticker: 4GLD.DE
      name: Xetra-Gold
      market: Xetra
      currency: EUR
      asset_class: commodity
```

`eur` and `usd` are required. Frontmatter `next_review` (date, optional) makes
the screening remind you to review the universe once it has passed.

## `screening-log.md`

One row per screened asset, appended by the screening. The engine creates the
file with this header if it does not exist.

```markdown
---
schema_version: 1
---

| Ticker | Name  | Index   | Date       | Result          | Summary  | Next review |
| ------ | ----- | ------- | ---------- | --------------- | -------- | ----------- |
| AAPL   | Apple | S&P 500 | 2026-06-28 | not_interesting | High P/E | 2026-08-28  |
```

| Column        | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `Date`        | Screening date, `YYYY-MM-DD`                                                     |
| `Result`      | `interesting` or `not_interesting`; any other value is an error                  |
| `Next review` | Date before which a `not_interesting` asset is not screened again; `—` otherwise |

## `tesis/tesis-<slug>.md`

One thesis per asset, created by the screening and editable by hand.
`<slug>` is the ticker in lower case without dots. The body is free text.

| Frontmatter field | Meaning                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`  | `1`                                                                                                                          |
| `status`          | `active` or `archived` (set when the asset leaves the watchlist)                                                             |
| `created`         | Creation date                                                                                                                |
| `exit_criteria`   | `pending` while the invalidation criteria are missing; the screening reminds you until you fill them in and remove the field |

## Files the engine writes and reads back

Their parsed parts are part of the format and are never localized.

- **Decision logs** `logs/<YYYY-MM-DD>-<ticker>.md`: the re-analysis cooldown
  reads `price`, `triggers` (list of trigger kinds) and `blocked` from the
  frontmatter. The body is output.
- **Monday Briefing report**: the reasoning model ends it with a machine
  section that the engine parses:

  ```markdown
  ## AUTOMATED_ACTIONS

  RETIRE: TICKER1,TICKER2
  PLAN_SUMMARY: One-sentence plan summary
  PROPOSALS: [{"ticker":"MSFT","action":"ADJUST_STOP","conviction":"medium"}]
  ```
