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

| File                                   | Versioned                   | Version | Parsed parts                                                     |
| -------------------------------------- | --------------------------- | ------- | ---------------------------------------------------------------- |
| `portfolio.md`                         | yes                         | **2**   | Frontmatter, `Cash`, `Positions` and `Lots` tables per currency  |
| `state/portfolio.json`                 | yes (written by the engine) | **1**   | All of it: the engine's store of the portfolio                   |
| `telemetry/prices-<ccy>.json`          | yes (written by the engine) | **1**   | All of it: the last prices of a silo (not state, #133)           |
| `inbox/*.yaml`                         | yes                         | **1**   | Frontmatter-less YAML: `schema_version` and `commands`           |
| `watchlist.md`                         | yes                         | 1       | First ` ```yaml ` block: seeds the store, then generated from it |
| `screening-universe.md`                | yes                         | 1       | Frontmatter, first ` ```yaml ` block                             |
| `screening-log.md`                     | yes                         | 1       | The table                                                        |
| `tesis/tesis-<slug>.md`                | yes                         | 1       | Frontmatter                                                      |
| `logs/<YYYY-MM-DD>-<ticker>.md`        | no (written by the engine)  | -       | Frontmatter                                                      |
| `strategies/base.md`                   | no                          | -       | Frontmatter `version` (rules version) and text                   |
| `portfolio-policy.md`, `routines/*.md` | no                          | -       | Text only, passed to the reasoning model                         |

Files that are only passed to the model as text are not parsed, so they carry
no `schema_version`.

Each flow that reasons needs its own prompt in `routines/`. There are no
built-in defaults: a missing prompt fails with the example to copy.

| Prompt                           | Required by                                                                                                       | Example                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `routines/monday-briefing.md`    | `monday-briefing:prepare` (system prompt of the weekly report)                                                    | [`examples/brain/routines/monday-briefing.md`](../examples/brain/routines/monday-briefing.md)       |
| `routines/weekly-screening.md`   | `screening:prepare` (system prompt of each candidate)                                                             | [`examples/brain/routines/weekly-screening.md`](../examples/brain/routines/weekly-screening.md)     |
| `routines/execution-analysis.md` | `heartbeat` whenever it escalates a signal (system prompt of the reasoner, `ANALYST_PROVIDER` `api` or `handoff`) | [`examples/brain/routines/execution-analysis.md`](../examples/brain/routines/execution-analysis.md) |

`pending:list`, `pending:show`, `pending:record`, `decisions:evaluate`, `screening:outcomes`, `outbox:send` and
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
`pending:record`, the Monday briefing, the weekly screening), while some commands, those that must
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

