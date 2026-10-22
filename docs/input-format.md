# Input format

The engine reads its state from Markdown files in the project directory
(`VAULT_PROJECT_DIR`). This document is the contract for those files: their
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

| File                                   | Versioned                  | Version | Parsed parts                                                    |
| -------------------------------------- | -------------------------- | ------- | --------------------------------------------------------------- |
| `portfolio.md`                         | yes                        | **2**   | Frontmatter, `Cash`, `Positions` and `Lots` tables per currency |
| `watchlist.md`                         | yes                        | 1       | First ` ```yaml ` block                                         |
| `screening-universe.md`                | yes                        | 1       | Frontmatter, first ` ```yaml ` block                            |
| `screening-log.md`                     | yes                        | 1       | The table                                                       |
| `tesis/tesis-<slug>.md`                | yes                        | 1       | Frontmatter                                                     |
| `logs/<YYYY-MM-DD>-<ticker>.md`        | no (written by the engine) | -       | Frontmatter                                                     |
| `strategies/base.md`                   | no                         | -       | Frontmatter `version` (rules version) and text                  |
| `portfolio-policy.md`, `routines/*.md` | no                         | -       | Text only, passed to the reasoning model                        |

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

Numbers in tables accept European (`1.234,56 €`) or US (`$1,234.56`)
notation. `—`, `-` or `TBD` mean "no value".

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

Rows whose ticker is empty or `—`, or whose `Volume` or `Avg price` is not a
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

The `exit` lines `decision:record` writes for a sale carry, per lot, an `amount`
that is that exit's exact share of the sale amount and can have sub-cent
decimals (owner decision of 2026-10-22 in #27). When the owner gives only the
units, the sale amount derived (`units × price`) is to the cent unless that
rounds to 0.00, and then it is exact.

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

Rows without an `Entry id` or a `Ticker`, or whose `Units`, `Entry units` or
`Entry price` is not a number, or whose `Origin` is not one of the two values,
are skipped, so they do not count towards their position's `Volume` and the
check below reports them. When `decision:record` rewrites the table it keeps
such a row where it is.

`decision:record` also keeps `Positions`: the first entry of a ticker creates
its row, with the lot's initial stop as `Stop loss` (`—` if there was none);
later entries and sales only change `Volume` and `Avg price` (the units-weighted
entry price of the open lots), and the row is deleted when the last lot is
consumed. Recording a trade needs `portfolio.md`; without it an entry or a sale
is refused.

The lots must add up to the positions and agree with the decision log
(`logs/decisions.jsonl` and any archived quarter). A silo is **inconsistent**
when:

- a position's `Volume` is not the sum of the `Units` of its lots (a position
  with no lots, or lots of a ticker with no position row, count too);
- a lot has more `Units` than `Entry units`, or an `Entry id` is on two rows;
- a lot's `Entry id` is not an `entry` of that currency in the decision log, its
  `Ticker` is not the ticker of that entry, or its entry price, entry units,
  initial stop, date, origin, rules version or rules violations differ from the
  entry's; or
- an entry in the decision log is still open and has no lot. An entry is open
  until an exit that cites it has `lot_units_left` 0. An entry whose log line has
  no `units` was recorded before the lots existed and is not checked
  (`decision:record` writes `units` on every entry).

Where portfolio and log are both read, `decision:record` and
`decisions:evaluate` refuse an inconsistent silo with an error naming the ticker
and the entry id; fix `Lots` by hand. The heartbeat does not read the decision
log: it only checks `Volume` against the lots, and it does not refuse the file
either. It keeps watching the positions (stops, `Volume`, `Avg price`) and raises
a warning in its output and in the digest, because a typo must not switch off
the stop alerts.

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
