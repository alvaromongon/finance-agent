# Portfolio sync (example)

How you keep the engine's portfolio in step with your broker and tell the engine what you did. The engine
integrates with no broker: it cannot know that an order filled or a stop was hit, so it warns
(an account "has no snapshot of the broker", or its latest snapshot is N days old) when the last time you compared it with
your broker is older than `PORTFOLIO_STALE_DAYS`, and the heartbeat digest names it. This guide is what that
warning points to. You can follow it by hand, or
hand it to a Claude Code session as its instructions. The file format is
[`docs/input-format.md`](https://github.com/alvaromongon/finance-agent/blob/main/docs/input-format.md#portfoliomd).

## Before you start: the store

The first `npm run inbox:ingest` makes the engine's own store (`state/portfolio.json`), from a `deposit` batch (the first
deposit of a currency creates its [silo](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#silo): `inbox/2026-09-01-start.yaml` of this example) or from an old `portfolio.md`, which must
read whole (a row that does not read is refused, not dropped). From then on **`portfolio.md` is a view the engine
generates, overwritten at every change: never edit it**, not its cash, not `last_manual_sync`, not a stop, not
`Lots`. Everything below changes the store. An account is **stale** until you send a `snapshot` of it, and again when its
latest one is older than `PORTFOLIO_STALE_DAYS`: trades and deposits do not make it fresh, only comparing it with your
broker does.

## The rule: two doors

Every event at the broker is told to the engine through one of two doors, and no event goes through both.

| Event                                      | Door                                                                                           | The engine writes                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Buy, sale, a stop set, moved or removed, a currency conversion, a split | a batch in `inbox/` (`buy`, `sale`, `set_stop`, `clear_stop`, `convert`, `split`), checked and applied as a whole | the store (cash, positions, [lots](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#lot)) and the entry and exit lines of the log |
| Deposit, withdrawal                        | `npm run decision:record`, the event as JSON on stdin                                          | the [decision log](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#decision-log) (`logs/decisions.jsonl`; never edit it by hand) and the cash of the store |
| A stop adjustment you made after a proposal | `npm run decision:record` for the log line, and a `set_stop` command in a batch for the stop    | the log line only                                                                      |
| What your broker shows today (cash and positions of an account) | a `snapshot` command in a batch                                                  | no state: the differences with the engine's, and the date that makes the account fresh     |

`decision:record` refuses a buy and a sale: they are told with a `buy` or a `sale` command in a batch, the only way a
trade is recorded; it refuses a currency [conversion](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#conversion) too, which is the `convert` command of a batch. The `convert` command writes its `fx_conversion` line; the `deposit` and `withdrawal` commands of the inbox change the cash and write no log line, while a flow
told to `decision:record` writes its line, which the
[shadow portfolio](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#shadow-portfolio) needs to
buy its benchmark with every flow on its own date. Use one door for a flow, never both: the cash would move twice.

So you never edit position rows. What you do is **reconcile**: after the events, send a `snapshot` of each account with the
cash and the units of each position your broker shows. The engine compares it with its own state and tells each
difference (a split, a partial fill, a trade you never recorded) without changing anything: it is in the output of
`inbox:check` and `inbox:ingest`, in the decision log (a `reconcile` line each) and in every digest until a later
snapshot shows none. Then tell the engine what it missed in a batch (a `split` command for a split, the missing trade
otherwise), so that the `Units` of a ticker's lots add up to the broker's figure, and send a new snapshot.

The engine rebuilds each [silo](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#silo)'s
value backwards from today's portfolio through the logged events, to compare you with the shadow portfolio.
If the two disagree (a trade in the log that the portfolio does not show, or the other way
round), the evaluation warns about negative cash or oversold units instead of reporting a wrong
number.

The engine fills in the rest of what it writes: id, [rules version](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#rules-version), [benchmark price](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#benchmark)
and, for an adjustment, the system proposal it follows (that sets its `origin`). Omit `date` for today; give it
(`YYYY-MM-DD`) when you record something that happened earlier.

## Order that keeps the P&L right

Order the events by date; within a date, flows first. Process them in that order, and commit the
log and `state/` together.

1. **Money in or out, and currency conversions, first within their date.** Later buys are funded by them, and the
   shadow portfolio buys its benchmark with every flow on its own date, so a wrong or missing date
   shifts the comparison. `decision:record` refuses a flow that would take the cash of a silo below zero, as the
   inbox does.
2. **Buys and sales, in the order they happened**, in a batch: the commands of a batch are checked in order against
   the state the previous ones produce, so a buy and its sale in one batch are valid. A sale takes the result from the
   lots' own entry prices, oldest lot first. A sale dated before a lot it would consume is refused. The order does
   matter between trades of the same ticker: the log has no time of day, so the order of the commands is the order of
   two trades on the same date. For a sale followed by a buy-back of the same ticker on the same day, put the sale
   first: the other way round, a sale larger than your older lots would consume the lot you have just bought.
3. **A stop change:** a `set_stop` in the batch, after the buy it protects.
4. **Check, then apply:** `npm run inbox:check` says what `npm run inbox:ingest` would do, with the same code and
   nothing written. Ingest applies each batch whole or not at all.
5. **Reconcile** with a `snapshot` of each silo, last in the batch (it is compared with the state the commands before it
   leave), and read the differences it reports. If the cash differs, find the trade, deposit or withdrawal you did not
   tell it, and tell it with a command.

## Buys, sales and stops: the inbox

A batch is a YAML file dropped in `inbox/` (format in
[`docs/input-format.md`](https://github.com/alvaromongon/finance-agent/blob/main/docs/input-format.md#inboxyaml)).
A buy carries no stop: set it with a `set_stop` after the buy, and it is the initial stop of the lot, the base every
[R](https://github.com/alvaromongon/finance-agent/blob/main/docs/glossary.md#r) is measured against. A buy of a held
ticker is a new lot, a trade of its own: its R is measured from its own price and initial stop, and the first lot is not
touched.

```yaml
schema_version: 1
commands:
  - command: buy
    ticker: KO
    date: 2026-10-12
    units: 5
    price: 62 USD
    costs: 1.50 USD
  - command: set_stop
    ticker: KO
    price: 58 USD
  - command: sale
    ticker: SAP.DE
    date: 2026-10-12
    units: 2
    price: 195 EUR
    costs: 1.50 EUR
```

The inbox writes the rule `no_stop` into a lot that ends the batch with no stop, and warns about every position a batch
leaves without one: risk watch cannot protect it. A stop your broker executed is a sale: tell it with a `sale` command
at the fill price and `stop_executed: true`.

A refused batch is moved to `inbox/rejected/` with its errors beside it and applies nothing. It is never retried, and
the heartbeat names it in every digest until you answer it: write a new batch that starts with `replaces: <file>`, or
give it up with a `discard` command (`file: <file>`). The file stays in `rejected/` as the audit trail.

A currency conversion is a `convert` command: `amount` is what you converted, with its currency, which is the silo the
money **leaves**. Say what arrived (`received`, in the other currency) or the rate you got (`rate`: the other currency
per unit of the first, before the fee), not both. `costs` is the fee, in the currency of `amount`, and is already inside
it. The command takes the amount from the source silo and gives the other what arrived, both or neither; it is
refused if the costs are not below the amount or if the source silo lacks the cash after the commands before it, so
put it before the buys that spend the converted cash.

A split or a reverse split of a ticker you hold is a `split` command: `ratio` is `<new> for <old>`, the units after the
split for each unit before it (`4 for 1`; `1 for 10` for a reverse split), and `date` is the day it took effect. It
scales every open lot of the ticker, and its position, in every silo that holds it: units multiplied, entry price and
stop divided, so what you invested and your R do not change. Send it once, after the last trade you made before the
split and before any sale after it (a sale after the split is told in the new units, at the new price). It is refused
if a lot of the ticker was bought after `date`, and if a reverse split would leave a fraction of a unit: sell the
fraction first, which is how the cash in lieu is settled.

```yaml
schema_version: 1
commands:
  - command: split
    ticker: NVDA
    date: 2026-06-10
    ratio: 10 for 1
  - command: sale
    ticker: NVDA
    date: 2026-06-12
    units: 20
    price: 120 USD
```

Reconciling with the broker is a `snapshot` command: `date` is the day your broker's figures are as of (not in the
future), `cash` is its available cash with the currency, which names the silo, and `positions` lists every position it
holds as a ticker and its units (`positions: []` when it holds none). Send one per silo, last in the batch, so it is
compared with the state the trades before it leave. The engine reports each difference in the cash and in the units of a
ticker, and records them; it never applies the broker's figures for you, because that would hide a trade you missed or
entered wrongly. A later snapshot of the silo replaces the differences of the earlier one, and one dated before the
silo's latest is refused.

```yaml
schema_version: 1
commands:
  - command: sale
    ticker: SAP.DE
    date: 2026-10-12
    units: 2
    price: 195 EUR
  - command: snapshot
    date: 2026-10-12
    cash: 1389.00 EUR
    positions:
      - ticker: SAP.DE
        units: 1
```

```yaml
schema_version: 1
commands:
  - command: convert
    amount: 1000 EUR
    received: 1160 USD
    costs: 5 EUR
  - command: buy
    ticker: KO
    date: 2026-10-12
    units: 18
    price: 62 USD
```

## Events for `decision:record`

All examples run as `echo '<json>' | npm run decision:record`, or with the JSON in a file piped in.
`currency` is the silo (`EUR` or `USD`). Numbers are plain (`1234.56`), not localized. Each command prints what it
recorded; read that line, it is the engine's feedback.

### Deposit or withdrawal

Money you moved between your bank and the broker. The command moves the cash of the store.

```json
{ "type": "deposit", "currency": "EUR", "amount": 500, "date": "2026-10-12" }
```

```json
{ "type": "withdrawal", "currency": "USD", "amount": 200 }
```

### Stop change

`stop` is the new level. Record it for the log line, then move the stop itself with a `set_stop` command in a batch:
this event changes no state. It is attributed to the system when it follows one of its `adjust_stop` proposals; set
`origin` to `sistema` only when the engine cannot infer that you followed it.

```json
{ "type": "adjust_stop", "ticker": "KO", "currency": "USD", "stop": 60 }
```

## Checking your work

- `npm run decisions:evaluate` rewrites `logs/decisions-evaluation.md`; a silo that does not
  reconcile shows a warning there.
- A mistake in the log is fixed in a dedicated commit that edits that one line, when no automated
  run is in flight. A mistake in the portfolio is told to the engine in a batch, so the history shows what you changed
  and why.

Old logs and queue files are covered in [Log retention](https://github.com/alvaromongon/finance-agent/blob/main/docs/log-retention.md).