Synced by hand from the broker. It is the state only until the first `inbox:ingest` makes the
[store](#stateportfoliojson) from it; from then on it is generated from the store, and a buy, a sale or a
cash flow is told to the engine with a batch in `inbox/` ([below](#inboxyaml)). One `Cash`, one `Positions` and one `Lots`
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

| Field              | Required | Meaning                                                                                                                                                                                                                                                             |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | yes      | `2`. A file at `1` (without `Lots`) is refused: there is no reading of v1 and no migration                                                                                                                                                                          |
| `last_manual_sync` | no       | ISO timestamp of the last sync; while there is no store the engine warns when it is older than `PORTFOLIO_STALE_DAYS`. With the store, staleness is that of the latest `snapshot` instead (see _Staleness_ below), and this field of the generated view is not read |
| `account_env`      | no       | `demo` or `real`; recorded with each decision                                                                                                                                                                                                                       |

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
bought in a single entry. With the store, `inbox:ingest` keeps it: a buy adds a row, a
sale shrinks the rows it consumes, first in, first out, and removes a row whose
`Units` reach 0 (its history lives in the `exit` lines of the decision log). Before
the store exists you write it by hand, once, for the first `inbox:ingest` to read; a
correction later is a correction commit (a split, a partial fill, a recording
mistake, below). The first row is the header and columns are read
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

The `exit` lines `inbox:ingest` writes for a sale carry, per lot, an `amount`
that is that exit's exact share of the sale amount and can have sub-cent
decimals (owner decision of 2026-10-22 in #27). The sale amount (`units × price`)
is to the cent unless that rounds to 0.00, and then it is exact. The `amount` of an
exit is the one amount the decision log accepts as 0: the exit of a lot whose
share rounds to nothing at 8 decimals (a dust lot) is recorded with an `amount` of
0, so the lot is closed in the log as it is in the state, and no `entry` stays open
in it (#152).

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
reads it as one table. The heartbeat updates the `Current price` and `P/L` cells
of the `Positions` rows it prices and upper-cases their `Ticker`; the other rows stay in place.

A ticker is on one `Positions` row: the lots check refuses a
silo that has the ticker on several (merge them into one row; see below), and the
heartbeat warns of it, while it prices every row of a ticker (the `Volume` check sums them all).

The amount of a sale is shared across the lots it consumes to 8 decimals, so a lot whose
share is under the [dust limit](glossary.md#money) gets an `amount` of 0 (recorded as such, above).
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
  (the inbox writes `units` on every entry).

Where portfolio and log are both read, `decisions:evaluate` refuses an
inconsistent silo with an error naming the ticker and the entry id; with the store the lots change
only through `inbox/`, so the way to correct them is a batch (without the store, fix `Lots` by hand).
`inbox:check` and `inbox:ingest` read the portfolio whole too (without the log) and refuse one whose
`Volume` is not the sum of its lots. The
heartbeat does not read the decision log: it only checks `Volume` against the lots, and it does
not refuse the file either. It keeps watching the positions (stops, `Volume`, `Avg price`) and raises
a warning in its output and in the digest, because a typo must not switch off
the stop alerts. That includes a `Lots` table that does not read (a misspelled or
missing column in its header) and a `Lots` section that is missing (a misspelled
heading, or a deleted empty section): the warning names `portfolio.md` and the
section (`## USD — Lots`), and the lots count as empty for that run. The warning
is not deduplicated: it is in every digest while the problem lasts. A missing
`Cash` or `Positions` section still stops the heartbeat, as every other problem of
the file. `decisions:evaluate` keeps the strict reader: it refuses a `Lots` table or
section that does not read. `pending:record`, the Monday briefing and the weekly
screening use positions, cash and silo value only, so they read the file like the
heartbeat and carry on with the lots counted as empty; unlike the heartbeat, they
send no warning.

With the store, a split is the `split` command of a batch (see _`inbox/*.yaml`_, below), which scales the lots and the
position for you and writes a `split` line in the decision log. Only while there is no store, and the state is still
this `portfolio.md`, is a stock split corrected by hand, in a correction commit, by scaling the lot
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
only the engine writes. **Do not edit it**, and do not edit `portfolio.md` either: `inbox:ingest` is the only flow that
writes the store (the heartbeat and the Monday briefing write no state: [prices are telemetry](#telemetryprices-ccyjson)), and it
generates `portfolio.md` from it, overwriting what is there. To change the portfolio,
drop a batch of commands in `inbox/` ([below](#inboxyaml)). Commit `state/` with the rest of the data directory. The `current_price` and `pl` of a position are as the last command left them
(a buy's price, a snapshot, a split's adjustment); the flows read the last prices over them, from telemetry.

`decision:record` no longer records a buy or a sale (#152): they are told to the engine with a `buy` or a `sale`
command in a batch, the only way a trade is recorded; `entry` and `exit` are refused there with a message that names
the command. What it still records, with the store, writes the store, never the cell of `portfolio.md`: a deposit and a
withdrawal move the cash. A currency [conversion](glossary.md#conversion) is no longer told there (#135): it is the `convert` command of a batch,
and `decision:record` refuses an `fx_conversion` with a message that names it. As the inbox does, it refuses (before
anything is recorded) a movement that would take the cash of a silo below zero. A stop change is `set_stop` in a batch
(`adjust_stop` only writes the log line).

```json
{
  "schema_version": 1,
  "account_env": "demo",
  "unmoved_batches": [],
  "pending_decisions": [],
  "resolved_rejections": [],
  "closed_escalations": [],
  "silos": {
    "EUR": {
      "synced_at": "2026-11-12T09:00:00.000Z",
      "reconciled": {
        "date": "2026-11-12",
        "differences": [
          { "kind": "cash", "broker": "1052.00 EUR", "engine": "1049.00 EUR" },
          { "kind": "position", "ticker": "KO", "broker": "3", "engine": "0" }
        ]
      },
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
changed the silo. `reconciled` is the latest `snapshot` of the silo (#138), written by `inbox:ingest`: the day it is as of
and each difference it found (empty when the broker and the engine agree); a silo that was never reconciled has none
(an optional field of version 1: a store without it is a silo with no snapshot). `unmoved_batches` and `pending_decisions` are what a run that stopped halfway left for the next
one: the batches applied whose files are still in `inbox/`, and the decision-log lines of their trades not yet in
`logs/decisions.jsonl`. `resolved_rejections` lists the [rejected batches](glossary.md#rejected-batch) that a later batch
replaced or discarded (`file`, the `sha256` of its text, `how`, the batch that settled it as `by`, and `at`): a file of
`inbox/rejected/` not listed there still awaits an answer (a store without the field settled none). `closed_escalations` lists the [pending escalations](glossary.md#pending-escalation) a `resolve` command closed (see _A pending escalation is closed by a command_, below); a file of `logs/pending/` not listed there is still open (a store without the field closed none). `starting_silos` (optional, #139) is the `silos` as the store began, from `portfolio.md`: what a correction and the repair apply the batches of `inbox/applied/` over (a store without it began empty). A cash flow told with `decision:record` is in no batch, so a log that holds one is refused by the repair, which changes nothing. The reader is strict: a number that is not plain decimal, an amount in another currency, a
ticker that does not parse or another `schema_version` is refused, naming the file and the field, instead of read
partially.

**`portfolio.md` is generated from the store** in the tables of the format above (`Cash`, `Positions` and `Lots`
per silo, EUR numbers with the decimal comma, USD with the point), with a note that it is generated. Nothing reads
it as a source. While there is no store, `portfolio.md` is the state as before; the first `inbox:ingest` makes the
store from it (it must read whole: a row that does not read is refused, not dropped), and from then on edits to
`portfolio.md` are overwritten. Starting from scratch needs no `portfolio.md`: without one, and without a store,
the first `deposit` of a currency creates its silo (see the `deposit` command below) and any other command is refused for having no silo. This slice was approved by the owner on 2026-11-05 in
[#132](https://github.com/alvaromongon/finance-agent/issues/132) for agent work, without a migration, as the rest of
the inbox format (see [#124](https://github.com/alvaromongon/finance-agent/issues/124)).

### The watchlist in the store

The [watchlist](glossary.md#watchlist) is engine state too (#140): `watchlist` holds its entries (`ticker`, `currency`, `horizon`,
`thesis`, and when they have them `asset_class`, `name`, `market`, `thesis_link` and `date`, the day the entry joined) and
`starting_watchlist` the entries the store began with, from `watchlist.md`: what a correction and the repair replay the `watch` and
`stop_watching` commands over, as `starting_silos` is for the silos. A ticker is on the list once. The two fields come
together (a store with one and not the other is refused) and are optional in version 1: a store without them is one
written before the watchlist became state, and the state of the watchlist is then still `watchlist.md`.

**`watchlist.md` is generated from the store** like `portfolio.md`: the same ` ```yaml ` block of the format below, with a note that
it is generated, overwritten at each change, never read as a source. The first `inbox:ingest` that finds a store without a
watchlist seeds it from `watchlist.md` (no file is an empty list; a file that cannot be read, a ticker that does not parse or
another `schema_version` stops the whole ingest, naming it; `inbox:check` goes on with an empty list). A ticker written twice
keeps its first entry, an entry whose `currency` is not EUR or USD is left out, a horizon that is not `short` or `medium` is
`medium`, and each is warned of. From then on **every reader reads the store**: the heartbeat (from the last readable copy when the store does not
read, as for the portfolio), the briefing, the screening and `pending:resolve`. The flows never edit it: the
screening and the Monday briefing drop their proposals in `inbox/` ([below](#watch-and-stop_watching)), and the watchlist
comes with the store into every retry of a lost [state write](glossary.md#compare-and-swap), which reads the store
again, so a retried `inbox:ingest` judges a batch against the watchlist the other run left.

A correction (`correct`) and the repair replay the batches in `inbox/applied/` over the silos **and the watchlist** the store began
with, so `watch` and `stop_watching` commands replay with the rest, and a retired entry of the seeded list stays retired. A
correction never changes the watchlist. The repair rebuilds it from `starting_watchlist` and the batches, reports a difference
with the store's like any other, and **never silently empties it**: when the batches changed the watchlist and neither the
store nor its last readable copy tells the list it began with, the repair refuses, changing nothing, and says so.

### The repair of a corrupt state

`npm run state:repair` is the [repair](glossary.md#repair) of `state/portfolio.json` (#139, ADR-0018). It does exactly one thing: it
rebuilds the store from the decision log and the batches in `inbox/applied/`, the audit trail, and **refuses, changing nothing, when
the two disagree, saying where**. The owner runs it on purpose, when the store does not read or is wrong; the engine never runs it by itself.

The steps are in [Repair the state](flows.md#repair-the-state).

**Every run writes a `repair` line to the decision log** per silo, a refusal and a run with nothing to repair included: the date, the
`result` (`rebuilt`, `unchanged` or `refused`) and the `differences` it found. Neither the batches nor a line of the log is ever edited. It
does not repair the watchlist or the configuration, and it does not delete history.

While `state/portfolio.json` does not read, the commands that need the state refuse it, but the [heartbeat](flows.md#heartbeat) does not stop (ADR-0015): it
watches the stops of `state/portfolio.last-readable.json`, a copy the engine writes with every write of the store (it is the last state that read, never a
bad one), and names the corruption in every digest until the file reads. Do not edit that copy either.

### Staleness

With the store, whether a silo is [stale](glossary.md#stale) comes from its latest `snapshot` (#138): the age of the day it
is as of, against `PORTFOLIO_STALE_DAYS` (default 7), measured from the start of that day. The engine warns once per stale silo on each read (`the EUR silo has no snapshot of the broker, so it is stale`)
and the [heartbeat](flows.md#heartbeat) digest names it. Seeding the store from a `portfolio.md` gives no snapshot, so a
silo made from a file with no `last_manual_sync` is stale instead of synced at the moment of the seeding. While there is
no store (the state is still `portfolio.md`) the `last_manual_sync` warning is the only one, until #143 removes that way.

## `telemetry/prices-<ccy>.json`

The last prices of a silo (#133): [telemetry](glossary.md#telemetry), written only by the engine's heartbeat and Monday briefing,
never by `inbox:ingest`, and **not state**: the store is not written when a price changes. **Do not edit it.** Commit `telemetry/`
with the rest of the data directory, so the generated `portfolio.md` keeps showing the last prices from one run to the next.
It is the one telemetry file the format versions; the sent-alert markers `logs/heartbeat-sent-<ccy>.json` are telemetry too.

```json
{
  "schema_version": 1,
  "silos": {
    "USD": { "TCK": { "price": "110.5", "volume": "2", "avg_price": "100" } }
  }
}
```

Each price carries the `volume` and `avg_price` of the position it was seen against, and every read of the portfolio puts it over
a position only while both still match: a buy, a sale or a split changes them, and the position then shows the price the state
holds until the next refresh. The P/L shown is `(price − avg_price) × volume`. Numbers are plain decimal text, tickers are in
order. The file is a silo's alone (`prices-eur.json`, `prices-usd.json`), so two heartbeats never write the same one. A file that
is missing, is not valid or has another `schema_version` is said and ignored, never a reason to stop a flow; the next refresh
writes it again. Nothing is written when no price changes.

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
  - command: convert
    amount: 500.00 EUR
    received: 580.00 USD
    costs: 2.50 EUR
  - command: split
    ticker: SAP.DE
    date: 2026-09-18
    ratio: 2 for 1
  - command: snapshot
    date: 2026-09-21
    cash: 1050.00 EUR
    positions:
      - ticker: SAP.DE
        units: 2
  - command: withdrawal
    amount: 200.00 EUR
  - command: watch
    currency: USD
    ticker: AMD
    note: Data-center share gains
  - command: stop_watching
    ticker: KO
    reason: thesis invalidated
```

`schema_version` is required and is `1`: a file without it, or with another version, is one error and is
not read further. The other top-level fields are `commands`, a list with at least one command, and
`replaces` (see _A rejected batch is never forgotten_, below). Every
value is read as text, never as a YAML number or date, so the rules below are the same for all of them.

An **amount** is a plain decimal number and its currency, separated by a space: `1000.50 EUR`. The number is
digits with an optional decimal point: no sign, no thousands separator, no comma as the decimal mark and no
exponent (`1e3`, `1,000.50`, `-5` and `.5` are errors). The currency is `EUR` or `USD`; an amount without a
currency, or with another one, is an error. Money amounts (`amount`, `costs`) have at most two decimals and are
greater than zero; prices (`price`) may have more decimals. The `units` are a plain decimal number
without a currency. A `date` is a calendar date, `YYYY-MM-DD`. A [ticker](glossary.md#ticker) follows the rule
under _Versioning_ above, as narrowed in #93: it is checked once, when the batch is read, and read
case-insensitively.

| Command         | Required fields                                                                 | Optional fields                          | What it checks and does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deposit`       | `amount`                                                                        |                                          | Adds to the cash of the amount's currency. **The first deposit of a currency creates its silo** (#196): with that cash, no positions and no lots, synced when the batch is applied and never compared with the broker (it is [stale](glossary.md#stale) until a `snapshot`), so a data repository starts from an empty folder and a deposit batch. Every other command on a currency with no silo is refused, saying to deposit first. Added without a migration, per [#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_ (#196).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `withdrawal`    | `amount`                                                                        |                                          | Refused if it exceeds the available cash of its currency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `convert`       | `amount`, and `received` or `rate`                                              | `costs`, `date`                          | Moves cash from one silo to the other in one step: `amount` (with its currency) leaves its silo, and what arrived reaches the other, so the two silos change together or the batch is refused. What arrived is `received` (an amount in the other currency) or `rate` (the other currency per unit of `amount`'s, a plain decimal number): `(amount - costs) × rate`, to the cent. Give one of the two, never both. `costs` are the fee, in the currency of `amount` and already inside it. Refused if both sides are the same currency, if `amount` or what arrived is not positive (below half a cent counts as nothing), if `costs` are not below `amount` (nothing would arrive), or if `amount` exceeds the available cash of its silo after the commands before it in the batch. It writes an `fx_conversion` line in the decision log (`date` or, without it, the day of the run), which the shadow portfolio replays. Added without a migration, per [#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_ (#135).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `buy`           | `ticker`, `date`, `units`, `price`                                              | `costs`                                  | Refused if `units × price + costs` exceeds the available cash of its currency. Also refused if it costs less than half a cent (it rounds to zero cents) or has fewer units than 1e-8. Opens a lot; buying a ticker already held is a scale-in. It has no `stop`: a batch that gives one is refused, with an error that names `set_stop`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sale`          | `ticker`, `date`, `units`, `price`                                              | `costs`, `lot`, `stop_executed`          | Refused if the ticker has no open lot, or fewer open units than sold, if its costs exceed its proceeds, or if its proceeds round to zero cents (under half a cent), unless it uses up every remaining unit of each lot it sells: that sale credits 0.00 and closes every lot it sells, which is how a dust lot is removed. Sells oldest lot first, or only the lot whose entry id is `lot`. `stop_executed: true` marks a stop the broker executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `set_stop`      | `ticker`, `price`                                                               | `date`                                   | Sets or moves the one stop of a position, in the currency of `price`. Refused if the ticker has no open position after the commands before it in the batch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `clear_stop`    | `ticker`                                                                        | `date`                                   | Removes the stop of a position; it has no amount, so it acts on every silo that holds the ticker with a [stop](glossary.md#stop) (the warning names them). Refused if the ticker has no open position or none has a stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `split`         | `ticker`, `date`, `ratio`                                                       |                                          | A [corporate action](glossary.md#corporate-action): a split or a reverse split of a ticker, in every silo that holds it, with no cash and no currency. `ratio` is `<new> for <old>`, two plain decimal numbers greater than zero: the units after the split for each unit before it (`4 for 1`; `1 for 10` is a reverse split; `3 for 2`). Every open lot of the ticker gets its `Units` and `Entry units` multiplied by new ÷ old and its entry price and initial stop divided by it, and so does the position (volume, average price, current price and stop); the amount invested, the entry costs, the P/L and R in cents do not change, and the lots keep their order, so the next sale is still first in, first out and a sale after the split sells the adjusted lots. `date` is the day the split took effect: it is refused if it is before the day the oldest open lot was bought, or before the day any open lot of the ticker was (a lot bought after the split is already at the new prices and is never scaled, so the command names it and is refused). Refused if the ticker has no open lot after the commands before it in the batch, if the ratio is 1 (`2 for 2`), and if units that are whole would stop being whole (a reverse split that leaves a fraction: sell the fraction first, the cash in lieu of it is settled with a sale); all or nothing across the silos. It writes a `split` line per silo in the decision log, with the ticker, the silo (`currency`), `split_ratio` (the units after the split per unit before it: `4`, `0.1`) and the date. Only a split is a command; a spin-off or a merger is not. Added without a migration, per [#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_ (#137).                                                                                                                                                                        |
| `snapshot`      | `date`, `cash`, `positions`                                                     |                                          | What the broker shows of one [silo](glossary.md#silo) on `date`: a [snapshot](glossary.md#snapshot). `cash` is the broker's available cash with its currency (`1050.00 EUR`, at most two decimals, zero allowed), which names the silo; `positions` is a list of `ticker` and `units` (a plain decimal number greater than zero), each ticker once, `[]` when the broker holds none (an empty value is an error). The engine compares it with the state the commands before it in the batch left: the cash to the cent, and the units of each ticker either side holds (a ticker the broker lacks is 0 units, one the engine lacks is 0), within the units tolerance. **It changes no cash, position, lot or stop**: it records on the silo the date and each difference (what the broker and the engine hold, and the size, the broker's less the engine's), `inbox:check` and `inbox:ingest` print each one as a warning (never an error: a difference is not a refused batch) and `inbox:ingest` writes a `reconcile` line of the decision log per difference (the ticker, or none for the cash; `broker`, `engine`, `difference`; the snapshot's `date`; none when the two agree). The owner corrects the state with a command. Refused if the silo does not exist, if `date` is in the future (of the day of the run), if a ticker is listed twice. A later snapshot replaces the earlier one (its differences, its `date` and the day it was recorded, `recorded_on` in the store), and the age of its `date` is what makes a silo [stale](glossary.md#stale) (see _Staleness_ below). It changes nothing the commands after it read, so one refused or unread leaves nothing unknown; it is itself not checked after a command that changed the cash or lots of its silo was refused, and after a split was. Added without a migration, per [#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_ (#138). |
| `correct`       | `id`, and at least one of `ticker`, `date`, `units`, `price`, `costs`, `amount` |                                          | Corrects a mistaken record: the buy (its `entry`), the sale (its `exit`), the deposit or the withdrawal that the engine gave `id` in the decision log, with the values it should have had; what is left out stays as it was. It goes **alone** in a batch of corrections, after the batches it corrects are applied (`inbox:ingest` first). The engine does not edit the state: it applies again, in order, the batches already in `inbox/applied/` with the corrected record, so every later command is judged against it, and the lots, cash, positions and [R](glossary.md#r) are rebuilt. It writes a `correction` line per line that changes (the record, and the lines of the sales that drew on a corrected lot); each points at the original with `corrects` and holds the fields that change in `patch`, and the original **stays in the log and in the history**: nothing is erased ([correction](glossary.md#correction)). The values go through the same validation as the original command. Refused, with a reason and a place, if the id is not a record of the log (or is a line a correction does not reach: a conversion, a split), if a value does not apply to that record (`units` on a deposit), if an amount is in another currency than the record (a correction does not move a record between silos), if the correction would leave a later sale without lots, a sale before its lot was bought, or cash below zero, or if it changes nothing. Like any batch, all or nothing: one refused correction rejects the whole file. Added without a migration, per [#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_ (#139).                                                                                                                                                                                                                                                              |
| `discard`       | `file`                                                                          |                                          | Gives up a [rejected batch](glossary.md#rejected-batch) for good (see _A rejected batch is never forgotten_, below). It changes no cash, lot or stop, so it has no currency. Refused if `file` is not a rejected batch awaiting an answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resolve`       | `id`, `outcome` (`resolved` or `discarded`)                                     | `note`, `date`                           | Closes a [pending escalation](glossary.md#pending-escalation) (see _A pending escalation is closed by a command_, below). It changes no cash, lot or stop, so it has no currency. Refused if `id` is not a pending escalation still open, if `date` is in the future or if `note` is longer than 500 characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `watch`         | `currency`, `ticker`                                                            | `note`, `date`, `horizon`, `asset_class` | Puts a ticker on the [watchlist](glossary.md#watchlist) of the silo `currency`: `note` is why (kept as the entry's thesis), `date` the day it joins (the day of the run by default), `horizon` is `short` or `medium` (default `medium`) and `asset_class` `equity`, `commodity` or `etf`. Refused if the ticker is on the list already, in either silo. It changes no cash, lot or stop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `stop_watching` | `ticker`                                                                        | `reason`                                 | Takes a ticker off the watchlist. Refused if it is not on it. A position it holds stays under risk watch: the watchlist is not what the heartbeat watches stops for. `reason` is for the batch, which stays in `inbox/applied/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

<a id="watch-and-stop_watching"></a>

**`watch` and `stop_watching` are the only way the watchlist changes** (#140). The commands are checked in order like the others,
each against the watchlist the ones before it left, so a `watch` and the `buy` of its ticker in one batch are valid, and the
`not_in_watchlist` rule of the buy reads that list (the silo of the buy, so the ticker watched in the other silo does not
count). They read and change neither cash, nor lots, nor stops, so no refusal of a cash or lot command makes them "not
checked", and a refused `watch` leaves nothing unknown. The weekly screening proposes who joins and who leaves
by dropping a `watch` batch per candidate (`<date>-screening-watch-<ticker>.yaml`) and one batch of `stop_watching`
(`<date>-screening-exits.yaml`) in `inbox/`, and the Monday briefing a `stop_watching` batch
(`<date>-briefing-retire.yaml`) for the tickers it retires that are on the list; none of them edits `watchlist.md` or the store, and a file of that
name already in `inbox/` is left as it is. `inbox:ingest` applies them like the owner's batches (the screening's own push starts no
workflow, so the daily run of the inbox workflow does), and a rejected one is named in the digest. The theses
(`tesis/`) stay hand-editable text: a flow that retires a ticker still archives its thesis when it proposes it.

**The engine drops batches too ([#136](https://github.com/alvaromongon/finance-agent/issues/136)).** The stops it
proposes (`ADJUST_STOP` from the heartbeat, `pending:resolve` and the Monday briefing) are dropped as a new file,
`<date>-heartbeat-<ccy>-stops.yaml`, `<date>-pending-stops.yaml` or `<date>-monday-briefing-stops.yaml` (`-2`, `-3`
when the name is taken), holding one `set_stop` per proposal, the ticker quoted and the price a plain decimal with its
currency, under two comment lines that say who wrote it. It is an ordinary batch: `inbox:check` and `inbox:ingest`
read it with the rules of this section, and a file the engine dropped that is refused (a position sold meanwhile) is a
[rejected batch](glossary.md#rejected-batch) like any other. A proposal whose ticker, currency and price match a
`set_stop` already waiting in any file of `inbox/` is not dropped again. The engine never edits a batch, its own
included, and the format itself does not change: it is a new writer of an existing command, so there is no
`schema_version` bump and no migration (approved by the owner on 2026-11-26 in #136, spec #124 › _Decisions_).

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
lot's `Entry id` as its id, and an `exit` per lot a sale touched. A buy that follows a proposal of the system
(the latest `buy_proposal` or `setup_armed` of its ticker within 10 days that no trade cited yet; or one it blocked,
`buy_blocked`) cites it as `related_id`; the entry and its lot are `sistema` unless the proposal was a block, and a sale
that follows a `sell` proposal is logged as `sistema` too, so the trade stays in the system's expectancy
([ADR-0009 §8](decisions/0009-swing-framework-risk-sizing-and-measurement.md)). The rules an entry broke go in `Rules
violations`, as flags and never refusals: `not_in_watchlist` (the ticker is not in the watchlist of its silo),
`entry_without_setup` (no proposal with a setup precedes it, [ADR-0013 §4](decisions/0013-entry-setups.md)), `overrode_block`,
and `no_stop` or `stop_below_min_atr` (the initial stop is closer than `STOP_MIN_ATR` ATRs, judged when the ATR is
available) once the batch has set the stop. Since #152 the inbox is the only way a trade is
recorded, and these lines are telemetry: the state is what the batch changed. A sale whose proceeds round to 0.00 (it
must use up every lot it touches) credits 0.00 and records the exact amounts of its exits (their sum is the exact
proceeds, not the cash credited); an exit whose share of the proceeds is 0 is recorded with an `amount` of 0, the
one amount of 0 the decision log accepts, so the lot is closed in the log as in the state and no entry stays open
in it. Cash flows and `set_stop` are not written to the decision log. **The every-lot rule of that sale lives
only in the inbox's `sale` handler**, which is the one caller of the lot arithmetic (`planSale`): no other flow
accepts a sale, so no flow accepts a buy of less than half a cent, or a sale of that size that does not close
every lot it touches ([ADR-0017](decisions/0017-money-is-a-domain-value-in-whole-cents.md)).

**A rejected batch is never forgotten.** `inbox:ingest` moves a refused batch to `inbox/rejected/` and applies nothing
of it. The file stays there as the audit trail, is never retried automatically (only the files directly in `inbox/`
are read) and is named in every digest of the heartbeat, and by `inbox:check`, until it is answered, in either way:

- a later batch that starts with `replaces: <file>` (the name in `inbox/rejected/`, as the digest and the errors name
  it) and is applied settles it as replaced; or
- a `discard` command with `file: <file>` in a batch that is applied settles it as discarded.

```yaml
schema_version: 1
replaces: 2026-11-12.yaml # the rejected batch this one corrects
commands:
  - command: deposit
    amount: 1000.00 EUR
  - command: discard # gives up another rejected batch for good
    file: 2026-11-10.yaml
```

A batch that names a file that is not awaiting (it does not exist, or was settled already, or the same batch replaces
and discards it) is refused: the `replaces:` as an error of the file, at its line, and the `discard` as an error of its
command; neither blocks the other commands of the batch, since neither changes cash, lots or stops. A replacement that is
itself refused settles nothing. A batch that depends on a rejected one fails its own validation, as it always did: it is
checked against the state without it, so a sale of what the rejected batch would have bought has no lot to sell. The
store remembers what was settled with the hash of the file, so a file later moved to `rejected/` under a name that
was settled (the old one deleted by hand) awaits an answer again. `replaces:` and `discard` are new, so the format ships
without a migration: approved by the owner on 2026-11-05 for agent work (spec
[#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_, issue
[#152](https://github.com/alvaromongon/finance-agent/issues/152)).

**A pending escalation is closed by a command.** A signal the engine escalated in `handoff` mode is a file in
`logs/pending/` (`<date>-<ticker>.md`); its **id** is the file name without `.md` (`2026-11-20-xom`). It is open until
a `resolve` command closes it, in a batch that is applied, as `resolved` (it was answered) or `discarded` (it is given up
unanswered); until then it is named in every digest of the heartbeat and by `inbox:check`. `pending:resolve` no longer
exists: the command is the only way to change the list, and `pending:record` (see the README) only records the reasoner's
answer in the decision log and the outbox, it closes nothing.

```yaml
schema_version: 1
commands:
  - command: resolve
    id: 2026-11-20-xom
    outcome: resolved # or discarded
    note: bought half, the rest on the next pullback # optional, at most 500 characters
    date: 2026-11-21 # optional: the day it was closed, today by default, never in the future
```

An `id` that does not exist in `logs/pending/` or is already closed (by an earlier run, an earlier file of the run or
an earlier command of the same batch) is refused as an error of its command, which blocks no other command. A refused
batch closes nothing. The file stays in `logs/pending/` as the record: the store remembers what was closed
(`closed_escalations`: the `id`, the `sha256` of the file, the `outcome`, the optional `note`, the `date`, the batch
that closed it as `by`, and `at`), so a new signal written later under the same name (another text) is open again.
`resolve` is a new command, so the format ships without a migration: approved by the owner on 2026-11-26 for agent work
(spec [#124](https://github.com/alvaromongon/finance-agent/issues/124) › _Decisions_, issue
[#141](https://github.com/alvaromongon/finance-agent/issues/141)).

**The folder is not trusted.** A batch must be a regular file: a symbolic link (or a folder or named pipe with a batch's
name) is never followed or read, and is reported, by `check` and `ingest`, as an error that names it; `ingest` leaves
it in `inbox/` and still applies the others (a later file that could depend on it is listed as not checked, like one
that depends on a rejected file). A hidden file (a name that starts with `.`, such as the `._buy.yaml` macOS writes
beside a file copied to another volume) is reported the same way and left where it is. A symbolic link as `inbox/` itself, or as `inbox/applied/` or `inbox/rejected/`, is
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

The [watchlist](glossary.md#watchlist): assets the heartbeat scans for entry setups, in the first ` ```yaml ` block. The file starts
with the frontmatter (`schema_version: 1`).

**It is the starting point and then a view** (#140, ADR-0018). Until an `inbox:ingest` has seeded the
[store](#the-watchlist-in-the-store) from it, this file is the state, as before. From then on the engine generates it from the
store each time the store changes, overwriting what is there, and nothing reads it: the watchlist changes with the `watch` and
`stop_watching` commands of a batch ([below](#watch-and-stop_watching)). The change ships without a migration and without bumping
`schema_version`, approved by the owner on 2026-11-26 in
[#140](https://github.com/alvaromongon/finance-agent/issues/140) (spec
[#124](https://github.com/alvaromongon/finance-agent/issues/124)); it ships like the rest of the inbox format, as an exception to the rule that an
incompatible change ships with a migration.

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

The generated file has the same fields, less `name` and `market` for an entry made by a `watch` command (which carries neither), with the
entry's `date`, the day it joined the list, in place of the thesis note's `created`.

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

| Frontmatter field | Meaning                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`  | `1`                                                                                                                                                                                                  |
| `status`          | `active` or `archived`: set by the flow that proposes the asset's retirement from the watchlist; it copies whether the ticker is on it (a follow-up of #140 proposes deriving it from the watchlist) |
| `created`         | Creation date                                                                                                                                                                                        |
| `exit_criteria`   | `pending` while the invalidation criteria are missing; the screening reminds you until you fill them in and remove the field                                                                         |

## Configuration files

The files that configure the engine, kept by hand in the data directory (spec #124, ADR-0018, #142):

| File                             | What it is                                                   | Required | A run that reads it                   |
| -------------------------------- | ------------------------------------------------------------ | -------- | ------------------------------------- |
| `strategies/base.md`             | The strategy: its frontmatter `version` is the rules version | yes      | heartbeat, inbox, briefing, screening |
| `portfolio-policy.md`            | Free text the briefing respects                              | no       | briefing                              |
| `screening-universe.md`          | The screening universe ([format](#screening-universemd))     | yes      | screening                             |
| `routines/monday-briefing.md`    | The briefing's prompt                                        | yes      | briefing                              |
| `routines/weekly-screening.md`   | The screening's prompt                                       | yes      | screening                             |
| `routines/execution-analysis.md` | The reasoner's instructions for a signal                     | yes      | heartbeat                             |

**Validated when read, fail-fast.** Each run validates the files it reads, with every error (file, field, reason) and not just the first:

- `strategies/base.md`: starts with a `---` block that is valid YAML and has a `version` that is a number or a non-empty string.
- `screening-universe.md`: `schema_version` 1, a ` ```yaml ` block that is valid YAML with `universe:` and `eur` and `usd` as lists (`commodities`, if present, a list too). An entry whose ticker does not parse is still skipped with a warning (ADR-0016), not an error of the file.
- `portfolio-policy.md` and the prompts: not empty. A file that exists and says nothing is an accident, not a policy; to have no policy, delete the file. A prompt cannot be absent.

**The last valid configuration.** A file that validates is copied by the engine, byte for byte, to `state/config/<file>` (for example `state/config/strategies/base.md`): written only by the engine, committed with the state, so it survives a fresh CI checkout. Do not edit it; a copy that does not validate is ignored. A file that does not validate is **refused**: the engine runs on the copy, and every [heartbeat](flows.md#heartbeat) digest and the [Monday briefing](flows.md#monday-briefing) email warn with the errors until the first run after a valid edit. With no copy yet (the first run) the run that needs the file refuses with the errors; the heartbeat has already checked every stop and sent its digest by then ([flow](flows.md#heartbeat), step 2'-c). A file that is optional and absent is no file: its copy is deleted. The terms are in the [glossary](glossary.md#last-valid-configuration).

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
