# Input format — version 1

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

The engine refuses a file without `schema_version` or with a version it does
not know, naming the file in the error, instead of reading it partially. An
incompatible change to this format bumps the version and ships with a
migration script.

| File                                   | Versioned                  | Parsed parts                                            |
| -------------------------------------- | -------------------------- | ------------------------------------------------------- |
| `portfolio.md`                         | yes                        | Frontmatter, `Cash` and `Positions` tables per currency |
| `watchlist.md`                         | yes                        | First ` ```yaml ` block                                 |
| `screening-universe.md`                | yes                        | Frontmatter, first ` ```yaml ` block                    |
| `screening-log.md`                     | yes                        | The table                                               |
| `tesis/tesis-<slug>.md`                | yes                        | Frontmatter                                             |
| `logs/<YYYY-MM-DD>-<ticker>.md`        | no (written by the engine) | Frontmatter                                             |
| `strategies/base.md`                   | no                         | Frontmatter `version` (rules version) and text          |
| `portfolio-policy.md`, `routines/*.md` | no                         | Text only, passed to the reasoning model                |

Files that are only passed to the model as text are not parsed, so they carry
no `schema_version`. `version` in `strategies/base.md` is the version of the
trading rules, not of this format.

Numbers in tables accept European (`1.234,56 €`) or US (`$1,234.56`)
notation. `—`, `-` or `TBD` mean "no value".

## `portfolio.md`

Synced by hand from the broker. One `Cash` and one `Positions` section per
currency (`EUR`, `USD`), with an em dash, en dash or hyphen between currency
and section name. A section ends at the next `##` heading or `---` rule.

```markdown
---
schema_version: 1
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
```

Frontmatter:

| Field              | Required | Meaning                                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `schema_version`   | yes      | `1`                                                                                           |
| `last_manual_sync` | no       | ISO timestamp of the last sync; the engine warns when it is older than `PORTFOLIO_STALE_DAYS` |
| `account_env`      | no       | `demo` or `real`; recorded with each decision                                                 |

Both sections are required for each currency; a missing one is an error
rather than an empty silo. Cash rows, matched by the first cell
(case-insensitive); other rows are ignored:

| Row              | Required                  | Meaning                                                                                                |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Available cash` | yes (missing row → error) | Cash free to trade today. Not a number (`TBD`, `—`) → 0                                                |
| `Total cash`     | no                        | Account cash including what pending orders hold; used for the silo value. Defaults to `Available cash` |

Positions table: the first row is the header and columns are read **by
name** (case-insensitive), in any order. All six are required; a missing one
is an error. Extra columns are ignored.

| Column          | Meaning                                   |
| --------------- | ----------------------------------------- |
| `Ticker`        | Yahoo Finance symbol                      |
| `Volume`        | Units held; fractions allowed             |
| `Avg price`     | Average entry price                       |
| `Current price` | Rewritten by the engine on each heartbeat |
| `P/L`           | Rewritten by the engine on each heartbeat |
| `Stop loss`     | Active stop, or `—`                       |

Rows whose ticker is empty or `—`, or whose `Volume` or `Avg price` is not a
number, are skipped.

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
